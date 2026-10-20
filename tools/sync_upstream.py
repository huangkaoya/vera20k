#!/usr/bin/env python3
"""Read-only upstream snapshots with explicit, reviewable integration patches."""
from pathlib import Path
import argparse
import difflib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "upstream.lock.json"
PATCH_LOCK = ROOT / "patches.lock.json"
BASELINE = ROOT / "validation/protected-sources.json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(source, *args):
    return subprocess.check_output(["git", "--no-optional-locks", "-C", str(source), *args])


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def tree_files(directory):
    if directory.is_symlink():
        raise RuntimeError("vendor source must not be a symlink")
    return {p.relative_to(directory).as_posix(): p.read_bytes()
            for p in directory.rglob("*") if p.is_file()}


def vendor_files(name):
    return tree_files(ROOT / "vendor" / name)


def check(lock, patches, vendor_root=None):
    failures = []
    for name, info in lock["sources"].items():
        expected = {key: value["sha256"] for key, value in info["files"].items()}
        expected.update(patches.get("sources", {}).get(name, {}).get("files", {}))
        current_files = tree_files(vendor_root / name) if vendor_root is not None else vendor_files(name)
        current = {key: sha(value) for key, value in current_files.items()}
        for key in sorted(set(expected) | set(current)):
            if expected.get(key) != current.get(key):
                failures.append(f"{name}/{key}")
    if failures:
        message = ("staged snapshot does not match pinned upstream plus recorded patches:\n"
                   if vendor_root is not None else "unrecorded vendor edits; save patches first:\n")
        raise RuntimeError(message + "\n".join(failures[:30]))


def save_patches(lock):
    result = {"schema": 1, "sources": {}}
    for name, info in lock["sources"].items():
        current = vendor_files(name)
        changed = {}
        diff = []
        for key in sorted(set(info["files"]) | set(current)):
            record = info["files"].get(key)
            now = current.get(key)
            if record and now is not None and sha(now) == record["sha256"]:
                continue
            before = git(info["source"], "show", info["revision"] + ":" + record["source_path"]) if record else b""
            changed[key] = sha(now) if now is not None else None
            if (record is None and now == b"") or (record is not None and before == b"" and now is None):
                # A unified text diff has no hunk for an empty file. Git's
                # mode-only headers retain its addition/deletion explicitly.
                left = json.dumps("a/" + key, ensure_ascii=False)
                right = json.dumps("b/" + key, ensure_ascii=False)
                diff.append(f"diff --git {left} {right}\n")
                if record is None:
                    diff.extend(["new file mode 100644\n", "index 0000000..e69de29\n"])
                else:
                    diff.extend(["deleted file mode 100644\n", "index e69de29..0000000\n"])
                continue
            diff.extend(difflib.unified_diff(
                before.decode().splitlines(keepends=True), (now or b"").decode().splitlines(keepends=True),
                fromfile="a/" + key if record else "/dev/null",
                tofile="b/" + key if now is not None else "/dev/null"))
        patch = ROOT / "patches" / (name + ".patch")
        patch.parent.mkdir(parents=True, exist_ok=True)
        patch.write_text("".join(diff))
        result["sources"][name] = {"revision": info["revision"], "files": changed,
                                   "patch": patch.relative_to(ROOT).as_posix(), "sha256": sha(patch.read_bytes())}
    write_json(PATCH_LOCK, result)
    print("Recorded integration patches; original projects were read only.")


