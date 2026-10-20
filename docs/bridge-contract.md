# VERA web bridge, version 1

`crates/vera-web-core` owns one VERA `HeadlessScenario` per Engine. The native CLI and browser worker execute the same JSON dispatcher and vendored production `SimRuntime`. JavaScript owns lobby, transport and rendering, not gameplay. Retail MIX files and processed art are local inputs; they are not committed.

## Raw WASM ABI and ownership

Exports are `vw_alloc(length)`, `vw_dealloc(pointer,length)`, `vw_asset(namePointer,nameLength,dataPointer,dataLength)`, `vw_call(jsonPointer,jsonLength)`, `vw_result_ptr()`, and `vw_result_len()`. The module also exports its linear memory.

- `vw_alloc` returns a writable allocation of exactly the requested length.
- **`vw_asset` consumes both allocations**, including when it returns an error. Its caller must not free either pointer afterwards. Asset names are UTF-8 plain file names. It returns `0` on success and `-1` on error; the result JSON is available through the result pointer and length.
- `vw_call` borrows UTF-8 JSON until it returns; free that input afterwards. It returns the borrowed result pointer.
- Results remain valid until the next `vw_call` or `vw_asset`. Copy the result before another call. A WASM memory growth can invalidate a JavaScript typed-array view; acquire a fresh view after calls/allocations.
- Every pointer passed for deallocation or asset transfer must come from `vw_alloc` with its exact length. Overlapping/double-consumed pointers violate the ABI.
- Invalid JSON, unsupported options and missing assets produce `{ "ok": false, "error": "..." }`. There is no synthetic map or TypeScript simulation fallback. A trapped WASM instance is fatal; dispose its worker and reinitialize. A recoverable frame error poisons the session until reinitialization.

Asset buffers transfer into `Arc<Vec<u8>>` storage without another full archive copy. Nested MIX archives share subranges. An AssetManager snapshot cloned for each new match shares archive bytes while retaining a separate resolver/cache lifecycle. The memory constructor follows the original language/expansion/master/core/maps/theater precedence, with an explicit GPU-free policy omitting movie/music registration. The native CLI uses this same memory path and the shared `tools/retail-policy.json` file whitelist. User profiles and launcher configuration (`ra2md.ini`, `ra2.ini`, keyboard, ddraw and spawn INIs) are excluded consistently from browser and native inputs.

## Requests

Register every asset before the first `init`:

```json
{
  "op": "init",
  "config": {
    "map": "XMP29U2.MAP",
    "seed": 1592590337,
    "localPlayer": 0,
    "viewPlayer": 0,
    "players": [
      {"slot":0,"name":"玩家","country":"America","color":0,"start":0,"team":0,"human":true},
      {"slot":1,"name":"电脑","country":"Russia","color":1,"start":1,"team":0,"human":false,"difficulty":"easy"}
    ],
    "options": {
      "credits":10000,"unitCount":10,"gameSpeed":4,
      "shortGame":true,"superWeapons":true,"crates":false,
      "mcvRepacks":true,"buildOffAlly":true,"destroyableBridges":true
    }
  }
}
```

Active player slots are distinct `0..7`; closed/sparse slots are omitted without renumbering. Colors are explicit distinct `0..7`. Starts are `-1` for random or `0..7` for a fixed map waypoint. Teams `-1` and `0` mean none; `1..4` are explicit teams. AI difficulty is exactly `easy`, `normal`, or `hard`. Countries are explicit VERA names: `America`, `Korea`, `France`, `Germany`, `GreatBritain`, `Libya`, `Iraq`, `Cuba`, `Russia`, `Yuri`. WERHD sentinels and its extended difficulty enum must be resolved at the lobby boundary before this call. The bridge rejects unknown countries, duplicate slots, duplicate fixed starts and duplicate colors.

