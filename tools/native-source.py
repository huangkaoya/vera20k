#!/usr/bin/env python3
"""Record, check, or replay the isolated full VERA client and its browser patch.

The immutable baseline is native-source.lock.json. Only the owned
.build/vera-upstream Git object store is read; no original checkout is opened,
fetched, reset, or modified. Browser changes are a separate binary-safe Git patch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PATCH_PATH = "patches/native-client.patch"
PATCH_LOCK_PATH = "patches/native-client.lock.json"
IGNORED_ROOTS = {"target", ".cargo-run", ".git"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(name: str) -> str:
    value = PurePosixPath(name)
    if (not name or name == "." or value.is_absolute() or ".." in value.parts
            or ".git" in value.parts or value.as_posix() != name):
        raise RuntimeError(f"unsafe source path: {name!r}")
    return name


def isolated_environment() -> dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("GIT_"):
            del env[key]
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"})
    return env


def command(repo: Path, *args: str, env=None, input=None) -> bytes:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.autocrlf=false", "-c",
         "core.filemode=true", "-C", str(repo), *args], input=input,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env or isolated_environment())
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git {' '.join(args[:3])}: {detail}")
    return result.stdout


def inventory(directory: Path, ignore_artifacts=True) -> dict:
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError(f"source output must be an ordinary directory: {directory}")
    result = {}
    for current, directories, files in os.walk(directory, followlinks=False):
        relative = Path(current).relative_to(directory)
        for name in list(directories):
            path = Path(current) / name
            if path.is_symlink():
                raise RuntimeError(f"source symlinks are not supported: {path}")
            if ((relative == Path(".") and name == ".git")
                    or (ignore_artifacts and (name == "__pycache__"
                        or (relative == Path(".") and name in IGNORED_ROOTS)))):
                directories.remove(name)
        for name in files:
            path = Path(current) / name
            if ignore_artifacts and name == ".DS_Store":
                continue
            key = safe_name(path.relative_to(directory).as_posix())
            if path.is_symlink() or not path.is_file():
                raise RuntimeError(f"source entries must be ordinary files: {key}")
            mode = "100755" if path.stat().st_mode & stat.S_IXUSR else "100644"
            result[key] = {"sha256": file_sha(path), "mode": mode}
    return dict(sorted(result.items()))


def tree(repo: Path, revision: str, env=None) -> dict:
    result = {}
    for row in command(repo, "ls-tree", "-r", "-z", "--full-tree", revision, env=env).split(b"\0"):
        if not row:
            continue
        metadata, name = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split(" ")
        key = safe_name(name.decode("utf-8"))
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise RuntimeError(f"unsupported source entry: {mode} {kind} {key}")
        result[key] = {"mode": mode, "oid": oid}
    return dict(sorted(result.items()))


def read_blobs(repo: Path, entries: dict, consume, env=None):
    """Stream blobs without retaining the 900MB baseline in memory or on disk."""
    process = subprocess.Popen(
        ["git", "--no-optional-locks", "-C", str(repo), "cat-file", "--batch"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env or isolated_environment())
    try:
        for name, entry in entries.items():
            process.stdin.write((entry["oid"] + "\n").encode())
            process.stdin.flush()
            header = process.stdout.readline().decode().strip().split(" ")
            if len(header) != 3 or header[1] != "blob":
                raise RuntimeError(f"missing source blob: {name}")
            remaining = int(header[2])
            stream = consume(name, entry)
            while remaining:
                chunk = process.stdout.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise RuntimeError(f"truncated source blob: {name}")
                stream.send(chunk)
                remaining -= len(chunk)
            if process.stdout.read(1) != b"\n":
                raise RuntimeError(f"invalid source blob terminator: {name}")
            try:
                stream.send(None)
            except StopIteration:
                pass
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError(process.stderr.read().decode(errors="replace"))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        process.stderr.close()
        if not process.stdin.closed:
            process.stdin.close()


def hash_blobs(repo: Path, entries: dict, env=None) -> dict:
    result = {}

    def sink(name, entry):
        def collect():
            digest = hashlib.sha256()
            while (chunk := (yield)) is not None:
                digest.update(chunk)
            result[name] = {"sha256": digest.hexdigest(), "mode": entry["mode"]}
        generator = collect()
        next(generator)
        return generator

    read_blobs(repo, entries, sink, env)
    return result


def mismatch(expected: dict, actual: dict, label: str):
    changed = [key for key in sorted(set(expected) | set(actual))
               if expected.get(key) != actual.get(key)]
    if changed:
        raise RuntimeError(f"{label} ({len(changed)} files):\n" + "\n".join(changed[:30]))


class NativeSource:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.output = self.root / "native-client"
        self.build = self.root / ".build"
        self.repo = self.build / "vera-upstream"
        self.baseline_path = self.root / "native-source.lock.json"
        self.patch_path = self.root / PATCH_PATH
        self.patch_lock_path = self.root / PATCH_LOCK_PATH
        self.baseline_bytes = self.baseline_path.read_bytes()
        self.lock = json.loads(self.baseline_bytes)
        if self.lock.get("schema") != 1:
            raise RuntimeError("unsupported native-source.lock.json schema")
        self.revision = self.lock["integratedRevision"]
        if len(self.revision) != 40 or any(c not in "0123456789abcdef" for c in self.revision):
            raise RuntimeError("integratedRevision must be a full pinned commit ID")
        for owned in (self.build, self.repo, self.output, self.root / "patches"):
            if owned.is_symlink() or owned.resolve().parent not in {self.root, self.build}:
                raise RuntimeError(f"refusing symlink or external owned path: {owned}")
        if (self.output / ".git").exists() or (self.output / ".git").is_symlink():
            raise RuntimeError("native-client must be an archive snapshot, not a separate Git checkout")
        self.baseline = {safe_name(name): {"sha256": digest, "mode": "100644"}
                         for name, digest in self.lock["sourceFiles"].items()}
        self.baseline_tree = None

    def require_mirror(self):
        if not self.repo.is_dir():
            raise RuntimeError("this operation needs owned .build/vera-upstream; existing recorded native-client can check or sync --rebuild without it")
        if command(self.repo, "rev-parse", "--show-toplevel").decode().strip() != str(self.repo):
            raise RuntimeError("baseline source must be the owned .build/vera-upstream checkout")
        common = Path(command(self.repo, "rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip())
        if not common.resolve().is_relative_to(self.repo):
            raise RuntimeError("baseline Git objects must be owned by .build/vera-upstream")
        self.objects = common / "objects"
        if self.objects.is_symlink():
            raise RuntimeError("baseline Git object directory must not be a symlink")
        resolved = command(self.repo, "rev-parse", self.revision + "^{commit}").decode().strip()
        if resolved != self.revision:
            raise RuntimeError("baseline revision is not the pinned commit")
        self.baseline_tree = tree(self.repo, self.revision)
        expected = {safe_name(name): {"sha256": digest, "mode": self.baseline_tree.get(name, {}).get("mode")}
                    for name, digest in self.lock["sourceFiles"].items()}
        if set(expected) != set(self.baseline_tree):
            raise RuntimeError("baseline sourceFiles list differs from the pinned Git tree")
        self.baseline = expected

    def verify_baseline(self):
        self.require_mirror()
        mismatch(self.baseline, hash_blobs(self.repo, self.baseline_tree),
                 "pinned Git source differs from native-source.lock.json")

    def temporary_index(self, directory: Path):
        repository = directory / "index"
        repository.mkdir()
        command(repository, "init", "--quiet")
        env = isolated_environment()
        env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = str(self.objects)
        command(repository, "read-tree", self.revision, env=env)
        return repository, env

    def load_patch(self):
        if not self.patch_lock_path.exists():
            raise RuntimeError("no native browser patch recorded; run native-source.py record")
        lock = json.loads(self.patch_lock_path.read_text())
        if (lock.get("schema") != 1 or lock.get("integratedRevision") != self.revision
                or lock.get("baselineLockSha256") != sha256(self.baseline_bytes)
                or lock.get("patch", {}).get("path") != PATCH_PATH):
            raise RuntimeError("native patch lock does not match the pinned baseline")
        patch = self.patch_path.read_bytes()
        if sha256(patch) != lock["patch"]["sha256"]:
            raise RuntimeError("native-client.patch changed without recording its digest")
        for name, mode in lock.get("baselineModes", {}).items():
            if name not in self.baseline or mode not in {"100644", "100755"}:
                raise RuntimeError(f"invalid baseline mode record: {name}")
            self.baseline[name] = {**self.baseline[name], "mode": mode}
        expected = dict(self.baseline)
        for name, value in lock["files"].items():
            safe_name(name)
            if value is None:
                expected.pop(name, None)
            elif (value.get("mode") in {"100644", "100755"}
                  and isinstance(value.get("sha256"), str) and len(value["sha256"]) == 64):
                expected[name] = value
            else:
                raise RuntimeError(f"invalid native patch file record: {name}")
        return lock, patch, expected

    def replay(self, directory: Path, patch: bytes, expected: dict):
        repository, env = self.temporary_index(directory)
        if patch:
            command(repository, "apply", "--cached", "--check", "--binary", env=env, input=patch)
            command(repository, "apply", "--cached", "--binary", env=env, input=patch)
        revision = command(repository, "write-tree", env=env).decode().strip()
        entries = tree(repository, revision, env)
        if set(entries) != set(expected):
            raise RuntimeError("replayed native patch has an unexpected file list")
        changed = {}
        for name, entry in entries.items():
            if entry["mode"] != expected[name]["mode"]:
                raise RuntimeError(f"replayed native patch has an unexpected mode: {name}")
            if self.baseline_tree.get(name) == entry and self.baseline.get(name) == expected[name]:
                continue
            changed[name] = entry
        actual = hash_blobs(repository, changed, env)
        mismatch({key: expected[key] for key in changed}, actual,
                 "replayed native patch differs from recorded output")
        return repository, env, entries

    def record(self):
        self.verify_baseline()
        current = inventory(self.output)
        changes = {key: current.get(key) for key in sorted(set(self.baseline) | set(current))
                   if self.baseline.get(key) != current.get(key)}
        with tempfile.TemporaryDirectory(prefix="native-source-", dir=self.build) as temporary:
            directory = Path(temporary)
            repository, env = self.temporary_index(directory)
            for name, value in changes.items():
                if value is None:
                    command(repository, "update-index", "--force-remove", "--", name, env=env)
                else:
                    oid = command(repository, "hash-object", "-w", "--no-filters", "--",
                                  str(self.output / name), env=env).decode().strip()
                    command(repository, "update-index", "--add", "--cacheinfo", value["mode"],
                            oid, name, env=env)
            patch = command(repository, "diff", "--cached", "--binary", "--full-index",
                            "--no-ext-diff", "--no-textconv", "--no-renames", self.revision, "--", env=env)
            replay_dir = directory / "replay"
            replay_dir.mkdir()
            self.replay(replay_dir, patch, current)
            mismatch(current, inventory(self.output), "native-client changed while recording; retry after edits finish")
        lock = {"schema": 1, "integratedRevision": self.revision,
                "baselineLockSha256": sha256(self.baseline_bytes),
                "baselineModes": {name: value["mode"] for name, value in self.baseline.items()
                                  if value["mode"] != "100644"},
                "patch": {"path": PATCH_PATH, "sha256": sha256(patch)}, "files": changes}
        self.patch_path.parent.mkdir(exist_ok=True)
        atomic_write(self.patch_path, patch)
        atomic_write(self.patch_lock_path, (json.dumps(lock, ensure_ascii=False, indent=2) + "\n").encode())
        print(f"Recorded {len(changes)} native client changes in {PATCH_PATH} ({len(patch)} bytes).")

    def check(self, allow_missing=False):
        lock, patch, expected = self.load_patch()
        if self.output.exists():
            mismatch(expected, inventory(self.output), "unrecorded native-client edits; run record before sync")
        elif not allow_missing:
            raise RuntimeError("native-client is missing; run native-source.py sync")
        else:
            self.verify_baseline()
            with tempfile.TemporaryDirectory(prefix="native-source-", dir=self.build) as temporary:
                self.replay(Path(temporary), patch, expected)
            return lock, patch, expected
        self.build.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="native-source-", dir=self.build) as temporary:
            stage = Path(temporary)
            command(stage, "init", "--quiet")
            # A fresh clone already contains the patched full source. Only the
            # changed files are needed to prove that reversing the reviewable
            # patch restores their baseline bytes. No mirror or 900MB copy.
            for name in lock["files"]:
                if name in expected:
                    path = stage / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(self.output / name, path)
            if patch:
                command(stage, "apply", "--reverse", "--check", "--binary", input=patch)
                command(stage, "apply", "--reverse", "--binary", input=patch)
            mismatch({name: self.baseline[name] for name in lock["files"] if name in self.baseline},
                     inventory(stage, ignore_artifacts=False), "reversed native patch differs from the pinned baseline")
        mismatch(expected, inventory(self.output), "native-client changed while checking; retry after edits finish")
        return lock, patch, expected

    def sync(self, rebuild=False):
        _, patch, expected = self.check(allow_missing=True)
        if self.output.exists() and not rebuild:
            print("Native client already matches the pinned source plus browser patch; mtimes preserved.")
            return
        with tempfile.TemporaryDirectory(prefix="native-source-", dir=self.build) as temporary:
            directory = Path(temporary)
            stage = directory / "native-client"
            stage.mkdir()
            existed = self.output.exists()
            if existed:
                # Explicit full reconstruction works even when a fresh clone
                # has no local merge commit/object store. It preserves the
                # original until both reverse and forward SHA checks pass.
                for name in expected:
                    path = stage / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(self.output / name, path)
                command(stage, "init", "--quiet")
                if patch:
                    command(stage, "apply", "--reverse", "--binary", input=patch)
                mismatch(self.baseline, inventory(stage, ignore_artifacts=False), "rebuilt baseline differs from native-source.lock.json")
                if patch:
                    command(stage, "apply", "--binary", input=patch)
                shutil.rmtree(stage / ".git")
            else:
                repository, env, entries = self.replay(directory, patch, expected)

                def sink(name, entry):
                    def write():
                        path = stage / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        with path.open("wb") as stream:
                            while (chunk := (yield)) is not None:
                                stream.write(chunk)
                        path.chmod(0o755 if entry["mode"] == "100755" else 0o644)
                    generator = write()
                    next(generator)
                    return generator

                read_blobs(repository, entries, sink, env)
            mismatch(expected, inventory(stage, ignore_artifacts=False), "reconstructed native client differs from the pinned patch")
            if self.output.is_symlink() or self.output.exists() != existed:
                raise RuntimeError("native-client changed during sync; refusing to replace it")
            if existed:
                mismatch(expected, inventory(self.output), "native-client changed during sync; refusing to replace it")
                previous = directory / "previous"
                self.output.rename(previous)
                moved_caches = []
                try:
                    stage.rename(self.output)
                    for name in IGNORED_ROOTS - {".git"}:
                        cached = previous / name
                        if cached.exists():
                            cached.rename(self.output / name)
                            moved_caches.append(name)
                except BaseException:
                    for name in moved_caches:
                        (self.output / name).rename(previous / name)
                    if self.output.exists():
                        shutil.rmtree(self.output)
                    previous.rename(self.output)
                    raise
            else:
                stage.rename(self.output)
        print("Rebuilt native-client from the pinned integrated source plus recorded browser patch.")


def atomic_write(path: Path, content: bytes):
    if path.is_symlink():
        raise RuntimeError(f"refusing symlink output: {path}")
    with tempfile.NamedTemporaryFile(prefix=path.name + ".", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.chmod(0o644)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["record", "check", "sync"])
    parser.add_argument("--rebuild", action="store_true", help="explicitly reconstruct an already-recorded native-client; only valid with sync")
    args = parser.parse_args()
    if args.rebuild and args.action != "sync":
        parser.error("--rebuild is only valid with sync")
    try:
        source = NativeSource(ROOT)
        if args.action == "record":
            source.record()
        elif args.action == "sync":
            source.sync(rebuild=args.rebuild)
        else:
            source.check()
            print("Native client and binary browser patch match the pinned full-source baseline.")
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"native-source: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