def sync(lock, patches, update):
    check(lock, patches)
    (ROOT / ".build").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sync-", dir=ROOT / ".build") as temp:
        stage = Path(temp)
        new_lock = {"schema": 1, "sources": {}}
        for name, info in lock["sources"].items():
            revision = git(info["source"], "rev-parse", "HEAD").decode().strip() if update else info["revision"]
            archive = git(info["source"], "archive", revision, *info["paths"])
            dest = stage / "vendor" / name
            dest.mkdir(parents=True)
            files = {}
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                for item in tar:
                    if not item.isfile():
                        continue
                    key = item.name
                    if Path(key).is_absolute() or ".." in Path(key).parts:
                        raise RuntimeError("unsafe upstream path")
                    if name == "vera20k" and key == "Cargo.toml":
                        key = "upstream.Cargo.toml"
                    body = tar.extractfile(item).read()
                    target = dest / key
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(body)
                    files[key] = {"source_path": item.name, "sha256": sha(body)}
            patch_record = patches.get("sources", {}).get(name)
            if patch_record:
                patch = ROOT / patch_record["patch"]
                if sha(patch.read_bytes()) != patch_record["sha256"]:
                    raise RuntimeError("patch changed without recording its digest")
                if patch.stat().st_size:
                    command = ["git", "apply", "--directory=vendor/" + name, str(patch)]
                    # Apply to this standalone staging tree. Repository-prefix
                    # filtering otherwise silently skips mode-only diffs when
                    # the stage is nested below the real project's .git.
                    apply_env = dict(os.environ)
                    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
                        apply_env.pop(key, None)
                    apply_env["GIT_CEILING_DIRECTORIES"] = str(stage.parent)
                    subprocess.run(command[:2] + ["--check"] + command[2:], cwd=stage, env=apply_env, check=True)
                    subprocess.run(command, cwd=stage, env=apply_env, check=True)
            new_lock["sources"][name] = {**info, "revision": revision, "files": files}
        # A pinned replay must recreate every recorded file, including empty
        # additions/deletions, before any owned snapshot can be replaced.
        if not update:
            check(lock, patches, stage / "vendor")
        # All overlays applied successfully before replacing any owned snapshot.
        for name in new_lock["sources"]:
            target = ROOT / "vendor" / name
            if target.is_symlink() or target.parent.resolve() != (ROOT / "vendor").resolve():
                raise RuntimeError("unsafe vendor output")
            # A pinned, clean replay should not invalidate Cargo's cache or
            # touch source mtimes when the staged content is already identical.
            if tree_files(target) == tree_files(stage / "vendor" / name):
                continue
            shutil.rmtree(target)
            shutil.move(str(stage / "vendor" / name), target)
        write_json(LOCK, new_lock)
        save_patches(new_lock)
    print("Synchronized isolated snapshots" + (" to current upstream revisions." if update else " at pinned revisions."))


def source_state(info):
    source = Path(info["source"])
    names = git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    files = {}
    for name in sorted(set(filter(None, names))):
        path = source / name
        if path.is_symlink():
            files[name] = "symlink:" + str(path.readlink())
        elif path.is_file():
            files[name] = sha(path.read_bytes())
    return {"revision": git(source, "rev-parse", "HEAD").decode().strip(),
            "status": git(source, "status", "--porcelain=v1").decode(), "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["sync", "patches", "check", "isolation"])
    parser.add_argument("--update", action="store_true", help="rebase recorded overlays onto current upstream HEAD")
    parser.add_argument("--record", action="store_true", help="record protected upstream file fingerprints")
    args = parser.parse_args()
    lock = read_json(LOCK)
    patches = read_json(PATCH_LOCK, {"sources": {}})
    if args.action == "patches":
        save_patches(lock)
    elif args.action == "check":
        check(lock, patches)
        print("Vendored sources match pinned upstream files plus recorded patches.")
    elif args.action == "sync":
        sync(lock, patches, args.update)
    else:
        state = {name: source_state(info) for name, info in lock["sources"].items()}
        if args.record:
            if BASELINE.exists():
                raise RuntimeError("protected source baseline already exists")
            write_json(BASELINE, state)
            print("Recorded protected source fingerprints.")
        else:
            before = read_json(BASELINE)
            if before is None:
                raise RuntimeError("no protected source baseline; record it before starting work")
            report = {"schema": 1, "ok": before == state, "sources": {}}
            for name, current in state.items():
                original = before.get(name, {"files": {}})
                changed = [key for key in sorted(set(original["files"]) | set(current["files"]))
                           if original["files"].get(key) != current["files"].get(key)]
                report["sources"][name] = {"beforeRevision": original.get("revision"),
                    "currentRevision": current["revision"], "changedFiles": changed,
                    "statusChanged": original.get("status") != current["status"]}
            write_json(ROOT / "validation/isolation.json", report)
            if not report["ok"]:
                changes = "; ".join(f"{name}: {len(value['changedFiles'])} files, "
                    f"HEAD {str(value['beforeRevision'])[:8]} -> {value['currentRevision'][:8]}"
                    for name, value in report["sources"].items()
                    if value["changedFiles"] or value["beforeRevision"] != value["currentRevision"] or value["statusChanged"])
                raise RuntimeError("upstream drift detected; original files were not restored or overwritten: "
                                   + changes + ". See validation/isolation.json")
            print("Original vera20k and ra2web-werhd source trees are unchanged.")


if __name__ == "__main__":
    main()