Humans are sorted by lobby slot into compact human indices. All lockstep instances construct the canonical native current player at compact index 0. `localPlayer` supplies the default viewer; `viewPlayer` overrides it. The viewer is retained only by the bridge and does not change the authoritative setup, RNG, tick or hash. `snapshot` can change the viewer, and a network command identifies its originating compact human index through `player`.

```json
{"op":"tick","ticks":1,"commands":[{"kind":"deploy","entityId":123,"player":0}]}
{"op":"tick","commands":[{"kind":"move","entityIds":[123,124],"rx":50,"ry":45}]}
{"op":"tick","commands":[{"kind":"queue","typeId":"GAPOWR"}]}
{"op":"tick","commands":[{"kind":"place","typeId":"GAPOWR","rx":51,"ry":45}]}
{"op":"snapshot","viewPlayer":0}
{"op":"placement","typeId":"GAPOWR","rx":51,"ry":45}
{"op":"dispose"}
{"op":"dispose","clearAssets":true}
```

Other commands are `attackMove` (actor IDs and `rx`/`ry`), `scatter`, `forceAttack` (actor IDs and `rx`/`ry`), `cancelProduction`/`cancel` (`typeId`, optional `all`), `select` (`entityIds`, optional `additive`), `attack` (`entityId`/`entityIds`, `targetId`), `stop`, `guard`, `sell`, and `repair`. `produce` aliases `queue`. All live actor commands enforce actor ownership. An actor removed since input was issued is ignored like a native expired object reference; malformed records and live foreign actors are rejected before the batch is committed. Unrecognized commands fail before any input batch is committed. Commands retain array order and execute at the next simulation tick. `ticks` is `1..600`; commands are submitted only on the first tick of a multi-tick request. A browser lockstep loop must call with `ticks:1` and the ordered committed batch. Maximum 1024 semantic command records per request.

Every tick queues external inputs and drains due commands, then calls `SimRuntime`. Its existing `admit_frame_commands` prefix publishes production completion through VERA's production owner and folds newly generated `PlaceProducedMobile` events into that frame. The bridge must not pre-consume those completion flags outside runtime admission. Building readiness and placement remain VERA decisions.

`dispose` releases the match but retains loaded assets for re-entry. `clearAssets:true` additionally releases the catalog and permits new file registration.

## Snapshot

`init`, `tick` and `snapshot` return `{ok:true,snapshot:{...}}`:

- `tick`: committed VERA tick; `tickMs`: headless cadence 66 ms.
- `stateHash`: portable authoritative hash as 16 hexadecimal digits, avoiding JavaScript integer truncation. VERA's `StateHasher` normalizes word-sized integer writes.
- `localOwner`: interned numeric owner of the selected viewer, `viewPlayer`: compact human index.
- `entities`: `{id,typeId,owner,rx,ry,subX,subY,z,sx,sy,facing,hp,maxHp,category,limbo,alive,visible}`. IDs are VERA stable object IDs; the current game population is safely within JavaScript's exact integer range. Categories are `infantry`, `unit`, `aircraft`, `structure`.
- `players`: `{owner,slot,humanIndex,name,country,color,human,credits,power,drain,defeated}`. Credits and power come from VERA owners.
- `buildOptions`: current viewer options `{typeId,displayName,cost,category,enabled,reason}`.
- `queues`: `{typeId,displayName,category,state,progress,total}`. `total` is VERA's factory step count. States are `queued`, `building`, `paused`, `done`. Progress is the active factory progress; queued entries should render zero progress.
- `ready`: completed buildings awaiting placement `{typeId,displayName,category}`.
- `fog`: `{width,height,cells}` in VERA row-major cell order. Bit 0 is explored, bit 1 is currently visible; fog is selected for the viewer. Entities additionally expose `visible` for rendering admission. This read projection must not be used to evolve visibility in JavaScript.
- `map`: `{id,width,height,localLeft,localTop,localWidth,localHeight,theater,starts:[{index,rx,ry}]}`.

