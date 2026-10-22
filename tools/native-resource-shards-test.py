#!/usr/bin/env python3
"""Small independent fixtures for Toy resource roundtrip and corruption gates."""
import gzip
import importlib.util
import json
from pathlib import Path
import random
import tempfile
import unittest

MODULE = Path(__file__).with_name("package-native-resource-shards.py")
SPEC = importlib.util.spec_from_file_location("resource_shards", MODULE)
shards = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shards)


class ResourceShardTests(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        content = root / "public/native-content"
        objects = root / ".build/native-content/objects"
        content.mkdir(parents=True)
        objects.mkdir(parents=True)
        files, planned = [], []
        randomizer = random.Random(20261023)
        for i, length in enumerate([5100, 4600, 2100]):
            raw = bytes(randomizer.randrange(256) for _ in range(length))
            wire = gzip.compress(raw, mtime=0)
            wire_sha, raw_sha = shards.digest(wire), shards.digest(raw)
            source = objects / wire_sha
            source.write_bytes(wire)
            files.append({"name": f"fixture{i}.mix", "bytes": len(raw), "sha256": raw_sha,
                          "url": "/content/objects/" + raw_sha,
                          "download": {"bytes": len(wire), "sha256": wire_sha, "encoding": "gzip",
                                       "url": "/content/objects/" + wire_sha}})
            planned.append({"sha256": wire_sha, "bytes": len(wire), "path": str(source), "contentType": "application/gzip"})
        identity = shards.digest(b"fixture-required-identity")
        catalog = {"schema": 2, "defaultProfile": "skirmish", "identity": identity, "files": files[:2],
                   "packs": {"cinematics": {"files": files[2:]}},
                   "profiles": {"full": {"files": files}, "skirmish": {"files": files[:2]}}}
        catalog["catalogIdentity"] = shards.catalog_identity(catalog)
        (content / "catalog.json").write_bytes(shards.json_bytes(catalog))
        (objects.parent / "plan.json").write_bytes(shards.json_bytes({"catalogIdentity": catalog["catalogIdentity"],
            "requiredResourceIdentity": identity, "objects": planned}))
        return root, catalog, planned

    def build_fixture(self, root, **options):
        return shards.build(root, part_bytes=1280, pack_part_bytes=3840, **options)

    def test_default_and_optional_roundtrip_preserves_catalog_and_has_deterministic_uploads(self):
        root, catalog, _ = self.fixture()
        catalog_before = (root / "public/native-content/catalog.json").read_bytes()
        proof = self.build_fixture(root)
        output = root / "dist/toy-resources"
        plan = json.loads((output / "plan.json").read_text())
        self.assertEqual(proof["objects"], 3)
        self.assertGreater(proof["packs"], 1)
        self.assertGreater(proof["parts"], proof["objects"])
        self.assertLess(proof["maxActualZipBytes"], 50_000_000)
        self.assertFalse(proof["sourceSwitchEnabled"])
        self.assertEqual(plan["objects"][0]["names"], ["fixture0.mix"])
        self.assertEqual(plan["objects"][1]["names"], ["fixture1.mix"])
        self.assertEqual(plan["objects"][2]["names"], ["fixture2.mix"])
        for source in plan["stagedSources"]:
            self.assertFalse(source["enabled"])
            self.assertIsNone(source["baseUrl"])
        before = [p["zipSha256"] for p in plan["packs"]]
        self.build_fixture(root, replace=True)
        after = json.loads((output / "plan.json").read_text())
        self.assertEqual(before, [p["zipSha256"] for p in after["packs"]])
        self.assertEqual(catalog_before, (root / "public/native-content/catalog.json").read_bytes())
        self.assertEqual(catalog["catalogIdentity"], after["catalogIdentity"])
        self.assertTrue(shards.validate(output)["ok"])

    def test_source_corruption_and_incomplete_generated_parts_are_rejected(self):
        root, _, planned = self.fixture()
        self.build_fixture(root)
        output = root / "dist/toy-resources"
        plan = json.loads((output / "plan.json").read_text())
        part = plan["objects"][0]["parts"][0]
        file = output / part["packId"] / "v2" / part["path"]
        data = file.read_bytes()
        file.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        with self.assertRaises((ValueError, gzip.BadGzipFile, EOFError)):
            shards.validate_object(output, plan["objects"][0])
        with self.assertRaises(ValueError):
            shards.validate(output)
        source = Path(planned[0]["path"])
        wire = source.read_bytes()
        source.write_bytes(wire[:-1] + bytes([wire[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, "source|original gzip"):
            self.build_fixture(root, replace=True)

    def test_zip_size_checks_actual_archive_and_never_promotes_invalid_output(self):
        root, _, _ = self.fixture()
        with self.assertRaisesRegex(ValueError, "ZIP SHA/size"):
            self.build_fixture(root, max_zip_bytes=1000)
        self.assertFalse((root / "dist/toy-resources").exists())

    def test_check_rejects_a_new_catalog_after_packages_were_built(self):
        root, _, _ = self.fixture()
        self.build_fixture(root)
        catalog = root / "public/native-content/catalog.json"
        value = json.loads(catalog.read_text())
        value["files"][0]["name"] = "different.mix"
        catalog.write_bytes(shards.json_bytes(value))
        with self.assertRaisesRegex(ValueError, "catalog changed"):
            shards.validate(root / "dist/toy-resources")

    def test_limits_and_unowned_output_are_rejected(self):
        root, _, _ = self.fixture()
        with self.assertRaisesRegex(ValueError, "limits"):
            shards.build(root, part_bytes=16_000_001)
        foreign = root / "dist/unrelated"
        foreign.mkdir(parents=True)
        (foreign / "keep.txt").write_text("unrelated")
        with self.assertRaisesRegex(ValueError, "unowned"):
            shards.build(root, foreign, replace=True)
        self.assertEqual((foreign / "keep.txt").read_text(), "unrelated")


if __name__ == "__main__":
    unittest.main()
