#!/usr/bin/env python3
"""Synthetic regressions for native-source.py; never reads original projects."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("native_source", Path(__file__).with_name("native-source.py"))
SOURCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE)


class NativeSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="native-source-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / ".build/vera-upstream"
        self.repo.mkdir(parents=True)
        SOURCE.command(self.repo, "init", "--quiet")
        self.write(self.repo / "source.txt", b"native renderer\nsecond line\n")
        self.write(self.repo / "remove empty.txt", b"")
        self.write(self.repo / "delete.bin", bytes(range(256)))
        self.write(self.repo / "change.bin", b"\x00\xfforiginal")
        self.write(self.repo / "run.sh", b"#!/bin/sh\nexit 0\n")
        self.write(self.repo / "unchanged.txt", b"unchanged baseline")
        SOURCE.command(self.repo, "add", "--all")
        SOURCE.command(self.repo, "-c", "user.name=Source Fixture", "-c",
                       "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "baseline")
        revision = SOURCE.command(self.repo, "rev-parse", "HEAD").decode().strip()
        self.output = self.root / "native-client"
        shutil.copytree(self.repo, self.output, ignore=shutil.ignore_patterns(".git"))
        baseline = SOURCE.inventory(self.output)
        (self.root / "native-source.lock.json").write_text(json.dumps({
            "schema": 1, "integratedRevision": revision,
            "localSource": {"path": "/must/never/be/opened/or/written"},
            "sourceFiles": {name: record["sha256"] for name, record in baseline.items()}}))

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def change(self):
        self.write(self.output / "source.txt", b"native renderer\nbrowser platform\n")
        self.write(self.output / "change.bin", b"\x00\xfewebgpu\xff")
        self.write(self.output / "new empty.txt", b"")
        self.write(self.output / "unicode/王二火大.txt", "保持原生渲染\n".encode())
        (self.output / "remove empty.txt").unlink()
        (self.output / "delete.bin").unlink()
        (self.output / "run.sh").chmod(0o755)

    def record(self):
        self.change()
        source = SOURCE.NativeSource(self.root)
        with contextlib.redirect_stdout(io.StringIO()):
            source.record()
        return source

    def test_binary_empty_unicode_deleted_and_mode_replay(self):
        source = self.record()
        expected = SOURCE.inventory(self.output)
        patch = source.patch_path.read_bytes()
        self.assertIn(b"GIT binary patch", patch)
        self.assertIn(b"new file mode 100644", patch)
        self.assertIn(b"old mode 100644\nnew mode 100755", patch)
        source.check()
        shutil.rmtree(self.output)
        with contextlib.redirect_stdout(io.StringIO()):
            source.sync()
        self.assertEqual(expected, SOURCE.inventory(self.output))

    def test_check_and_explicit_rebuild_without_merge_mirror(self):
        source = self.record()
        expected = SOURCE.inventory(self.output)
        shutil.rmtree(self.repo)
        self.write(self.output / "target/cache.bin", b"compiler cache")
        self.write(self.output / ".cargo-run/cache", b"runtime cache")
        source = SOURCE.NativeSource(self.root)
        source.check()
        unchanged = self.output / "unchanged.txt"
        before_mtime = unchanged.stat().st_mtime_ns
        with contextlib.redirect_stdout(io.StringIO()):
            source.sync()
        self.assertEqual(before_mtime, unchanged.stat().st_mtime_ns)
        with contextlib.redirect_stdout(io.StringIO()):
            source.sync(rebuild=True)
        self.assertEqual(expected, SOURCE.inventory(self.output))
        self.assertEqual(b"compiler cache", (self.output / "target/cache.bin").read_bytes())
        self.assertEqual(b"runtime cache", (self.output / ".cargo-run/cache").read_bytes())

    def test_unrecorded_edits_prevent_sync_and_remain_intact(self):
        source = self.record()
        self.write(self.output / "source.txt", b"unrecorded edit")
        with self.assertRaisesRegex(RuntimeError, "unrecorded native-client edits"):
            source.sync(rebuild=True)
        self.assertEqual(b"unrecorded edit", (self.output / "source.txt").read_bytes())

    def test_patch_tampering_and_false_baseline_are_rejected(self):
        source = self.record()
        original = source.patch_path.read_bytes()
        source.patch_path.write_bytes(original + b"tampered")
        with self.assertRaisesRegex(RuntimeError, "digest"):
            source.check()
        source.patch_path.write_bytes(original)
        lock = json.loads(source.patch_lock_path.read_text())
        lock["files"]["unchanged.txt"] = {"mode": "100644", "sha256": "0" * 64}
        source.patch_lock_path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(RuntimeError, "unrecorded native-client edits"):
            source.check()

    def test_baseline_git_drift_and_source_symlinks_are_rejected(self):
        lock = json.loads((self.root / "native-source.lock.json").read_text())
        lock["sourceFiles"]["unchanged.txt"] = "0" * 64
        (self.root / "native-source.lock.json").write_text(json.dumps(lock))
        with self.assertRaisesRegex(RuntimeError, "pinned Git source differs"):
            SOURCE.NativeSource(self.root).record()
        (self.output / "external").symlink_to(self.repo / "source.txt")
        with self.assertRaisesRegex(RuntimeError, "ordinary files"):
            SOURCE.inventory(self.output)

    def test_no_changes_and_no_mirror_check(self):
        source = SOURCE.NativeSource(self.root)
        with contextlib.redirect_stdout(io.StringIO()):
            source.record()
        self.assertEqual(b"", source.patch_path.read_bytes())
        shutil.rmtree(self.repo)
        SOURCE.NativeSource(self.root).check()


if __name__ == "__main__":
    unittest.main()