`rx`/`ry` are integer isometric cells, `subX`/`subY` are offsets in leptons (256 per cell, 128 is the center), and `z` is the retained signed level encoded in VERA's byte. `sx`/`sy` are absolute VERA world pixels, produced by the existing `lepton_to_screen_exact_z` including its native integer truncation, exact retained height and common +15 row bias. Terrain assets use `iso_to_screen`; their pixel offset/anchor is documented in the art manifest. Buildings require their class-specific render anchor in the drawing layer; do not modify authoritative world coordinates to fit artwork. Facing is the native 0..255 body-facing byte.

The baseline intentionally uses the existing GPU-free headless 66 ms cadence. VERA source documents the desktop app's 22 ms divergence; same-tick parity is the validation target, not equal desktop wall-clock pacing. Preview pixels, callback timing, omitted client audio and omitted atlas-derived animation frame counts are presentation limits, not another game simulation.

## Native oracle

```sh
CARGO_TARGET_DIR=.build/cargo cargo build --locked --release -p vera-web-core --bin vera-web-native
./.build/cargo/release/vera-web-native --assets /absolute/retail-root --script /absolute/requests.json
```

A script is a JSON array of the requests above. Without `--script`, the CLI reads newline-delimited JSON from standard input. It emits one JSON response per request. `--hashes` emits only `{ok,tick,stateHash}` for successful requests and retains full errors. The CLI and WASM library call `Engine::execute`, so parity checks exercise actual initialization, commands, production and world advancement.

The trigger owner hashes ordinal-index slices as canonical 64-bit little-endian records. Rust bulk `Hash` of a primitive `usize` slice uses host word width despite the portable scalar hasher; this bridge preserves the established 64-bit native hash stream on wasm32 without changing serialized state, trigger order or gameplay. `diagnostics` exposes the existing read-only owner hash segments, parity digest and an optional full save (`includeSave:true`) for locating the first divergence.

The base navigation-zone scanline fill uses explicit depth-first frames. It retains the original horizontal overwrites, carried height references, above/below return advances and edge insertion order; only the machine recursion is removed. Safari's JavaScriptCore can exhaust its call stack during a large connected retail map's initialization even when the WASM linear-memory stack is 16 MiB. A larger linear stack alone does not address that limit.

`tools/test-parity.mjs` normally builds and runs the current native CLI. For before/after validation, `VERA_NATIVE_ORACLE=/absolute/preserved-native-binary` selects a previously built native oracle without rebuilding it; `VERA_PARITY_RECEIPT=label` writes a separate `validation/label.json` and request stream. Receipts record both binary hashes and compare the full authoritative hash each tick, including both retail maps, all three factions, actual factory delivery and multiplayer owner/viewer admission.

`npm run test:zone-fill` reads the original recursive function with `git show` from the exact upstream source/revision in `upstream.lock.json`, verifies its pinned content hash, and extracts the current vendor function into an isolated `.build` Rust harness. It compares the return advance, every node ID and the complete ordered edge-registration events for 20,000 deterministic random fixtures, then fills a 30,000-row connected component with the iterative implementation. The production source contains one implementation. This check passed; its machine-readable receipt is `validation/zone-fill-equivalence.json`. The separate `validation/parity-iterative-vs-recursive.json` passed 5,726 real native/WASM frames and 15 gameplay checks against the preserved recursive native binary.

The existing `sim::pathfinding::zone_map_tests` (20 tests) and `sim::pathfinding::zone_build::tests::gsi_04_06` (9 tests) also pass under `CARGO_TARGET_DIR=.build/cargo cargo test --locked -p vera20k-core --lib <filter>`. The broader `sim::pathfinding::zone` filter passes all 98 tests, including the original native-executable oracle cases. Its 11 required `tools/spatial_oracle/*.json` fixtures are vendored from the same pinned upstream revision with hashes in `upstream.lock.json`; the result and fixture hashes are recorded in `validation/zone-regressions.json`. This is the relevant zone regression suite, not the entire engine unit suite.
