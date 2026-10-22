#!/usr/bin/env python3
"""Build/check deterministic, unactivated Toy resource shards without auth.

The original catalog, compressed objects, native WASM and source trees are read
only. Each upload ZIP contains a real resource inspection/checksum tool and a
subset of immutable gzip bytes. Activation belongs to a separate reviewed step.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "tools/templates/resource-shard-index.html"
PART_BYTES = 16_000_000
PACK_PART_BYTES = 48_000_000
MAX_ZIP_BYTES = 50_000_000
KIND = "werhd-toy-resource-upload-plan"
SHA = re.compile(r"^[a-f0-9]{64}$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hash_file(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def catalog_identity(catalog):
    return digest(json.dumps({k: v for k, v in catalog.items() if k != "catalogIdentity"},
                             ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())


def positive_size(value, label):
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError("invalid " + label)
    return value


def collect_objects(catalog, source_plan):
    if (catalog.get("schema") != 2 or catalog.get("defaultProfile") != "skirmish"
            or catalog.get("catalogIdentity") != catalog_identity(catalog)
            or source_plan.get("catalogIdentity") != catalog["catalogIdentity"]
            or source_plan.get("requiredResourceIdentity") != catalog.get("identity")):
        raise ValueError("catalog/private source plan identity mismatch")
    by_sha = {record["sha256"]: record for record in source_plan["objects"]}
    if len(by_sha) != len(source_plan["objects"]):
        raise ValueError("duplicate immutable source object")
    records = {}

    def include(file, group):
        wire = file.get("download", {})
        if (wire.get("encoding") != "gzip" or not SHA.fullmatch(wire.get("sha256", ""))
                or wire.get("url") != "/content/objects/" + wire["sha256"]
                or not SHA.fullmatch(file.get("sha256", ""))):
            raise ValueError("resource must retain its original gzip/raw identities")
        positive_size(wire.get("bytes"), "wire size")
        positive_size(file.get("bytes"), "raw size")
        source = by_sha.get(wire["sha256"])
        if not source or source.get("bytes") != wire["bytes"] or source.get("contentType") != "application/gzip":
            raise ValueError("gzip object missing from private source plan")
        record = {"wireSha256": wire["sha256"], "wireBytes": wire["bytes"],
                  "rawSha256": file["sha256"], "rawBytes": file["bytes"],
                  "source": str(Path(source["path"]).resolve()), "names": [], "groups": [], "parts": []}
        old = records.setdefault(wire["sha256"], record)
        if any(old[key] != record[key] for key in ("wireBytes", "rawSha256", "rawBytes", "source")):
            raise ValueError("one wire identity has conflicting content")
        if file["name"] not in old["names"]:
            old["names"].append(file["name"])
        if group not in old["groups"]:
            old["groups"].append(group)

    # Insertion order is a contract: every required object precedes additions.
    for file in catalog["files"]:
        include(file, "skirmish")
    for name in sorted(catalog["packs"]):
        for file in catalog["packs"][name]["files"]:
            include(file, "addon:" + name)
    for name in sorted(catalog["profiles"]):
        for file in catalog["profiles"][name]["files"]:
            include(file, "profile:" + name)
    return list(records.values())


class MultipartReader(io.RawIOBase):
    """Sequential checked file reader; gzip never allocates the full archive."""
    def __init__(self, output, parts):
        self.output, self.parts = output, iter(parts)
        self.current = None
        self.part = None
        self.part_hash = None
        self.part_size = 0
        self.wire_hash = hashlib.sha256()
        self.wire_size = 0

    def readable(self):
        return True

    def readinto(self, buffer):
        while True:
            if self.current is None:
                try:
                    self.part = next(self.parts)
                except StopIteration:
                    return 0
                target = self.output / self.part["packId"] / "v2" / self.part["path"]
                if target.is_symlink() or not target.is_file():
                    raise ValueError("missing or symlinked generated part")
                self.current = target.open("rb")
                self.part_hash, self.part_size = hashlib.sha256(), 0
            count = self.current.readinto(buffer)
            if count:
                data = memoryview(buffer)[:count]
                self.part_hash.update(data)
                self.wire_hash.update(data)
                self.part_size += count
                self.wire_size += count
                if self.part_size > self.part["bytes"]:
                    raise ValueError("generated part size differs")
                return count
            self.current.close()
            self.current = None
            if self.part_size != self.part["bytes"] or self.part_hash.hexdigest() != self.part["sha256"]:
                raise ValueError("generated part SHA/length differs")

    def close(self):
        if self.current:
            self.current.close()
            self.current = None
        super().close()


def validate_object(output, record):
    offset = 0
    for part in record["parts"]:
        if (part["offset"] != offset or part["wireSha256"] != record["wireSha256"]
                or part["wireBytes"] != record["wireBytes"] or part["bytes"] > PART_BYTES
                or part["path"] != "parts/" + part["sha256"] + ".bin"
                or not SHA.fullmatch(part["sha256"])):
            raise ValueError("part coverage/identity differs")
        positive_size(part["bytes"], "part length")
        offset += part["bytes"]
    if offset != record["wireBytes"]:
        raise ValueError("incomplete wire coverage")
    raw_hash, raw_size = hashlib.sha256(), 0
    with MultipartReader(output, record["parts"]) as source:
        with io.BufferedReader(source, 1024 * 1024) as buffered:
            with gzip.GzipFile(fileobj=buffered, mode="rb") as decompressed:
                for data in iter(lambda: decompressed.read(1024 * 1024), b""):
                    raw_size += len(data)
                    if raw_size > record["rawBytes"]:
                        raise ValueError("raw resource expands beyond its catalog length")
                    raw_hash.update(data)
            # Complete EOF validation, including the last piece's size/SHA.
            while buffered.read(1024 * 1024):
                pass
            if source.wire_size != record["wireBytes"] or source.wire_hash.hexdigest() != record["wireSha256"]:
                raise ValueError("reconstructed wire SHA/length differs")
    if raw_size != record["rawBytes"] or raw_hash.hexdigest() != record["rawSha256"]:
        raise ValueError("reconstructed raw SHA/length differs")


def write_zip(directory, target):
    with zipfile.ZipFile(target, "w") as archive:
        for file in sorted(directory.rglob("*")):
            if file.is_symlink():
                raise ValueError("ZIP symlink rejected")
            if not file.is_file():
                continue
            info = zipfile.ZipInfo(file.relative_to(directory).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            # Binary parts are already gzip compressed. A stored outer member
            # preserves those bytes, avoids recompression work and bounds size.
            info.compress_type = zipfile.ZIP_STORED if file.suffix == ".bin" else zipfile.ZIP_DEFLATED
            with file.open("rb") as source, archive.open(info, "w") as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)


def validate(output, plan=None):
    output = Path(output).resolve()
    plan = plan or json.loads((output / "plan.json").read_text())
    if (plan.get("schema") != 1 or plan.get("kind") != KIND or plan.get("enabled") is not False
            or not SHA.fullmatch(plan.get("catalogIdentity", ""))
            or not SHA.fullmatch(plan.get("requiredResourceIdentity", ""))):
        raise ValueError("invalid/unreviewed staged plan")
    catalog_path = Path(plan["catalogPath"])
    catalog = json.loads(catalog_path.read_text())
    if (hash_file(catalog_path) != plan["catalogSha256"]
            or catalog_identity(catalog) != plan["catalogIdentity"]
            or catalog.get("identity") != plan["requiredResourceIdentity"]):
        raise ValueError("resource catalog changed after the shard build")
    seen_packs = set()
    public_parts = {}
    for pack in plan["packs"]:
        pack_id = pack["packId"]
        if not re.fullmatch(r"pack-[0-9]{3}", pack_id) or pack_id in seen_packs:
            raise ValueError("invalid/duplicate resource pack id")
        seen_packs.add(pack_id)
        directory, archive = output / pack_id, output / (pack_id + ".zip")
        manifest_path = directory / "v2/manifest.json"
        manifest = json.loads(manifest_path.read_text())
        if manifest != {"schema": 1, "kind": "werhd-resource-shard", "catalogIdentity": plan["catalogIdentity"],
                        "requiredResourceIdentity": plan["requiredResourceIdentity"], "packId": pack_id, "parts": pack["parts"]}:
            raise ValueError("public shard manifest differs from private plan")
        if hash_file(manifest_path) != pack["manifestSha256"]:
            raise ValueError("public shard manifest SHA differs")
        if (archive.is_symlink() or archive.stat().st_size != pack["zipBytes"]
                or archive.stat().st_size >= plan["maxZipBytes"] or archive.stat().st_size >= MAX_ZIP_BYTES
                or hash_file(archive) != pack["zipSha256"]):
            raise ValueError("upload ZIP SHA/size differs or exceeds strict limit")
        expected_files = {"index.html", "v2/manifest.json"} | {"v2/" + p["path"] for p in pack["parts"]}
        with zipfile.ZipFile(archive) as zipped:
            if set(zipped.namelist()) != expected_files or len(zipped.namelist()) != len(expected_files):
                raise ValueError("ZIP file set differs from manifest")
            if zipped.testzip() is not None:
                raise ValueError("ZIP CRC check failed")
            if len(zipped.read("index.html")) >= 1_000_000:
                raise ValueError("Toy entry HTML exceeds platform limit")
            for info in zipped.infolist():
                if not info.filename.endswith(".bin") and b"vera20k" in zipped.read(info.filename).lower():
                    raise ValueError("retired source name in public package")
                with zipped.open(info) as member:
                    result = hashlib.sha256()
                    for data in iter(lambda: member.read(1024 * 1024), b""):
                        result.update(data)
                if result.hexdigest() != hash_file(directory / info.filename):
                    raise ValueError("ZIP member differs from served file")
        for part in pack["parts"]:
            key = (pack_id, part["wireSha256"], part["offset"])
            if key in public_parts:
                raise ValueError("duplicate public part")
            public_parts[key] = part
    for obj in plan["objects"]:
        for part in obj["parts"]:
            public = {k: v for k, v in part.items() if k != "packId"}
            if public_parts.pop((part["packId"], part["wireSha256"], part["offset"]), None) != public:
                raise ValueError("private object part absent from public shards")
        validate_object(output, obj)
    if public_parts:
        raise ValueError("unreferenced public parts")
    if {s["packId"] for s in plan["stagedSources"]} != seen_packs or any(
            s.get("enabled") is not False or s.get("baseUrl") is not None for s in plan["stagedSources"]):
        raise ValueError("staged source was activated without review")
    return {"ok": True, "catalogIdentity": plan["catalogIdentity"], "packs": len(plan["packs"]),
            "objects": len(plan["objects"]), "parts": sum(len(p["parts"]) for p in plan["packs"]),
            "wireBytes": sum(o["wireBytes"] for o in plan["objects"]),
            "zipBytes": sum(p["zipBytes"] for p in plan["packs"]),
            "maxActualZipBytes": max(p["zipBytes"] for p in plan["packs"]),
            "sourceSwitchEnabled": False}


def build(root=ROOT, output=None, *, part_bytes=PART_BYTES, pack_part_bytes=PACK_PART_BYTES,
          max_zip_bytes=MAX_ZIP_BYTES, replace=False):
    root = Path(root).resolve()
    output = Path(output or root / "dist/toy-resources").resolve()
    if not output.is_relative_to(root / "dist") or output == root / "dist":
        raise ValueError("resource output must be an owned child of dist/")
    if (positive_size(part_bytes, "part limit") > PART_BYTES
            or positive_size(pack_part_bytes, "pack part limit") > PACK_PART_BYTES
            or part_bytes > pack_part_bytes or positive_size(max_zip_bytes, "ZIP limit") > MAX_ZIP_BYTES):
        raise ValueError("resource limits exceed the upload contract")
    if output.exists():
        if output.is_symlink() or not replace:
            raise ValueError("output exists; check it or rebuild with explicit --replace")
        old_plan = output / "plan.json"
        if not old_plan.is_file() or json.loads(old_plan.read_text()).get("kind") != KIND:
            raise ValueError("refusing to replace an unowned output directory")
    catalog_path, source_path = root / "public/native-content/catalog.json", root / ".build/native-content/plan.json"
    catalog, sources = json.loads(catalog_path.read_text()), json.loads(source_path.read_text())
    objects = collect_objects(catalog, sources)
    build_root = root / ".build"
    build_root.mkdir(exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="toy-resource-shards-", dir=build_root) as temporary:
        stage = Path(temporary) / "output"
        stage.mkdir()
        packs = []
        for obj in objects:
            source = Path(obj["source"])
            if source.is_symlink() or not source.is_file() or source.stat().st_size != obj["wireBytes"]:
                raise ValueError("original gzip object has changed")
            offset, wire_hash = 0, hashlib.sha256()
            with source.open("rb") as stream:
                for data in iter(lambda: stream.read(part_bytes), b""):
                    wire_hash.update(data)
                    pack = next((p for p in packs if p["partBytes"] + len(data) <= pack_part_bytes), None)
                    if pack is None:
                        pack_id = f"pack-{len(packs) + 1:03}"
                        pack = {"packId": pack_id, "partBytes": 0, "parts": []}
                        packs.append(pack)
                    part_hash = digest(data)
                    public = {"wireSha256": obj["wireSha256"], "wireBytes": obj["wireBytes"],
                              "offset": offset, "bytes": len(data), "sha256": part_hash,
                              "path": "parts/" + part_hash + ".bin"}
                    target = stage / pack["packId"] / "v2" / public["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists() and target.read_bytes() != data:
                        raise ValueError("SHA file collision")
                    target.write_bytes(data)
                    pack["parts"].append(public)
                    pack["partBytes"] += len(data)
                    obj["parts"].append({"packId": pack["packId"], **public})
                    offset += len(data)
            if offset != obj["wireBytes"] or wire_hash.hexdigest() != obj["wireSha256"]:
                raise ValueError("original gzip object SHA differs")
        labels = {o["wireSha256"]: o["names"] for o in objects}
        template = TEMPLATE.read_text()
        for index, pack in enumerate(packs, 1):
            pack_id, directory = pack["packId"], stage / pack["packId"]
            manifest = {"schema": 1, "kind": "werhd-resource-shard", "catalogIdentity": catalog["catalogIdentity"],
                        "requiredResourceIdentity": catalog["identity"], "packId": pack_id, "parts": pack["parts"]}
            manifest_path = directory / "v2/manifest.json"
            manifest_path.write_bytes(json_bytes(manifest))
            pack_labels = {"packId": pack_id, "catalogIdentity": catalog["catalogIdentity"],
                           "names": {p["wireSha256"]: labels[p["wireSha256"]] for p in pack["parts"]}}
            substitutions = {"PACK_ID": pack_id, "PACK_NUMBER": str(index), "PACK_COUNT": str(len(packs)),
                             "PART_BYTES": f"{pack['partBytes']:,}", "CATALOG_ID": catalog["catalogIdentity"],
                             "LABELS_JSON": json.dumps(pack_labels, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")}
            html = template
            for name, text in substitutions.items():
                html = html.replace("@@" + name + "@@", text)
            if re.search(r"@@[A-Z_]+@@", html):
                raise ValueError("unfilled resource page template")
            (directory / "index.html").write_text(html)
            archive = stage / (pack_id + ".zip")
            write_zip(directory, archive)
            pack.update({"directory": str(output / pack_id), "zip": str(output / archive.name),
                         "zipBytes": archive.stat().st_size, "zipSha256": hash_file(archive),
                         "manifestSha256": hash_file(manifest_path)})
        plan = {"schema": 1, "kind": KIND, "enabled": False, "catalogIdentity": catalog["catalogIdentity"],
                "requiredResourceIdentity": catalog["identity"], "partBytes": part_bytes,
                "maxPackPartBytes": pack_part_bytes, "maxZipBytes": max_zip_bytes,
                "catalogPath": str(catalog_path), "catalogSha256": hash_file(catalog_path),
                "templateSha256": hash_file(TEMPLATE), "packs": packs, "objects": objects,
                "stagedSources": [{"packId": p["packId"], "enabled": False, "baseUrl": None,
                                   "manifestPath": "v2/manifest.json"} for p in packs]}
        (stage / "plan.json").write_bytes(json_bytes(plan))
        proof = validate(stage, plan)
        (stage / "validation.json").write_bytes(json_bytes(proof))
        if hash_file(catalog_path) != plan["catalogSha256"]:
            raise ValueError("catalog changed during shard build")
        if output.exists():
            shutil.rmtree(output)
        shutil.move(str(stage), output)
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "check"])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--part-bytes", type=int, default=PART_BYTES)
    parser.add_argument("--pack-part-bytes", type=int, default=PACK_PART_BYTES)
    parser.add_argument("--max-zip-bytes", type=int, default=MAX_ZIP_BYTES)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    if args.action == "build":
        proof = build(args.root, args.output, part_bytes=args.part_bytes, pack_part_bytes=args.pack_part_bytes,
                      max_zip_bytes=args.max_zip_bytes, replace=args.replace)
    else:
        proof = validate(args.output or args.root / "dist/toy-resources")
    print(json.dumps(proof, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
