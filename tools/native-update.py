#!/usr/bin/env python3
"""Stage, validate and promote an isolated upstream/native-browser candidate.

Nothing in a sibling checkout is read or written. Stage and validate never
replace the stable source. Promotion is explicit and requires a candidate-bound
real-engine runtime receipt in addition to the automatic gates.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse
import uuid

SPEC = importlib.util.spec_from_file_location("native_source", Path(__file__).with_name("native-source.py"))
SOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE)
ROOT = Path(__file__).resolve().parents[1]
LOCK_PATHS = ("native-source.lock.json", SOURCE.PATCH_PATH, SOURCE.PATCH_LOCK_PATH)
REQUIRED_RUNTIME_CHECKS = ("sameCandidateNativeWasmReplay", "twoClientChecksums", "latencyTps", "finishAndReentry")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def digest(value):
    return SOURCE.sha256(encoded(value))


def stamp():
    return datetime.now(timezone.utc).isoformat()


def git(repo, *args, input=None, allowed=(0,)):
    result = subprocess.run(["git", "--no-optional-locks", "-c", "core.autocrlf=false", "-c",
                             "core.filemode=true", "-c", "user.name=Native Update", "-c",
                             "user.email=native-update@example.invalid", "-C", str(repo), *args],
                            input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=SOURCE.isolated_environment())
    if result.returncode not in allowed:
        raise RuntimeError(f"git {args[0]} failed: " + result.stderr.decode(errors="replace").strip())
    return result


def retention_ref(kind, revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise RuntimeError("retained revision must be a full commit ID")
    return f"refs/native-update/{kind}/{revision}"


def pin(repo, kind, revision):
    """Keep source commits reachable; reflogs/FETCH_HEAD are not retention."""
    ref = retention_ref(kind, revision)
    existing = git(repo, "rev-parse", "--verify", "--quiet", ref, allowed=(0, 1)).stdout.decode().strip()
    if existing and existing != revision:
        raise RuntimeError(f"retention ref differs from its pinned commit: {ref}")
    git(repo, "update-ref", ref, revision, existing or "0" * 40)
    return ref


def export_tree(repo, revision, destination):
    entries = SOURCE.tree(repo, revision)
    destination.mkdir(parents=True)

    def sink(name, entry):
        def write():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("wb") as stream:
                while (chunk := (yield)) is not None:
                    stream.write(chunk)
            path.chmod(0o755 if entry["mode"] == "100755" else 0o644)
        generator = write()
        next(generator)
        return generator

    SOURCE.read_blobs(repo, entries, sink)


class NativeUpdate:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.source = SOURCE.NativeSource(self.root)
        self.home = self.root / ".build/native-updates"
        for path in (self.root / ".build", self.home):
            if path.is_symlink():
                raise RuntimeError(f"refusing symlink update directory: {path}")
        self.home.mkdir(parents=True, exist_ok=True)

    @contextlib.contextmanager
    def exclusive(self):
        with (self.home / "operation.lock").open("a+b") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("another native update operation is running") from None
            pending = [p for p in self.home.glob("*/promotion.json")
                       if json.loads(p.read_text()).get("state") == "pending"]
            if pending:
                raise RuntimeError("interrupted promotion exists; run recover with candidate " + pending[0].parent.name)
            yield

    def candidate(self, name):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{5,79}", name):
            raise RuntimeError("invalid candidate ID")
        path = self.home / name
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError("candidate does not exist in owned update directory")
        return path

    def clean(self):
        git(self.root, "diff", "--quiet")
        git(self.root, "diff", "--cached", "--quiet")
        untracked = git(self.root, "ls-files", "--others", "--exclude-standard", "-z").stdout
        if untracked:
            raise RuntimeError("untracked project edits must be committed before staging/promoting an update")

    def host_files(self):
        paths = git(self.root, "ls-files", "-z").stdout.split(b"\0")
        result = {}
        for raw in paths:
            if not raw:
                continue
            name = SOURCE.safe_name(raw.decode())
            if name.startswith(("native-client/", "vendor/")) or name in LOCK_PATHS:
                continue
            path = self.root / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"unsupported host snapshot entry: {name}")
            result[name] = SOURCE.file_sha(path)
        return result

    def stable_identity(self):
        self.source.check()
        return {"locks": {name: SOURCE.file_sha(self.root / name) for name in LOCK_PATHS},
                "source": digest(SOURCE.inventory(self.source.output)), "host": digest(self.host_files())}

    def verify_stable(self, manifest):
        if self.stable_identity() != manifest["stableIdentity"]:
            raise RuntimeError("stable source, locks or host code changed after staging; stage a new candidate")

    @staticmethod
    def merge(repo, left, right, label, directory):
        result = git(repo, "merge-tree", "--write-tree", "--messages", left, right, allowed=(0, 1))
        report = result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace")
        SOURCE.atomic_write(directory / f"{label}-merge.txt", report.encode())
        if result.returncode:
            raise RuntimeError(f"{label} merge conflicts; stable source untouched; inspect {directory / (label + '-merge.txt')}")
        tree = report.splitlines()[0]
        if not re.fullmatch(r"[a-f0-9]{40}", tree):
            raise RuntimeError(f"invalid {label} merge tree")
        return tree

    def stage(self, source_name, ref, remote=None, prepared_revision=None):
        """prepared_revision is used by mini-Git tests; the CLI always fetches."""
        self.clean()
        self.source.verify_baseline()
        # Candidate repositories borrow these objects through alternates. A
        # candidate's refs do not protect objects from GC in the source mirror.
        pin(self.source.repo, "baselines", self.source.revision)
        stable = self.stable_identity()
        if source_name not in {"upstream", "origin"}:
            raise RuntimeError("update source must be upstream or origin")
        pinned = self.source.lock.get(source_name, {})
        old_remote_revision = pinned.get("revision")
        if not re.fullmatch(r"[a-f0-9]{40}", old_remote_revision or ""):
            raise RuntimeError(f"missing pinned {source_name} revision")
        if not ref or ref.startswith("-") or any(c.isspace() for c in ref):
            raise RuntimeError("supply an explicit safe source ref")
        identifier = "candidate-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        directory = self.home / identifier
        directory.mkdir()
        project = directory / "project"
        project.mkdir()
        repository = project / ".build/vera-upstream"
        repository.mkdir(parents=True)
        git(repository, "init", "--quiet")
        (repository / ".git/objects/info/alternates").write_text(str(self.source.objects) + "\n")
        url = remote or pinned.get("url")
        if prepared_revision is None:
            parsed = urlparse(url or "")
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise RuntimeError("remote must be an explicit HTTPS Git URL without embedded credentials")
            git(repository, "fetch", "--no-tags", "--no-write-fetch-head", url,
                f"{ref}:refs/native-update/source")
            new_revision = git(repository, "rev-parse", "refs/native-update/source^{commit}").stdout.decode().strip()
        else:
            new_revision = git(repository, "rev-parse", prepared_revision + "^{commit}").stdout.decode().strip()
        # Merging into the integrated tree preserves existing local and fork
        # customisations. Never replace it with a bare upstream export.
        git(repository, "merge-base", "--is-ancestor", old_remote_revision, self.source.revision)
        git(repository, "merge-base", "--is-ancestor", old_remote_revision, new_revision)
        manifest = {"schema": 1, "candidate": identifier, "createdAt": stamp(), "status": "staging",
                    "stableIdentity": stable, "previousIntegratedRevision": self.source.revision,
                    "source": {"name": source_name, "url": url, "ref": ref,
                               "previousRevision": old_remote_revision, "revision": new_revision}}
        SOURCE.atomic_write(directory / "candidate.json", encoded(manifest))
        try:
            baseline_tree = self.merge(repository, self.source.revision, new_revision, "upstream", directory)
            integrated = git(repository, "commit-tree", baseline_tree, "-p", self.source.revision,
                             "-p", new_revision, input=b"Integrate candidate upstream while retaining local provenance\n").stdout.decode().strip()
            pin(repository, "baselines", integrated)
            # Reconstruct the old browser branch in an independent Git index.
            git(repository, "read-tree", self.source.revision)
            patch = self.source.patch_path.read_bytes()
            if patch:
                git(repository, "apply", "--cached", "--binary", input=patch)
            adapted_tree = git(repository, "write-tree").stdout.decode().strip()
            adapted = git(repository, "commit-tree", adapted_tree, "-p", self.source.revision,
                          input=b"Recorded browser adaptation branch\n").stdout.decode().strip()
            pin(repository, "adaptations", adapted)
            candidate_tree = self.merge(repository, integrated, adapted, "adaptation", directory)
            candidate_commit = git(repository, "commit-tree", candidate_tree, "-p", integrated,
                                   "-p", adapted, input=b"Merged native browser candidate\n").stdout.decode().strip()
            pin(repository, "candidates", candidate_commit)
            host = self.host_files()
            for name in host:
                target = project / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.root / name, target)
            export_tree(repository, candidate_tree, project / "native-client")
            baseline_lock = dict(self.source.lock)
            baseline_lock.update({"syncedAt": stamp(), "integratedRevision": integrated,
                                  "sourceFiles": {name: row["sha256"] for name, row in
                                                  SOURCE.hash_blobs(repository, SOURCE.tree(repository, integrated)).items()},
                                  "lastUpdate": manifest["source"] | {"previousIntegratedRevision": self.source.revision}})
            baseline_lock[source_name] = dict(pinned, url=url, revision=new_revision)
            SOURCE.atomic_write(project / "native-source.lock.json", encoded(baseline_lock))
            candidate_source = SOURCE.NativeSource(project)
            candidate_source.record()
            candidate_source.check()
            manifest.update({"status": "staged", "integratedRevision": integrated,
                             "candidateRevision": candidate_commit,
                             "sourceIdentity": self.candidate_identity(project), "hostFiles": host})
            self.verify_stable(manifest)
            SOURCE.atomic_write(directory / "candidate.json", encoded(manifest))
            return manifest
        except BaseException as error:
            manifest.update({"status": "conflict" if "merge conflicts" in str(error) else "failed", "error": str(error)})
            SOURCE.atomic_write(directory / "candidate.json", encoded(manifest))
            raise

    @staticmethod
    def candidate_identity(project):
        return {"locks": {name: SOURCE.file_sha(project / name) for name in LOCK_PATHS},
                "source": digest(SOURCE.inventory(project / "native-client"))}

    def load(self, identifier):
        directory = self.candidate(identifier)
        manifest = json.loads((directory / "candidate.json").read_text())
        if manifest.get("schema") != 1 or manifest.get("candidate") != identifier or manifest.get("status") not in {"staged", "validated"}:
            raise RuntimeError("candidate did not stage successfully")
        project = directory / "project"
        if project.is_symlink() or project.resolve().parent != directory:
            raise RuntimeError("candidate project must be an owned ordinary directory")
        if self.candidate_identity(project) != manifest["sourceIdentity"]:
            raise RuntimeError("candidate source or locks changed; stage a new candidate")
        for name, expected in manifest["hostFiles"].items():
            SOURCE.safe_name(name)
            if SOURCE.file_sha(project / name) != expected:
                raise RuntimeError(f"candidate host code changed: {name}")
        SOURCE.NativeSource(project).check()
        return directory, project, manifest

    @staticmethod
    def gates():
        return [
            ("source", [sys.executable, "tools/native-source.py", "check"]),
            ("network-contract", ["node", "--test", "tests/native-network.test.mjs", "tests/native-lobby-client.test.mjs", "tests/native-runtime-adapter.test.mjs"]),
            ("network-latency", ["node", "--test", "tests/native-network-latency.test.mjs"]),
            ("native-network", ["cargo", "test", "--locked", "--manifest-path", "native-client/Cargo.toml", "--lib", "browser_network"]),
            ("wasm-build", ["npm", "run", "build:native-web"]),
        ]

    @staticmethod
    def run_gate(argv, project, log, environment):
        with log.open("wb") as stream:
            result = subprocess.run(argv, cwd=project, env=environment, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"candidate gate failed ({result.returncode}); inspect {log}")

    def validate(self, identifier, runner=None):
        directory, project, manifest = self.load(identifier)
        self.verify_stable(manifest)
        dependencies = self.root / "node_modules"
        if dependencies.is_dir() and not (project / "node_modules").exists():
            (project / "node_modules").symlink_to(dependencies, target_is_directory=True)
        # Reuse generated dependency/compiler caches, never sibling sources.
        for name in ("cargo", "wasm-tools"):
            shared = self.root / ".build" / name
            if shared.is_dir() and not (project / ".build" / name).exists():
                (project / ".build" / name).symlink_to(shared, target_is_directory=True)
        receipt = {"schema": 1, "candidate": identifier, "sourceIdentity": manifest["sourceIdentity"],
                   "scope": "automatic build and transport contracts; real-engine runtime gates remain separate",
                   "startedAt": stamp(), "ok": False, "gates": [], "runtimeVerified": False}
        environment = dict(os.environ)
        # Cargo's default for the standalone native-client manifest would put
        # a second multi-GB host build in native-client/target. Both the direct
        # Rust test gate and the WASM build must use the owned candidate cache
        # path (which shares the stable project's compiler cache when present).
        environment["CARGO_TARGET_DIR"] = str(project / ".build/cargo")
        try:
            for name, argv in self.gates():
                log = directory / f"validate-{name}.log"
                (runner or self.run_gate)(argv, project, log, environment)
                receipt["gates"].append({"name": name, "argv": argv, "ok": True,
                                         "logSha256": SOURCE.file_sha(log)})
                self.load(identifier)
                self.verify_stable(manifest)
            receipt.update({"ok": True, "finishedAt": stamp()})
            manifest["status"] = "validated"
            SOURCE.atomic_write(directory / "candidate.json", encoded(manifest))
        except BaseException as error:
            receipt.update({"error": str(error), "finishedAt": stamp()})
            raise
        finally:
            SOURCE.atomic_write(directory / "validation.json", encoded(receipt))
        return receipt

    def promote(self, identifier, runtime_receipt, fault=None):
        self.clean()
        directory, project, manifest = self.load(identifier)
        self.verify_stable(manifest)
        validation = json.loads((directory / "validation.json").read_text())
        if (not validation.get("ok") or validation.get("candidate") != identifier
                or validation.get("sourceIdentity") != manifest["sourceIdentity"]
                or [(x["name"], x["argv"]) for x in validation["gates"]] != self.gates()):
            raise RuntimeError("candidate has not passed the current automatic gates")
        for gate in validation["gates"]:
            if SOURCE.file_sha(directory / f"validate-{gate['name']}.log") != gate["logSha256"]:
                raise RuntimeError("candidate validation log changed")
        runtime = json.loads(Path(runtime_receipt).read_text())
        if (runtime.get("schema") != 1 or runtime.get("candidate") != identifier
                or runtime.get("sourceIdentity") != manifest["sourceIdentity"]
                or not isinstance(runtime.get("evidence"), str) or not runtime["evidence"].strip()
                or any(runtime.get("checks", {}).get(check) is not True for check in REQUIRED_RUNTIME_CHECKS)):
            raise RuntimeError("runtime receipt must identify this exact candidate and all real-engine gates")
        # Import the new baseline into the original owned object store so all
        # subsequent native:record/native:sync operations can reproduce it.
        pin(self.source.repo, "baselines", self.source.revision)
        new_revision = manifest["integratedRevision"]
        new_ref = retention_ref("baselines", new_revision)
        existing = git(self.source.repo, "rev-parse", "--verify", "--quiet", new_ref,
                       allowed=(0, 1)).stdout.decode().strip()
        if existing and existing != new_revision:
            raise RuntimeError("stable baseline retention ref changed")
        git(self.source.repo, "fetch", "--no-tags", "--no-write-fetch-head", str(project / ".build/vera-upstream"),
            f"{new_revision}:{new_ref}")
        backup = directory / "stable-backup"
        backup.mkdir(exist_ok=True)
        if (backup / "native-client").exists():
            raise RuntimeError("candidate already has a retained stable source backup")
        for name in LOCK_PATHS:
            target = backup / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.root / name, target)
        transaction = {"schema": 1, "state": "pending", "candidate": identifier,
                       "stableIdentity": manifest["stableIdentity"], "sourceIdentity": manifest["sourceIdentity"]}
        SOURCE.atomic_write(directory / "promotion.json", encoded(transaction))
        try:
            self.source.output.rename(backup / "native-client")
            if fault:
                fault("after-source-backup")
            (project / "native-client").rename(self.source.output)
            for name in LOCK_PATHS:
                SOURCE.atomic_write(self.root / name, (project / name).read_bytes())
                if fault:
                    fault("after-lock:" + name)
            SOURCE.NativeSource(self.root).check()
            if self.candidate_identity(self.root) != manifest["sourceIdentity"]:
                raise RuntimeError("promoted source differs from the validated candidate")
            SOURCE.atomic_write(directory / "runtime-receipt.json", encoded(runtime))
            transaction.update({"state": "complete", "finishedAt": stamp()})
            SOURCE.atomic_write(directory / "promotion.json", encoded(transaction))
        except BaseException:
            self.recover(identifier)
            raise
        return {"candidate": identifier, "promoted": True, "integratedRevision": manifest["integratedRevision"],
                "retainedBackup": str(backup)}

    def recover(self, identifier):
        directory = self.candidate(identifier)
        journal = directory / "promotion.json"
        transaction = json.loads(journal.read_text())
        if transaction.get("state") != "pending":
            raise RuntimeError("candidate has no interrupted promotion")
        backup, project = directory / "stable-backup", directory / "project"
        # Do not overwrite work done after a process interruption. Each lock
        # can only be the saved old value or the staged new value at this point.
        for name in LOCK_PATHS:
            path = self.root / name
            allowed = {transaction["stableIdentity"]["locks"][name],
                       transaction["sourceIdentity"]["locks"][name]}
            if not path.is_file() or path.is_symlink() or SOURCE.file_sha(path) not in allowed:
                raise RuntimeError(f"lock changed after promotion interruption; preserve and inspect manually: {name}")
        if (backup / "native-client").exists():
            if self.source.output.exists():
                if (project / "native-client").exists():
                    raise RuntimeError("ambiguous recovery source paths; preserve both and inspect manually")
                self.source.output.rename(project / "native-client")
            (backup / "native-client").rename(self.source.output)
        for name in LOCK_PATHS:
            SOURCE.atomic_write(self.root / name, (backup / name).read_bytes())
        SOURCE.NativeSource(self.root).check()
        transaction.update({"state": "rolled-back", "finishedAt": stamp()})
        SOURCE.atomic_write(journal, encoded(transaction))
        return {"candidate": identifier, "restoredStableSource": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    stage = commands.add_parser("stage", help="fetch an explicit ref and stage without changing stable source")
    stage.add_argument("--source", choices=("upstream", "origin"), default="upstream")
    stage.add_argument("--ref", required=True)
    stage.add_argument("--remote", help="explicit HTTPS fork URL; credentials in URLs are rejected")
    for action in ("validate", "promote", "recover"):
        command = commands.add_parser(action)
        command.add_argument("candidate")
        if action == "promote":
            command.add_argument("--runtime-receipt", required=True)
    args = parser.parse_args()
    try:
        update = NativeUpdate(ROOT)
        if args.action == "recover":
            # Recovery must be able to enter while a pending journal exists.
            with (update.home / "operation.lock").open("a+b") as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = update.recover(args.candidate)
        else:
            with update.exclusive():
                if args.action == "stage":
                    result = update.stage(args.source, args.ref, args.remote)
                elif args.action == "validate":
                    result = update.validate(args.candidate)
                else:
                    result = update.promote(args.candidate, args.runtime_receipt)
        print(json.dumps(result, ensure_ascii=False))
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"native-update: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
