//! Fixed native cell indexing — the 512-wide stride shared by every cell array.
//!
//! Map-owned (F05): the stride and linear-index rules are static facts of the
//! native cell grid, independent of any loaded map's playfield width.
//! `sim::cell_rect` re-exports these for its runtime consumers. The square
//! rings native cell searches walk ([`square_ring_cells`]) live here too.
//!
//! ## Dependency rules
//! - Part of map/; depends on nothing above std.

/// Retained CellClass allocation identity after a fixed-stride lookup. A real
/// index addresses the loaded terrain storage; Dummy always names the same
/// process object even when a later failed lookup changes its coordinate.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum NativeCellIdentity {
    Real(usize),
    Dummy,
}

/// Fixed cell-array stride — the engine indexes cells `y*0x200 + x` regardless of
/// the loaded map's playfield width. The valid linear range is `[0, MAX_CELL_INDEX]`.
/// This is NOT the loaded-map width index (that is `PathGrid`'s `y*width+x` cache).
pub const CELL_ROW_STRIDE: i64 = 0x200;
/// Highest valid linear cell index under the fixed 512-wide stride.
pub const MAX_CELL_INDEX: i64 = 0x3FFFF;

/// Cell coordinates cross the native seam as packed 16-bit words. Normalize at
/// that seam so the Rust-facing `i32` parameters cannot retain non-native high
/// bits.
pub(crate) const fn packed_cell_coord(x: i32, y: i32) -> (i32, i32) {
    (x as i16 as i32, y as i16 as i32)
}

/// Linear cell index using the fixed 512-wide stride (NOT the loaded-map width).
///
/// Returns `None` only when the index falls outside `[0, MAX_CELL_INDEX]`; the
/// dummy fallback (`get_cellclass_fallback`) turns that `None` into a non-null
/// reference, mirroring the engine's never-null `Get_CellClass`.
pub fn cell_linear_index(x: i32, y: i32) -> Option<i64> {
    let (x, y) = packed_cell_coord(x, y);
    let idx = (y as i64) * CELL_ROW_STRIDE + (x as i64);
    (0..=MAX_CELL_INDEX).contains(&idx).then_some(idx)
}

/// Canonical real slot selected by the packed fixed-stride Map lookup.
pub(crate) fn canonical_cell_coord(x: i32, y: i32) -> Option<(u16, u16)> {
    cell_linear_index(x, y).map(|index| {
        (
            (index % CELL_ROW_STRIDE) as u16,
            (index / CELL_ROW_STRIDE) as u16,
        )
    })
}

/// The cells of square ring `r` around `center` (`max(|dx|, |dy|) == r`), in
/// the fixed order gamemd's ring searches walk them:
///
/// 1. for `d = -r ..= r`: the north cell `(x + d, y - r)`, then the south cell
///    `(x + d, y + r)` — both apex rows together, west to east.
/// 2. for `e = 1 - r ..= r - 1`: the west cell `(x - r, y + e)`, then the east
///    cell `(x + r, y + e)` — the side columns' interior rows, north to south.
///
/// This is NOT a Manhattan diamond and NOT a continuous clockwise walk. At
/// `r == 0` the first loop runs once and north and south coincide, so the
/// centre comes TWICE (the second loop is empty): native's actual candidate
/// stream, which decides ties and candidate counts, so it is not deduplicated.
/// `TechnoClass::Greatest_Threat @ 0x006F8DF0` walks its rings this way, and so
/// does the nearby-cell search ([`crate::sim::find_nearby_cell`]).
pub(crate) fn square_ring_cells(center: (i32, i32), r: i32) -> impl Iterator<Item = (i32, i32)> {
    let (x, y) = center;
    let rows = (-r..=r).flat_map(move |d| [(x + d, y - r), (x + d, y + r)]);
    let columns = (1 - r..r).flat_map(move |e| [(x - r, y + e), (x + r, y + e)]);
    rows.chain(columns)
}
