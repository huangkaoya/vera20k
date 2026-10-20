# Local retail art contract

`cargo run -p asset-export --release -- --retail "/path/to/RA2" --out public/generated`
reads retail archives without modifying them. Default maps are `XMP29U2.MAP` and
`XMP03T4.MAP`; repeat `--map` to choose another map. An unavailable map is reported,
and exporting zero maps fails. `public/generated` is ignored and contains EA game
art intended only for the owner's local development. Source decoders and their
GPL license/provenance remain in `vendor/vera20k`.

The exporter links `vera20k-core` and imports the original CPU VXL rasterizer and
its normal tables with `#[path]`. It does not link the native client, wgpu, window
system or sound. Terrain PNGs use VERA TMP decoding, theater palette and actual
cell elevation/offsets. VERA `ResolvedTerrainGrid::presentation_tile` and
`size_diamond_contains` fill omitted/default authored cells through the existing
Clear-tile owner. Trees use VERA overlay palette selection (ISO, or Unit for
ore-spawning trees), and ore uses the theater resource palette. Trees and overlay graphics are static in the terrain
image; mutable vehicles, infantry and buildings are never baked into it. This
initial presentation does not yet redraw destroyed ore/trees or order static
tree pixels against a moving unit's per-pixel depth. The VERA simulation remains
authoritative for their gameplay.

`manifest.json` and `catalog.json` contain the same versioned JSON. `maps` is an
array keyed by the case-insensitive retail filename `id`; each map provides its
real PNG, thumbnail, absolute pixel origin/dimensions, playable size, resident
cells `{rx,ry,z}` and sorted player starts `{index,rx,ry}`. VERA projects each tile
NW corner as `((rx-ry)*30-30,(rx+ry)*15+15-z*15)`; the cell center is 30 pixels
right and 15 pixels down from that point. Asset coordinates and bridge `sx/sy`
share this absolute world-pixel frame. Camera translation is presentation only.

`sprites[typeId]` contains original source identity, kind, RGBA atlas, house
remap-only grayscale atlas, optional original sidebar cameo and foundation size.
Frames have atlas `x/y/width/height`, offsets from the VERA entity draw anchor,
quantized facing and animation ID (0 ready, 1 infantry walking). Buildings apply the existing class-specific 15px art lift above the entity
anchor; selection remains on its world anchor. SHP offsets use
VERA's centered logical canvas plus stored frame origin and ART draw offsets.
Voxel body/turret/barrel sprites use VERA's actual CPU raster and depth buffers
at 32 facings. Infantry frames follow the ART `Sequence` ready/walk definitions.
Original palette index zero is transparent; 16..31 also populate the remap mask.
The mask encodes the original 0..15 shade identity. `colors` contains the eight
lobby priorities and their exact 16-shade native ramps, derived by VERA
`parse_color_schemes`, `scheme_entry_for_priority`, and `build_scheme_ramp`.
The browser maps snapshot player owners to these priorities and replaces only
those pixels, leaving neutral objects and every other original pixel intact.

All registered object types with present retail art are exported. Missing art
is recorded in `warnings`; the renderer reports live uncovered types in its
`uncoveredTypes` set instead of drawing invented unit art. The runtime only
fetches map/sprite images when needed, not every atlas at boot.

`BattlefieldRenderer` consumes immutable `VeraSnapshot` data and exposes camera,
hit test, box selection, placement preview and minimap methods. It does not
spawn objects, spend money, run pathfinding, or infer combat/production results.
All mutations must go through the WASM bridge's commands. Snapshot schema is
shared in `web/src/render/types.ts`. Visibility uses only VERA entity admission
and the viewer fog bitmask (`cells`: bit 0 explored, bit 1 visible).

`npm run check:assets` validates every generated PNG path and PNG header, atlas
frame bounds/anchors, the required starting and production art for all three
factions, native 32-facing voxel coverage, infantry walking sequences, map starts,
and the native color-ramp dimensions. It runs after export in the unified build.

The optional `names` dictionary resolves registered type `UIName` keys through
retail `RA2MD.CSF`, so browser HUD labels can use the same localized names while
the bridge retains stable English type identifiers. `asset-export --names-only`
adds that dictionary to an existing catalog without rewriting any map or sprite
PNG; a normal full export includes it automatically.
