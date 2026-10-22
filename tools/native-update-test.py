#!/usr/bin/env python3
"""Mini-Git integration tests. No real remote, sibling source, or Rust build."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("native_update", Path(__file__).with_name("native-update.py"))
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)
SOURCE = UPDATE.SOURCE


class NativeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="native-update-test-")
        self.root = Path(self.temporary.name)
        self.mirror = self.root / ".build/vera-upstream"
        self.mirror.mkdir(parents=True)
        UPDATE.git(self.mirror, "init", "--quiet")
        self.write(self.mirror / "rules.txt", "speed=1\narmor=1\n")
        self.write(self.mirror / "platform.txt", "native platform\n")
        self.commit(self.mirror, "upstream base")
        self.old_upstream = self.revision(self.mirror)
        # The integrated base contains work which is absent upstream. It must
        # survive fetching/merging a later upstream commit.
        self.write(self.mirror / "local-branding.txt", "王二火大\n")
        self.commit(self.mirror, "local customisation")
        self.integrated = self.revision(self.mirror)
        self.output = self.root / "native-client"
        shutil.copytree(self.mirror, self.output, ignore=shutil.ignore_patterns(".git"))
        baseline = SOURCE.inventory(self.output)
        self.write(self.root / "native-source.lock.json", json.dumps({
            "schema": 1, "integratedRevision": self.integrated,
            "upstream": {"revision": self.old_upstream, "url": "https://upstream.example.invalid/vera.git"},
            "origin": {"revision": self.integrated, "url": "https://origin.example.invalid/vera.git"},
            "localSource": {"path": "/must/not/read/or/write"},
            "sourceFiles": {p: row["sha256"] for p, row in baseline.items()}}))
        self.write(self.output / "platform.txt", "browser platform\n")
        self.write(self.output / "browser-network.txt", "ahead-window=8\n")
        self.write(self.root / ".gitignore", ".build/\nnode_modules/\n**/__pycache__/\n")
        self.write(self.root / "host.py", "print('host boundary')\n")
        with contextlib.redirect_stdout(io.StringIO()):
            SOURCE.NativeSource(self.root).record()
        UPDATE.git(self.root, "init", "--quiet")
        self.commit(self.root, "stable project")
        UPDATE.git(self.mirror, "checkout", "--quiet", "--detach", self.old_upstream)
        self.write(self.mirror / "rules.txt", "speed=2\narmor=1\n")
        self.commit(self.mirror, "new upstream rules")
        self.new_upstream = self.revision(self.mirror)
        self.update = UPDATE.NativeUpdate(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)

    @staticmethod
    def commit(repo, message):
        UPDATE.git(repo, "add", "--all")
        UPDATE.git(repo, "commit", "--quiet", "-m", message)

    @staticmethod
    def revision(repo):
        return UPDATE.git(repo, "rev-parse", "HEAD").stdout.decode().strip()

    def stage(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.update.stage("upstream", "main", prepared_revision=self.new_upstream)

    def fixture_validation(self, manifest, fail=False):
        # Dependency injection confines this integration fixture to real Python
        # execution; production CLI has no switch to replace mandatory gates.
        self.update.gates = lambda: [("fixture-real-command", [sys.executable, "-c",
            "import os; from pathlib import Path; "
            "assert Path('native-client/rules.txt').read_text().startswith('speed=2'); "
            "target=Path(os.environ['CARGO_TARGET_DIR']); target.mkdir(parents=True, exist_ok=True); "
            "(target/'native-update-fixture-artifact').write_text('candidate compiled artifact'); "
            "assert not Path('native-client/target').exists()"])]
        def runner(argv, project, log, environment):
            if fail:
                raise RuntimeError("fixture gate deliberately failed")
            self.assertEqual(str(project / ".build/cargo"), environment.get("CARGO_TARGET_DIR"))
            UPDATE.NativeUpdate.run_gate(argv, project, log, environment)
        return self.update.validate(manifest["candidate"], runner=runner)

    def runtime(self, manifest):
        path = self.root / ".build/runtime-fixture.json"
        path.write_bytes(UPDATE.encoded({"schema": 1, "candidate": manifest["candidate"],
            "sourceIdentity": manifest["sourceIdentity"],
            "checks": dict.fromkeys(UPDATE.REQUIRED_RUNTIME_CHECKS, True),
            "evidence": "synthetic mini-Git test receipt, not game acceptance"}))
        return path

    def test_stage_retains_customisations_and_is_stable_read_only(self):
        before = self.update.stable_identity()
        manifest = self.stage()
        project = self.update.candidate(manifest["candidate"]) / "project"
        self.assertEqual("speed=2\narmor=1\n", (project / "native-client/rules.txt").read_text())
        self.assertEqual("王二火大\n", (project / "native-client/local-branding.txt").read_text())
        self.assertEqual("browser platform\n", (project / "native-client/platform.txt").read_text())
        self.assertEqual("ahead-window=8\n", (project / "native-client/browser-network.txt").read_text())
        self.assertEqual(before, self.update.stable_identity())
        candidate = SOURCE.NativeSource(project)
        candidate.check()
        expected = SOURCE.inventory(project / "native-client")
        shutil.rmtree(project / "native-client")
        with contextlib.redirect_stdout(io.StringIO()):
            candidate.sync()
        self.assertEqual(expected, SOURCE.inventory(project / "native-client"))

    def test_three_way_adaptation_conflict_keeps_stable(self):
        before = self.update.stable_identity()
        self.write(self.mirror / "platform.txt", "upstream platform replacement\n")
        self.commit(self.mirror, "conflicting upstream platform")
        self.new_upstream = self.revision(self.mirror)
        with self.assertRaisesRegex(RuntimeError, "adaptation merge conflicts"):
            self.stage()
        self.assertEqual(before, self.update.stable_identity())
        manifest = json.loads(next(self.update.home.glob("*/candidate.json")).read_text())
        self.assertEqual("conflict", manifest["status"])
        self.assertTrue((self.update.home / manifest["candidate"] / "adaptation-merge.txt").is_file())

    def test_integrated_customisation_conflict_keeps_stable(self):
        UPDATE.git(self.mirror, "checkout", "--quiet", "--detach", self.old_upstream)
        self.write(self.mirror / "local-branding.txt", "upstream branding\n")
        self.commit(self.mirror, "conflicting upstream addition")
        self.new_upstream = self.revision(self.mirror)
        before = self.update.stable_identity()
        with self.assertRaisesRegex(RuntimeError, "upstream merge conflicts"):
            self.stage()
        self.assertEqual(before, self.update.stable_identity())

    def test_failed_gate_cannot_promote_or_change_stable(self):
        manifest = self.stage()
        before = self.update.stable_identity()
        with self.assertRaisesRegex(RuntimeError, "deliberately failed"):
            self.fixture_validation(manifest, fail=True)
        with self.assertRaisesRegex(RuntimeError, "automatic gates"):
            self.update.promote(manifest["candidate"], self.runtime(manifest))
        self.assertEqual(before, self.update.stable_identity())

    def test_successful_validation_promotion_and_new_patch_replay(self):
        manifest = self.stage()
        self.fixture_validation(manifest)
        result = self.update.promote(manifest["candidate"], self.runtime(manifest))
        self.assertTrue(result["promoted"])
        self.assertEqual("speed=2\narmor=1\n", (self.output / "rules.txt").read_text())
        self.assertEqual("王二火大\n", (self.output / "local-branding.txt").read_text())
        source = SOURCE.NativeSource(self.root)
        source.check()
        source.verify_baseline()
        expected = SOURCE.inventory(self.output)
        shutil.rmtree(self.output)
        with contextlib.redirect_stdout(io.StringIO()):
            source.sync()
        self.assertEqual(expected, SOURCE.inventory(self.output))

    def test_partial_promotion_rolls_back_source_and_all_locks(self):
        manifest = self.stage()
        self.fixture_validation(manifest)
        before = self.update.stable_identity()
        def fault(point):
            if point == "after-lock:native-source.lock.json":
                raise RuntimeError("simulated promotion failure")
        with self.assertRaisesRegex(RuntimeError, "simulated promotion failure"):
            self.update.promote(manifest["candidate"], self.runtime(manifest), fault=fault)
        self.assertEqual(before, self.update.stable_identity())
        SOURCE.NativeSource(self.root).check()
        receipt = json.loads((self.update.candidate(manifest["candidate"]) / "promotion.json").read_text())
        self.assertEqual("rolled-back", receipt["state"])

    def test_drift_tampering_and_wrong_runtime_identity_rejected(self):
        manifest = self.stage()
        self.fixture_validation(manifest)
        runtime = self.runtime(manifest)
        value = json.loads(runtime.read_text())
        value["sourceIdentity"]["source"] = "0" * 64
        runtime.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, "runtime receipt"):
            self.update.promote(manifest["candidate"], runtime)
        self.write(self.output / "rules.txt", "unrecorded newer work\n")
        with self.assertRaisesRegex(RuntimeError, "unrecorded native-client edits"):
            self.update.validate(manifest["candidate"])
        self.assertEqual("unrecorded newer work\n", (self.output / "rules.txt").read_text())

    def test_dirty_project_and_external_candidate_paths_rejected(self):
        self.write(self.root / "host.py", "uncommitted host work\n")
        with self.assertRaisesRegex(RuntimeError, "git diff failed"):
            self.stage()
        with self.assertRaisesRegex(RuntimeError, "invalid candidate ID"):
            self.update.candidate("../../another-project")

    def test_candidate_edit_and_validation_log_tampering_rejected(self):
        manifest = self.stage()
        self.fixture_validation(manifest)
        directory = self.update.candidate(manifest["candidate"])
        (directory / "validate-fixture-real-command.log").write_text("changed after validation")
        with self.assertRaisesRegex(RuntimeError, "validation log changed"):
            self.update.promote(manifest["candidate"], self.runtime(manifest))
        self.write(directory / "project/native-client/rules.txt", "speed=999\n")
        with self.assertRaisesRegex(RuntimeError, "candidate source or locks changed"):
            self.update.validate(manifest["candidate"])

    def test_host_gate_uses_shared_owned_cargo_cache(self):
        shared = self.root / ".build/cargo"
        shared.mkdir()
        manifest = self.stage()
        self.fixture_validation(manifest)
        project = self.update.candidate(manifest["candidate"]) / "project"
        self.assertTrue((project / ".build/cargo").is_symlink())
        self.assertEqual("candidate compiled artifact", (shared / "native-update-fixture-artifact").read_text())
        self.assertFalse((project / "native-client/target").exists())

    def test_recovery_preserves_new_lock_edits_after_interruption(self):
        manifest = self.stage()
        self.fixture_validation(manifest)
        def fault(point):
            if point == "after-source-backup":
                # A concurrent edit after the transaction started must not be
                # silently replaced during automatic recovery.
                self.write(self.root / SOURCE.PATCH_PATH, "new work after interruption")
                raise RuntimeError("interrupted")
        with self.assertRaisesRegex(RuntimeError, "lock changed after promotion interruption"):
            self.update.promote(manifest["candidate"], self.runtime(manifest), fault=fault)
        self.assertEqual("new work after interruption", (self.root / SOURCE.PATCH_PATH).read_text())
        directory = self.update.candidate(manifest["candidate"])
        self.assertTrue((directory / "stable-backup/native-client").is_dir())
        with self.assertRaisesRegex(RuntimeError, "interrupted promotion exists"):
            with self.update.exclusive():
                pass

    @staticmethod
    def prune(repo):
        UPDATE.git(repo, "reflog", "expire", "--expire=now", "--all")
        UPDATE.git(repo, "gc", "--prune=now")

    def test_candidate_and_stable_baselines_survive_actual_git_gc(self):
        manifest = self.stage()
        directory = self.update.candidate(manifest["candidate"])
        project = directory / "project"
        candidate_repo = project / ".build/vera-upstream"
        self.prune(self.mirror)
        self.prune(candidate_repo)
        candidate_source = SOURCE.NativeSource(project)
        candidate_source.verify_baseline()
        self.assertEqual(manifest["candidateRevision"], self.revision_for(
            candidate_repo, UPDATE.retention_ref("candidates", manifest["candidateRevision"])))
        with contextlib.redirect_stdout(io.StringIO()):
            candidate_source.record()
        candidate_source.check()
        # Re-recording the unchanged candidate must retain the exact source
        # identity, otherwise this also invalidates the acceptance binding.
        self.assertEqual(manifest["sourceIdentity"], self.update.candidate_identity(project))
        self.fixture_validation(manifest)
        self.update.promote(manifest["candidate"], self.runtime(manifest))
        self.prune(self.mirror)
        # Remove the candidate object store too: stable source must now own all
        # imported baseline objects rather than depending on its old alternate.
        shutil.rmtree(candidate_repo)
        stable = SOURCE.NativeSource(self.root)
        stable.verify_baseline()
        self.assertEqual(self.integrated, self.revision_for(
            self.mirror, UPDATE.retention_ref("baselines", self.integrated)))
        self.assertEqual(manifest["integratedRevision"], self.revision_for(
            self.mirror, UPDATE.retention_ref("baselines", manifest["integratedRevision"])))
        with contextlib.redirect_stdout(io.StringIO()):
            stable.record()
        expected = SOURCE.inventory(self.output)
        shutil.rmtree(self.output)
        with contextlib.redirect_stdout(io.StringIO()):
            stable.sync()
        self.assertEqual(expected, SOURCE.inventory(self.output))
        stable.check()

    @staticmethod
    def revision_for(repo, ref):
        return UPDATE.git(repo, "rev-parse", ref + "^{commit}").stdout.decode().strip()


if __name__ == "__main__":
    unittest.main()
