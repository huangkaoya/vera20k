#!/usr/bin/env python3
"""Reproducible, read-only retail -> startup content profiles (stdlib only).

This does not change retail files, native source, VFS rules or deployment state.
The asset manager's first-registered-archive precedence is checked separately
from archive-container identity; the optional profiles never change net identity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
ALGORITHM = "vera-native-content-v1-mix-order-gzip6-mtime0-os255"
DEFAULT_ASSET_ROOT = Path.home() / "Library/Application Support/VERA20k/retail-assets"
SOURCE_NAMES = tuple(sorted("""amazon.mmx crctbrd.yro deepfrze.yro eb1.mmx eb2.mmx eb3.mmx eb4.mmx eb5.mmx
expandmd01.mix game.exe gamemd.exe highexpr.yro ice_age.yro invasion.mmx irvinca.yro isleland.yro
langmd.mix language.mix mapsmd03.mix mojosprt.yro monsterm.yro moonpatr.yro movmd03.mix multi.mix
multimd.mix ra2.mix ra2md.mix riverram.yro sinkswim.yro thememd.mix transylv.yro unrepent.yro""".split()))
EXCLUDED = frozenset("movmd03.mix thememd.mix mapsmd03.mix game.exe gamemd.exe multi.mix".split())
THEATERS = {
    "TEMPERATE": "temperat.mix tem.mix isotemmd.mix isotemp.mix".split(),
    "SNOW": "snowmd.mix snow.mix sno.mix isosnomd.mix isosnow.mix".split(),
    "URBAN": "urban.mix urb.mix isourbmd.mix isourb.mix".split(),
    "LUNAR": "lunar.mix lun.mix isolunmd.mix isolun.mix".split(),
    "DESERT": "desert.mix des.mix isodesmd.mix isodes.mix".split(),
    "NEWURBAN": "urbann.mix ubn.mix isoubnmd.mix isoubn.mix".split(),
}
NESTED = """audio.mix audiomd.mix cache.mix cachemd.mix cameo.mix cameomd.mix cameos.mix conquer.mix conqmd.mix
des.mix desert.mix generic.mix genermd.mix isodes.mix isodesmd.mix isogen.mix isogenmd.mix isolun.mix isolunmd.mix
isosnomd.mix isosnow.mix isotemp.mix isotem.mix isotemmd.mix isourb.mix isourbmd.mix isoubn.mix isoubnmd.mix
load.mix loadmd.mix local.mix localmd.mix lun.mix lunar.mix neutral.mix ntrlmd.mix sidec01.mix sidec01md.mix
sidec02.mix sidec02md.mix sidenc01.mix sidenc02.mix sno.mix snow.mix snowmd.mix tem.mix temperat.mix
ubn.mix urb.mix urban.mix urbann.mix""".split()
CAPABILITIES = dict(campaign=False, movies=False, music=False, menuAnimation=False)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(canonical(value) + b"\n")
    temporary.replace(path)


def resource_identity(files):
    entries = [{"name": f["name"], "bytes": f["bytes"], "sha256": f["sha256"]}
               for f in sorted(files, key=lambda f: f["name"])]
    return sha_bytes(json.dumps(entries, separators=(",", ":"), ensure_ascii=False).encode())


def mix_hash(name):
    data = name.upper().encode("ascii")
    remainder = len(data) % 4
    if remainder:
        data += bytes([remainder]) + bytes([data[-remainder]]) * (3 - remainder)
    return zlib.crc32(data) & 0xffffffff


class Blowfish:
    """Same standard BE Blowfish as the pinned native parser, no pip dependency."""
    constants = None

    def __init__(self, key):
        if not 4 <= len(key) <= 56:
            raise ValueError("invalid Blowfish key length")
        if Blowfish.constants is None:
            source = (ROOT / "native-client/src/assets/blowfish.rs").read_text()
            tables = []
            for label, length in (("P", 18), ("S", 1024)):
                section = source.split("const " + label + ":", 1)[1].split("=", 1)[1].split("];", 1)[0]
                words = [int(word, 16) for word in re.findall(r"0x[0-9A-Fa-f]+", section)]
                if len(words) != length:
                    raise ValueError("native Blowfish constant table changed")
                tables.append(words)
            if tables[0][0] != 0x243f6a88 or tables[1][0] != 0xd1310ba6:
                raise ValueError("unrecognized native Blowfish constants")
            Blowfish.constants = tables
        self.p = Blowfish.constants[0][:]
        self.s = [Blowfish.constants[1][n:n + 256] for n in range(0, 1024, 256)]
        for n in range(18):
            self.p[n] ^= int.from_bytes(bytes(key[(n * 4 + j) % len(key)] for j in range(4)), "big")
        block = (0, 0)
        for n in range(0, 18, 2):
            block = self.encrypt(*block)
            self.p[n:n + 2] = block
        for box in self.s:
            for n in range(0, 256, 2):
                block = self.encrypt(*block)
                box[n:n + 2] = block

    def round(self, word):
        s = self.s
        return (((s[0][word >> 24] + s[1][word >> 16 & 255]) & 0xffffffff)
                ^ s[2][word >> 8 & 255]) + s[3][word & 255] & 0xffffffff

    def encrypt(self, left, right):
        for n in range(16):
            left ^= self.p[n]
            right ^= self.round(left)
            left, right = right, left
        return right ^ self.p[17], left ^ self.p[16]

    def decrypt(self, data):
        if len(data) % 8:
            raise ValueError("unaligned encrypted MIX index")
        out = bytearray()
        for offset in range(0, len(data), 8):
            left, right = struct.unpack_from(">II", data, offset)
            for n in range(17, 1, -1):
                left ^= self.p[n]
                right ^= self.round(left)
                left, right = right, left
            out += struct.pack(">II", right ^ self.p[0], left ^ self.p[1])
        return bytes(out)


class View:
    def __init__(self, data, offset=0, length=None, label="memory"):
        self.data, self.offset = data, offset
        self.length = len(data) - offset if length is None else length
        self.label = label
        if offset < 0 or self.length < 0 or offset + self.length > len(data):
            raise ValueError("out-of-bounds view: " + label)

    def read(self, offset=0, length=None):
        length = self.length - offset if length is None else length
        if offset < 0 or length < 0 or offset + length > self.length:
            raise ValueError("out-of-bounds read: " + self.label)
        return self.data[self.offset + offset:self.offset + offset + length]

    def sub(self, offset, length, label):
        if offset < 0 or length < 0 or offset + length > self.length:
            raise ValueError("out-of-bounds nested archive: " + label)
        return View(self.data, self.offset + offset, length, label)

    def chunks(self):
        for start in range(0, self.length, 1024 * 1024):
            yield self.read(start, min(1024 * 1024, self.length - start))

    def sha(self):
        digest = hashlib.sha256()
        for chunk in self.chunks():
            digest.update(chunk)
        return digest.hexdigest()


class Entry:
    def __init__(self, entry_id, offset, size, view):
        self.id, self.offset, self.size, self.view = entry_id, offset, size, view
        self._sha = None

    def sha(self):
        if self._sha is None:
            self._sha = self.view.sha()
        return self._sha


class MixArchive:
    """All offsets are bounded by the current archive, including nested MIX."""
    ciphers = {}

    def __init__(self, view):
        self.view = view
        if view.length < 6:
            raise ValueError("truncated MIX header: " + view.label)
        first, flags = struct.unpack("<HH", view.read(0, 4))
        if first:
            count, body_size = struct.unpack("<HI", view.read(0, 6))
            index = view.read(6, count * 12)
            body_offset = 6 + count * 12
        elif flags & ~3:
            raise ValueError("unknown MIX flags: " + view.label)
        elif flags & 2:
            block = view.read(4, 80)
            if block not in self.ciphers:
                reverse = block[::-1]
                modulus = int("51bcda086d39fce4565160d651713fa2e8aa54fa6682b04aabdd0e6af8b0c1e6d1fb4f3daa437f15", 16)
                parts = [pow(int.from_bytes(reverse[n:n + 40], "big"), 65537, modulus) for n in (0, 40)]
                key = (((parts[0] << 312) + parts[1]) & ((1 << 448) - 1)).to_bytes(56, "big")[::-1]
                self.ciphers[block] = Blowfish(key)
            cipher = self.ciphers[block]
            count, body_size = struct.unpack_from("<HI", cipher.decrypt(view.read(84, 8)))
            encrypted_size = ((6 + count * 12 + 7) // 8) * 8
            decrypted = cipher.decrypt(view.read(84, encrypted_size))
            index = decrypted[6:6 + count * 12]
            body_offset = 84 + encrypted_size
        else:
            count, body_size = struct.unpack("<HI", view.read(4, 6))
            index = view.read(10, count * 12)
            body_offset = 10 + count * 12
        if body_offset + body_size > view.length:
            raise ValueError("declared MIX body exceeds archive: " + view.label)
        self.body_size, self.entries, self.by_id = body_size, [], {}
        for n in range(count):
            entry_id, offset, size = struct.unpack_from("<III", index, n * 12)
            if offset + size > body_size:
                raise ValueError("MIX entry exceeds declared body: " + view.label)
            payload = view.sub(body_offset + offset, size, f"{view.label}/#{entry_id:08x}")
            entry = Entry(entry_id, offset, size, payload)
            if entry_id in self.by_id and entry.sha() != self.by_id[entry_id].sha():
                raise ValueError("ambiguous duplicate MIX ID: " + view.label)
            self.entries.append(entry)
            self.by_id.setdefault(entry_id, entry)

    def find(self, name):
        return self.by_id.get(mix_hash(name))


def repack(archive, entries, path):
    """Preserve IDs, payloads and original index order, remove only chosen entries."""
    entries = list(entries)
    if len(entries) > 65535 or sum(e.size for e in entries) > 0xffffffff:
        raise ValueError("MIX output too large")
    with open(path, "wb") as output:
        output.write(struct.pack("<HHHI", 0, 0, len(entries), sum(e.size for e in entries)))
        offset = 0
        for entry in entries:
            output.write(struct.pack("<III", entry.id, offset, entry.size))
            offset += entry.size
        for entry in entries:
            for chunk in entry.view.chunks():
                output.write(chunk)


def language_selection(archive, name):
    selected, removed = [], []
    for entry in archive.entries:
        reason = None
        if entry.view.read(0, min(3, entry.size)) == b"BIK":
            reason = "confirmed-bik-payload"
        elif name == "language.mix" and entry.id == mix_hash("audio.mix"):
            base_audio = MixArchive(entry.view)
            if not base_audio.find("audio.idx") or not base_audio.find("audio.bag"):
                raise ValueError("unrecognized base audio payload; refusing removal")
            reason = "unselected-base-audio-audiomd-present"
        if reason:
            removed.append({"id": f"{entry.id:08x}", "bytes": entry.size, "sha256": entry.sha(), "reason": reason})
        else:
            selected.append(entry)
    return selected, removed


class Resolver:
    """Production named registration order, loose > catalog > first registered ID."""
    def __init__(self, sources, full=False):
        self.sources, self.registered, self.catalog = sources, [], {}
        self.parsed = {}
        for name in ("langmd.mix", "language.mix", "expandmd01.mix", "ra2md.mix", "ra2.mix",
                     "cachemd.mix", "cache.mix", "localmd.mix", "local.mix"):
            self.mount(name, required=True)
        if not self.mount("audiomd.mix"):
            self.mount("audio.mix")
        for name in ("conqmd.mix", "genermd.mix", "generic.mix", "isogenmd.mix", "isogen.mix", "conquer.mix", "cameomd.mix", "cameo.mix"):
            self.mount(name, required=name in ("conqmd.mix", "conquer.mix", "cameomd.mix", "cameo.mix"))
        if full:
            self.mount("mapsmd03.mix", True)
        self.mount("multimd.mix", True)
        if full:
            self.mount("thememd.mix")
            self.mount("theme.mix")
            self.mount("movmd03.mix", True)
        for _, archive in self.registered:
            for name in NESTED:
                if name not in self.catalog and not self.has(name):
                    entry = archive.find(name)
                    if entry:
                        child = self.parse(entry.view)
                        if child.entries:
                            self.catalog[name] = child

    def parse(self, view):
        key = (id(view.data), view.offset, view.length)
        if key not in self.parsed:
            self.parsed[key] = MixArchive(view)
        return self.parsed[key]

    def has(self, name):
        return any(n == name for n, _ in self.registered)

    def mount(self, name, required=False):
        if self.has(name):
            return True
        archive = None
        if name in self.sources:
            archive = self.parse(self.sources[name])
        elif name in self.catalog:
            archive = self.catalog.pop(name)
        else:
            for _, parent in self.registered:
                entry = parent.find(name)
                if entry:
                    archive = self.parse(entry.view)
                    break
        if archive is not None:
            self.registered.append((name, archive))
            return True
        if required:
            raise ValueError("required native archive absent: " + name)
        return False

    def winners(self):
        winners = {}
        for name, archive in self.registered:
            for entry in archive.entries:
                winners.setdefault(entry.id, (name, entry))
        return winners


def compare_winners(required, full, label):
    compared, mismatch = 0, []
    for entry_id, (required_name, entry) in required.items():
        candidate = full.get(entry_id)
        if not candidate or candidate[1].size != entry.size or candidate[1].sha() != entry.sha():
            mismatch.append({"id": f"{entry_id:08x}", "requiredArchive": required_name,
                             "fullArchive": candidate[0] if candidate else None})
        compared += 1
    if mismatch:
        raise ValueError(f"required/full native winner mismatch ({label}): {mismatch[:8]}")
    return {"case": label, "comparedEntries": compared, "mismatches": 0}


def equivalent(required_sources, full_sources):
    results = []
    for theater, names in THEATERS.items():
        for side in (1, 2):
            stacks = [Resolver(required_sources), Resolver(full_sources, full=True)]
            for stack in stacks:
                for name in ("ntrlmd.mix", "neutral.mix", "loadmd.mix", "load.mix"):
                    stack.mount(name, True)
                for name in (f"sidec{side:02}md.mix", f"sidec{side:02}.mix", f"sidenc{side:02}.mix"):
                    stack.mount(name)
                for name in names:
                    stack.mount(name, True)
                for name in sorted(stack.sources):
                    if name.endswith(".yro"):
                        stack.mount(name, True)
            results.append(compare_winners(stacks[0].winners(), stacks[1].winners(), f"{theater}/side{side}"))
    return results


def gzip_object(source, target_dir):
    """Portable fixed gzip header; raw DEFLATE level6; zero mtime, no filename."""
    descriptor, temporary_name = tempfile.mkstemp(prefix=".gzip-", dir=target_dir)
    crc, size = 0, 0
    try:
        with os.fdopen(descriptor, "wb") as output, open(source, "rb") as stream:
            output.write(bytes.fromhex("1f8b08000000000000ff"))
            compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                crc, size = zlib.crc32(chunk, crc), size + len(chunk)
                output.write(compressor.compress(chunk))
            output.write(compressor.flush())
            output.write(struct.pack("<II", crc & 0xffffffff, size & 0xffffffff))
        temporary = Path(temporary_name)
        digest, length = sha_file(temporary), temporary.stat().st_size
        target = target_dir / digest
        if target.exists():
            temporary.unlink()
        else:
            temporary.replace(target)
        return {"sha256": digest, "bytes": length, "path": str(target), "contentType": "application/gzip"}
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def build(asset_root=DEFAULT_ASSET_ROOT, output_root=ROOT):
    asset_root, output_root = Path(asset_root).resolve(), Path(output_root).resolve()
    internal = output_root / ".build/native-content"
    object_dir = internal / "objects"
    object_dir.mkdir(parents=True, exist_ok=True)
    cache_path = internal / "cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    cache_key = ALGORITHM + ":zlib-" + zlib.ZLIB_VERSION
    cache = cache if cache.get("algorithm") == cache_key else {"algorithm": cache_key, "gzip": {}}
    source_files, source_views, originals, open_files = [], {}, {}, []
    for name in SOURCE_NAMES:
        path = asset_root / name
        if not path.is_file() or path.resolve().parent != asset_root:
            raise ValueError("missing or out-of-root whitelisted source: " + name)
        info = {"name": name, "bytes": path.stat().st_size, "sha256": sha_file(path), "path": str(path)}
        source_files.append(info)
        originals[name] = info
        stream = path.open("rb")
        mapping = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        open_files.extend((stream, mapping))
        source_views[name] = View(mapping, label=name)
    selected_audio = MixArchive(source_views["langmd.mix"]).find("audiomd.mix")
    if not selected_audio:
        raise ValueError("cannot remove base audio without audiomd.mix")
    selected_audio_archive = MixArchive(selected_audio.view)
    if not selected_audio_archive.find("audio.idx") or not selected_audio_archive.find("audio.bag"):
        raise ValueError("cannot remove base audio without a valid selected MD audio pair")
    default_infos = {name: info for name, info in originals.items() if name not in EXCLUDED}
    required_views = {name: view for name, view in source_views.items() if name not in EXCLUDED}
    transformations = []
    for name in ("language.mix", "langmd.mix"):
        archive = MixArchive(source_views[name])
        entries, removed = language_selection(archive, name)
        temporary = internal / (name + ".tmp")
        repack(archive, entries, temporary)
        digest = sha_file(temporary)
        target = object_dir / digest
        temporary.replace(target)
        default_infos[name] = {"name": name, "bytes": target.stat().st_size, "sha256": digest, "path": str(target)}
        stream = target.open("rb")
        mapping = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        open_files.extend((stream, mapping))
        required_views[name] = View(mapping, label=name)
        rewritten = MixArchive(required_views[name])
        if [(e.id, e.size, e.sha()) for e in rewritten.entries] != [(e.id, e.size, e.sha()) for e in entries]:
            raise ValueError("MIX repack payload/order proof failed")
        transformations.append({"name": name, "sourceSha256": originals[name]["sha256"],
                                "derivedSha256": digest, "removed": removed,
                                "retained": [{"id": f"{e.id:08x}", "bytes": e.size, "sha256": e.sha()} for e in entries]})
    print("Checking required/full first-winner equivalence across six theaters and both sidebar families", flush=True)
    cases = equivalent(required_views, source_views)
    native_inputs = ["asset_manager.rs", "mix_archive.rs", "mix_hash.rs", "mix_crypto.rs", "blowfish.rs"]
    proof = {"schema": 1, "algorithm": ALGORITHM, "requiredResourceIdentity": resource_identity(list(default_infos.values())),
             "sources": [{k: f[k] for k in ("name", "bytes", "sha256")} for f in source_files],
             "nativeParserSources": {name: sha_file(ROOT / "native-client/src/assets" / name) for name in native_inputs},
             "transformations": transformations, "resolutionCases": cases,
             "limitations": ["Static archive winner equivalence; does not replace native gameplay/network tests.",
                             "All six theaters are bundled; optional configuration is mounted only before native startup."]}
    proof_path = internal / "proof.json"
    write_json(proof_path, proof)
    proof_sha = sha_file(proof_path)
    objects = {}

    def public_file(info):
        digest, path = info["sha256"], Path(info["path"])
        objects[digest] = {"sha256": digest, "bytes": info["bytes"], "path": str(path),
                           "contentType": "video/mp4" if info["name"].endswith(".mp4") else "application/octet-stream"}
        compressed = cache["gzip"].get(digest)
        if compressed is None or not Path(compressed["path"]).is_file() or Path(compressed["path"]).stat().st_size != compressed["bytes"] or sha_file(compressed["path"]) != compressed["sha256"]:
            print("gzip " + info["name"], flush=True)
            compressed = gzip_object(path, object_dir)
            cache["gzip"][digest] = compressed
            write_json(cache_path, cache)
        objects[compressed["sha256"]] = compressed
        return {"name": info["name"], "bytes": info["bytes"], "sha256": digest, "url": "/content/objects/" + digest,
                "download": {"url": "/content/objects/" + compressed["sha256"], "bytes": compressed["bytes"],
                             "sha256": compressed["sha256"], "encoding": "gzip"}}

    required_files = [public_file(default_infos[name]) for name in sorted(default_infos)]
    full_files = [public_file(originals[name]) for name in SOURCE_NAMES]
    animation = ROOT / "native-client/art/branding/werhd-menu.mp4"
    animation_info = {"name": animation.name, "bytes": animation.stat().st_size, "sha256": sha_file(animation), "path": str(animation)}
    animation_file = public_file(animation_info)
    full_files.append(animation_file)
    full_files.sort(key=lambda f: f["name"])
    identity = resource_identity(required_files)

    def profile(files, capabilities):
        return {"files": files, "totalBytes": sum(f["bytes"] for f in files),
                "downloadBytes": sum(f["download"]["bytes"] for f in files),
                "requiredResourceIdentity": identity, "capabilities": capabilities}

    by_name = {f["name"]: f for f in full_files}
    packs = {}
    for pack, name, capability, dependencies in (("campaign", "mapsmd03.mix", "campaign", ["cinematics"]),
           ("cinematics", "movmd03.mix", "movies", []), ("music", "thememd.mix", "music", []),
           ("brandingAnimation", animation_file["name"], "menuAnimation", [])):
        files = [by_name[name]]
        packs[pack] = {"files": files, "totalBytes": sum(f["bytes"] for f in files),
                       "downloadBytes": sum(f["download"]["bytes"] for f in files),
                       "dependsOn": dependencies, "capabilities": {capability: True}, "requiresReload": True}
    master_archives = {name: MixArchive(source_views[name]) for name in ("ra2.mix", "ra2md.mix")}
    theaters = []
    for theater, names in THEATERS.items():
        entries = []
        for name in names:
            found = [(container, archive.find(name)) for container, archive in master_archives.items() if archive.find(name)]
            if len(found) != 1:
                raise ValueError("ambiguous/missing theater nested archive: " + name)
            container, entry = found[0]
            entries.append({"name": name, "container": container, "bytes": entry.size})
        theaters.append({"id": theater, "bundledIn": "skirmish", "downloadable": False,
                         "nestedArchives": entries, "totalBytes": sum(e["bytes"] for e in entries)})
    inventory = {"schema": 1, "masters": {name: {"bytes": archive.view.length, "entries": [
        {"id": f"{e.id:08x}", "name": next((n for n in NESTED if mix_hash(n) == e.id), None), "bytes": e.size}
        for e in archive.entries]} for name, archive in master_archives.items()}, "transformations": transformations}
    write_json(internal / "inventory.json", inventory)
    catalog = {"schema": 2, "defaultProfile": "skirmish", "files": required_files,
               "totalBytes": sum(f["bytes"] for f in required_files),
               "downloadBytes": sum(f["download"]["bytes"] for f in required_files), "identity": identity,
               "profiles": {"skirmish": profile(required_files, CAPABILITIES.copy()),
                            "full": {**profile(full_files, dict.fromkeys(CAPABILITIES, True)), "equivalenceProofSha256": proof_sha}},
               "packs": packs, "theaterGroups": theaters}
    catalog["catalogIdentity"] = sha_bytes(canonical(catalog))
    catalog_path = output_root / "public/native-content/catalog.json"
    write_json(catalog_path, catalog)
    plan = {"schema": 1, "algorithm": cache_key, "catalogPath": str(catalog_path),
            "catalogIdentity": catalog["catalogIdentity"], "requiredResourceIdentity": identity,
            "sourceFiles": source_files, "objects": sorted(objects.values(), key=lambda x: x["sha256"]),
            "profiles": {name: [f["name"] for f in p["files"]] for name, p in catalog["profiles"].items()},
            "proof": {"path": str(proof_path), "sha256": proof_sha}}
    write_json(internal / "plan.json", plan)
    print(json.dumps({"ok": True, "requiredResourceIdentity": identity, "catalogIdentity": catalog["catalogIdentity"],
                      "skirmishFiles": len(required_files), "skirmishBytes": catalog["totalBytes"],
                      "skirmishDownloadBytes": catalog["downloadBytes"], "fullFiles": len(full_files),
                      "fullDownloadBytes": catalog["profiles"]["full"]["downloadBytes"], "objects": len(objects)}), flush=True)
    return catalog, plan


def check(output_root=ROOT):
    output_root = Path(output_root)
    catalog = json.loads((output_root / "public/native-content/catalog.json").read_text())
    plan = json.loads((output_root / ".build/native-content/plan.json").read_text())
    unsigned = {k: v for k, v in catalog.items() if k != "catalogIdentity"}
    if catalog["catalogIdentity"] != sha_bytes(canonical(unsigned)) or plan["catalogIdentity"] != catalog["catalogIdentity"]:
        raise ValueError("catalog identity mismatch")
    identity = resource_identity(catalog["files"])
    if identity != catalog["identity"] or identity != plan["requiredResourceIdentity"]:
        raise ValueError("required resource identity mismatch")
    objects = {o["sha256"]: o for o in plan["objects"]}
    if len(objects) != len(plan["objects"]):
        raise ValueError("duplicate content object")
    for digest, obj in objects.items():
        path = Path(obj["path"])
        if path.stat().st_size != obj["bytes"] or sha_file(path) != digest:
            raise ValueError("object changed: " + digest)
    for profile in catalog["profiles"].values():
        if profile["requiredResourceIdentity"] != identity:
            raise ValueError("optional profile changed required identity")
        if profile["totalBytes"] != sum(f["bytes"] for f in profile["files"]):
            raise ValueError("profile byte total mismatch")
        for file in profile["files"]:
            for record in (file, file["download"]):
                if record["url"] != "/content/objects/" + record["sha256"] or objects[record["sha256"]]["bytes"] != record["bytes"]:
                    raise ValueError("file object mismatch")
            decompressor, digest, length = zlib.decompressobj(31), hashlib.sha256(), 0
            with open(objects[file["download"]["sha256"]]["path"], "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    raw = decompressor.decompress(chunk)
                    digest.update(raw)
                    length += len(raw)
            raw = decompressor.flush()
            digest.update(raw)
            length += len(raw)
            if not decompressor.eof or digest.hexdigest() != file["sha256"] or length != file["bytes"]:
                raise ValueError("gzip/raw proof failed: " + file["name"])
    proof = plan["proof"]
    if sha_file(proof["path"]) != proof["sha256"]:
        raise ValueError("equivalence proof changed")
    recorded_proof = json.loads(Path(proof["path"]).read_text())
    for name, digest in recorded_proof["nativeParserSources"].items():
        if name not in ("asset_manager.rs", "mix_archive.rs", "mix_hash.rs", "mix_crypto.rs", "blowfish.rs") or sha_file(ROOT / "native-client/src/assets" / name) != digest:
            raise ValueError("native resolver/parser changed; rebuild content proof: " + name)
    if catalog["packs"]["campaign"]["dependsOn"] != ["cinematics"]:
        raise ValueError("campaign must include cinematics")
    print(json.dumps({"ok": True, "catalogIdentity": catalog["catalogIdentity"], "objects": len(objects),
                      "profiles": {name: len(p["files"]) for name, p in catalog["profiles"].items()}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "check"))
    parser.add_argument("--asset-root", type=Path, default=DEFAULT_ASSET_ROOT)
    parser.add_argument("--output-root", type=Path, default=ROOT)
    options = parser.parse_args()
    try:
        if options.command == "build":
            build(options.asset_root, options.output_root)
        else:
            check(options.output_root)
    except (ValueError, OSError, KeyError, struct.error, zlib.error) as error:
        print("native-content: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
