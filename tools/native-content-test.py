#!/usr/bin/env python3
"""Small synthetic tests; no retail/Cargo/network mutation or external modules."""
import gzip
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location("native_content", Path(__file__).with_name("native-content.py"))
content = importlib.util.module_from_spec(spec)
spec.loader.exec_module(content)


def mix(entries, classic=False):
    body = b"".join(payload for _, payload in entries)
    header = struct.pack("<HI", len(entries), len(body)) if classic else struct.pack("<HHHI", 0, 0, len(entries), len(body))
    index, offset = b"", 0
    for entry_id, payload in entries:
        index += struct.pack("<III", entry_id, offset, len(payload))
        offset += len(payload)
    return header + index + body


class ContentTests(unittest.TestCase):
    def test_blowfish_published_vector(self):
        cipher = content.Blowfish(bytes(8))
        self.assertEqual(struct.pack(">II", *cipher.encrypt(0, 0)).hex(), "4ef997456198dd78")
        self.assertEqual(cipher.decrypt(bytes.fromhex("4ef997456198dd78")), bytes(8))

    def test_named_hash_case_and_padding(self):
        self.assertEqual(content.mix_hash("audio.mix"), content.mix_hash("AUDIO.MIX"))
        self.assertEqual(content.mix_hash("rules.ini"), zlib.crc32(b"RULES.INI\x01II"))

    def test_plain_and_classic_metadata_order(self):
        entries = [(0xffffffff, b"metadata"), (5, b"first"), (3, b"last")]
        for classic in (False, True):
            archive = content.MixArchive(content.View(mix(entries, classic)))
            self.assertEqual([(e.id, e.view.read()) for e in archive.entries], entries)

    def test_encrypted_index_and_checksum_header(self):
        # RSA zero block derives the 56-byte zero key, giving a synthetic but
        # fully encrypted new-format archive without external crypto packages.
        body = b"unchanged payload"
        index = struct.pack("<HIIII", 1, len(body), 0x92345678, 0, len(body))
        index += bytes((-len(index)) % 8)
        cipher = content.Blowfish(bytes(56))
        encrypted = b"".join(struct.pack(">II", *cipher.encrypt(*struct.unpack_from(">II", index, n)))
                             for n in range(0, len(index), 8))
        data = struct.pack("<HH", 0, 3) + bytes(80) + encrypted + body + bytes(20)
        archive = content.MixArchive(content.View(data))
        self.assertEqual(archive.entries[0].id, 0x92345678)
        self.assertEqual(archive.entries[0].view.read(), body)
        with self.assertRaises(ValueError):
            content.MixArchive(content.View(data[:90]))

    def test_nested_cannot_escape_parent(self):
        archive = mix([(1, b"abc")])
        surrounded = b"prefix" + archive + b"outside-parent" * 20
        # Entry's size fits physical file but not nested MIX's declared body.
        corrupt = bytearray(archive)
        struct.pack_into("<I", corrupt, 18, 20)
        with self.assertRaisesRegex(ValueError, "declared body"):
            content.MixArchive(content.View(bytes(corrupt) + surrounded, length=len(corrupt)))
        with self.assertRaises(ValueError):
            content.View(surrounded, 6, len(archive)).sub(len(archive) - 1, 8, "escape")

    def test_truncated_and_unknown_header(self):
        for data in (b"", bytes(5), struct.pack("<HHHI", 0, 4, 0, 0), mix([(2, b"a")])[:-1],
                     struct.pack("<HH", 0, 2) + bytes(79)):
            with self.assertRaises(ValueError):
                content.MixArchive(content.View(data))

    def test_ambiguous_duplicate_id_rejected(self):
        with self.assertRaisesRegex(ValueError, "ambiguous duplicate"):
            content.MixArchive(content.View(mix([(1, b"a"), (1, b"b")])))

    def test_language_filter_and_repack_preserve_retained_bytes(self):
        audio = mix([(content.mix_hash("audio.idx"), b"index"), (content.mix_hash("audio.bag"), b"samples")])
        entries = [(9, b"unknown-metadata"), (content.mix_hash("audio.mix"), audio),
                   (10, b"BIKmovie"), (11, b"not-BIK"), (12, b"B"), (13, b"BI")]
        archive = content.MixArchive(content.View(mix(entries)))
        selected, removed = content.language_selection(archive, "language.mix")
        self.assertEqual([e.id for e in selected], [9, 11, 12, 13])
        self.assertEqual([r["reason"] for r in removed], ["unselected-base-audio-audiomd-present", "confirmed-bik-payload"])
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "derived.mix"
            content.repack(archive, selected, target)
            output = content.MixArchive(content.View(target.read_bytes()))
            self.assertEqual([(e.id, e.sha()) for e in output.entries], [(e.id, e.sha()) for e in selected])
        md_selected, _ = content.language_selection(archive, "langmd.mix")
        self.assertIn(content.mix_hash("audio.mix"), [e.id for e in md_selected])

    def test_audio_hash_alone_is_insufficient_to_remove_payload(self):
        archive = content.MixArchive(content.View(mix([(content.mix_hash("audio.mix"), b"not-an-audio-archive")])))
        with self.assertRaises(ValueError):
            content.language_selection(archive, "language.mix")

    def test_first_winner_proof_detects_optional_override(self):
        required = content.MixArchive(content.View(mix([(1, b"real-unit"), (2, b"rules")])) )
        compatible = content.MixArchive(content.View(mix([(1, b"real-unit"), (2, b"rules"), (3, b"movie")])) )
        winners = lambda archive: {e.id: ("archive", e) for e in archive.entries}
        self.assertEqual(content.compare_winners(winners(required), winners(compatible), "synthetic")["mismatches"], 0)
        incompatible = content.MixArchive(content.View(mix([(1, b"changed-unit"), (2, b"rules")])) )
        with self.assertRaisesRegex(ValueError, "winner mismatch"):
            content.compare_winners(winners(required), winners(incompatible), "synthetic")

    def test_resource_identity_ignores_download_and_order(self):
        a = {"name": "a.mix", "bytes": 3, "sha256": "a" * 64, "download": {"url": "cdn"}}
        b = {"name": "b.mix", "bytes": 7, "sha256": "b" * 64}
        identity = content.resource_identity([a, b])
        self.assertEqual(identity, content.resource_identity([b, {k: v for k, v in a.items() if k != "download"}]))
        self.assertNotEqual(identity, content.resource_identity([a, {**b, "sha256": "c" * 64}]))

    def test_canonical_recursive_sort_utf8(self):
        self.assertEqual(content.canonical({"z": [{"b": 2, "a": "汉"}], "a": 1}),
                         '{"a":1,"z":[{"a":"汉","b":2}]}'.encode())

    def test_gzip_deterministic_and_validated_raw(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            source = folder / "source"
            data = b"unchanged retail bytes" * 6000
            source.write_bytes(data)
            first = content.gzip_object(source, folder)
            second = content.gzip_object(source, folder)
            self.assertEqual(first, second)
            encoded = Path(first["path"]).read_bytes()
            self.assertEqual(encoded[:10], bytes.fromhex("1f8b08000000000000ff"))
            self.assertEqual(gzip.decompress(encoded), data)
            self.assertEqual(content.sha_bytes(encoded), first["sha256"])

    def test_whitelist_default_count_and_no_movie_guessing(self):
        required = set(content.SOURCE_NAMES) - content.EXCLUDED
        self.assertEqual(len(content.SOURCE_NAMES), 32)
        self.assertEqual(len(required), 26)
        self.assertIn("ra2.mix", required)
        self.assertIn("ra2md.mix", required)
        self.assertNotIn("movmd03.mix", required)
        self.assertEqual(len(content.THEATERS), 6)


if __name__ == "__main__":
    unittest.main()
