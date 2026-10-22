# Native content profiles

`python3 tools/native-content.py build` reads only the 32 whitelisted retail
files in `~/Library/Application Support/VERA20k/retail-assets`. Override this
with `--asset-root`. It writes this repository's `public/native-content/catalog.json`
and ignored `.build/native-content/` objects, cache, inventory and proof. It does
not modify either upstream project. Run `python3 tools/native-content.py check`
to verify every planned object and decompress/hash each advertised download;
run `python3 tools/native-content-test.py` for synthetic parser/proof tests.

The schema-2 catalog's top-level `files`, `totalBytes`, `downloadBytes` and
`identity` describe the default `skirmish` startup profile. The same profile is
also in `profiles.skirmish`. It retains all six theaters, all skirmish maps,
unit art and the selected YR audio archive. `ra2.mix` and `ra2md.mix` are master
containers of terrain, art and native UI; they are retained, not mistaken for
movie files. `language.mix` and `langmd.mix` are rebuilt with the original
retained IDs, entry order and exact payload bytes. Only confirmed `BIK` payloads
and the unused base `audio.mix` fallback are removed. The script requires the
selected `audiomd.mix` to exist before removing that fallback.

The default omits the campaign `mapsmd03.mix`, cinematic `movmd03.mix`, music
`thememd.mix`, unused base multiplayer `multi.mix` and executable files. The
`full` startup profile preserves all 32 original retail files plus the existing
approved compressed branding MP4. Full and default are alternative startup
sets: they must not be unioned because their language containers have the same
logical names and intentionally different container hashes.

`packs` describes optional additions to the default profile. `campaign` depends
on `cinematics`; `music` and `brandingAnimation` are independent. Their byte
totals count their own files, excluding dependencies. Resolve dependencies and
deduplicate by SHA before calculating the total download. The default enables
none of the four capabilities; full enables all. Cache installation alone does
not enable a capability. Choose capabilities and mount resources before native
startup, or reload afterward: the current synchronous VFS does not hot-mount
optional content. `theaterGroups` reports the six bundled nested-archive groups
with `downloadable:false`; it is metadata for a future map-aware bootstrap,
not an already implemented runtime download path.

Every public file carries raw identity `{name,bytes,sha256,url}` and a separate
`download:{url,bytes,sha256,encoding:'gzip'}` descriptor. Both URLs are immutable
`/content/objects/<sha256>` identifiers. Serve compressed objects with their
advertised compressed bytes and **without HTTP Content-Encoding**. The client
first checks download size/SHA, decompresses, then checks raw size/SHA before
mounting. The deterministic gzip format has zero mtime, no filename, OS 255,
raw DEFLATE level 6, and CRC/length trailer. Cache keys include the pipeline
algorithm and zlib version; repeated builds reuse validated compressed objects.

The required network identity hashes compact JSON of files sorted by logical
name, each object with fields in this order: `name`, `bytes`, `sha256`. It ignores
download metadata, installed optional cache objects and capabilities. Both
profiles report this same `requiredResourceIdentity`. The build checks the
native first-winner lookup order across all six theaters and two sidebar
families: every resource ID visible in the default must resolve to the exact
same payload in full. It fails on different duplicate IDs, missing nested
archives, malformed bounds or optional overrides. The proof records original
source hashes, native parser/resolver source hashes, transformed-entry hashes,
and the twelve lookup cases. This static proof does not substitute for native
gameplay or multiplayer tests.

`catalogIdentity` is SHA256 of the entire catalog except its own top-level field,
recursively sorting object keys and retaining array order, serialized as compact
UTF-8 JSON with no newline. Catalog bytes are deterministic and contain no local
filesystem paths. `.build/native-content/plan.json` schema 1 records physical
paths only for local tooling: `objects:[{sha256,bytes,contentType,path}]`, original
`sourceFiles`, profile logical-name lists, both identities, and
`proof:{path,sha256}`. Original full raw files are referenced read-only rather
than copied; new derived and gzip files live under `.build/native-content/objects`.
Servers and R2 packaging must whitelist objects from this plan, never accept a
user-provided filename/path, and preserve the same SHA keys across releases.

## Lobby and engine boundaries

`web-native/content-store.js` owns verified binary delivery and CacheStorage.
It has no DOM, simulation or wasm-bindgen dependency. `content-plan.js` resolves
profiles, package dependencies, mounting conflicts and the shared gameplay
identity. A replacement lobby can call these same interfaces before starting
the VERA simulation. The optional `content-panel.js` UI only selects and caches
plans; activation is a caller callback and requires a reload of the current
native client.

`runtime-adapter.js` contains the current wasm loading, content configuration,
mounting, startup and network port. The current native menu/rendering integration
stays behind this adapter. A future sim-only integration supplies its own engine
adapter and match lifecycle while retaining the content catalog and store. Asset
descriptors contain no native menu types or serialized lobby state.
