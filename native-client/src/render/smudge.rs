//! Static decal rendering for the SmudgeGrid.
//!
//! Reads the per-cell SmudgeGrid + SmudgeTypeRegistry and produces SpriteInstance
//! buffers for the active smudges. Drawn between the terrain pass and the
//! entity pass so smudges sit on top of the ground but underneath units and
//! buildings.
//!
//! Smudges are static — no animation, no remap, no facing. Multi-cell
//! SmudgeType SHPs have a single composite frame. Native asks every occupied
//! footprint cell to draw frame 0. On the selected coherent flat footprint with
//! uniform Cell material, each call recenters on the same origin and repeated
//! opaque draws are pixel-idempotent. This builder emits the origin once;
//! per-cell material differences and partially cleared footprints remain open.
//!
//! ## Dependency rules
//! - Part of render/ — depends on map/, rules/, sim/.
//! - Reads sim smudge state through immutable references; never mutates sim state.

use crate::map::lighting::CellLightGrid;
use crate::map::resolved_terrain::ResolvedTerrainGrid;
use crate::map::terrain::{TILE_WIDTH, TilePlacement, iso_to_screen};
use crate::render::batch::SpriteInstance;
use crate::render::palette_light::PaletteLight;
use crate::rules::smudge_type::SmudgeTypeRegistry;
use crate::sim::smudge_grid::SmudgeGrid;

#[cfg(test)]
#[path = "smudge_gpu_tests.rs"]
mod gpu_tests;

/// Type alias for clarity at call sites.
///
/// Smudges share `SpriteInstance` with every other static decal in the engine —
/// carrying the footprint position, atlas rectangle and current Cell material.
pub type SmudgeInstance = SpriteInstance;

/// In-range sprite ABI depth; the ordinary smudge passthrough pipeline reads
/// and writes no Z (native flags E00). Submission after terrain and before
/// entities establishes the layer, independently of this value.
const SMUDGE_DEPTH: f32 = 0.5;

/// Build a `SpriteInstance` buffer for visible smudges.
///
/// Cell4804B4→Smudge6B55F0 passes the Cell center X, unchanged tile Y, and
/// signed common intensity (+10C) with its CellConvert (+34). Original
/// full-view/type/SHP execution: `tools/spatial_oracle/smudge_render`.
///
/// `atlas_lookup` resolves a (smudge_type_id, frame_offset) to a TilePlacement
/// (atlas UVs + pixel size + draw offset). The closure is borrowed because the
/// smudge atlas lives on the renderer side and uses interior types we don't
/// want to expose here.
pub fn build_visible_instances(
    grid: &SmudgeGrid,
    registry: &SmudgeTypeRegistry,
    resolved_terrain: &ResolvedTerrainGrid,
    cell_lights: &CellLightGrid,
    atlas_lookup: &dyn Fn(u16, u8) -> Option<TilePlacement>,
    camera_x: f32,
    camera_y: f32,
    screen_w: f32,
    screen_h: f32,
) -> Vec<SmudgeInstance> {
    let mut instances: Vec<SmudgeInstance> = Vec::with_capacity(64);
    let view_right: f32 = camera_x + screen_w;
    let view_bottom: f32 = camera_y + screen_h;

    for (rx, ry, cell) in grid.iter_occupied() {
        let Some(type_id) = cell.type_id else {
            continue;
        };
        // Multi-cell smudge footprints are stored as W×H occupied cells, but
        // For the coherent flat uniform-material path, native per-cell
        // SmudgeTypeClass::Draw_It calls recenter frame0 at the same point.
        // Keep one opaque draw; unequal Cell material/partial clears remain
        // outside this optimization's demonstrated coverage.
        if cell.frame_offset != 0 {
            continue;
        }
        // Confirm the type still exists in the registry — defensive against
        // map/rules mismatches; an unknown id is silently skipped.
        if registry.get(type_id).is_none() {
            continue;
        }
        let Some(terrain_cell) = resolved_terrain.cell(rx, ry) else {
            continue;
        };
        let (sx, sy): (f32, f32) = iso_to_screen(rx, ry, terrain_cell.level);
        let placement: TilePlacement = match atlas_lookup(type_id, cell.frame_offset) {
            Some(p) => p,
            None => continue,
        };
        // iso_to_screen returns the NW corner of the cell's bounding box;
        // native caller adds half a tile only in X. Adding half-height in Y
        // here places the complete crater 15px too low. The atlas retains
        // the full-canvas centered anchor, as the native shape caller does.
        let draw_x = sx + TILE_WIDTH / 2.0 + placement.draw_offset[0];
        let draw_y = sy + placement.draw_offset[1];
        // Cull against the complete composite SHP bounds. Testing the origin
        // cell's diamond would hide a wide footprint while part of its art is
        // still inside the tactical viewport.
        if draw_x >= view_right || draw_x + placement.pixel_size[0] <= camera_x {
            continue;
        }
        if draw_y >= view_bottom || draw_y + placement.pixel_size[1] <= camera_y {
            continue;
        }
        instances.push(SmudgeInstance {
            position: [draw_x, draw_y],
            size: placement.pixel_size,
            uv_origin: placement.uv_origin,
            uv_size: placement.uv_size,
            depth: SMUDGE_DEPTH,
            tint: [1.0, 1.0, 1.0],
            alpha: 1.0,
            palette_light: PaletteLight::cell(cell_lights, (rx, ry), false),
            ..Default::default()
        });
    }
    instances
}
