//! Bridge layer transitions — applies the on_bridge cell-flag predicate at each
//! cell boundary crossing. The runtime bridge state is predicate-driven, never
//! derived from an A* path layer: the two disagree at ramp cells.
//!
//! Predicate:
//!   Enter:  dst.height_level == src.height_level - 4 AND dst has bridge structural flag
//!   Exit:   !(dst has bridge structural flag) AND src has bridge structural flag
//! Both conditions independent; signed i8 height arithmetic.
//!
//! Native source for that predicate is each ground locomotor's own movement
//! step, not a shared helper - see `compute_bridge_transition` below for the
//! two verified copies and their addresses.
//!
//! See docs/plans/2026-05-11-bridge-locomotor-layer-correctness-design.md.

use crate::sim::components::Position;
use crate::sim::movement::locomotor::LocomotorState;
#[cfg(any(test, feature = "test-support"))]
use crate::sim::movement::locomotor::MovementLayer;
use crate::sim::pathfinding::PathGrid;

/// ObjectClass::OnBridge (`Object+0x8C`): the object stands on a bridge deck,
/// not the ground beneath it. The ObjectClass constructor clears it
/// (`0x005F396F`), and the map's Unit and Infantry entries read it
/// (`0x007434F3`, `0x0051FDB2`). A ground Foot's cell crossing stores it
/// through [`apply_bridge_layer_state`]. Every other writer ports a native
/// store and cites it at the call: the air and Teleport movers, the drop and
/// parachute paths, and the placements that copy a building's or a
/// transport's OnBridge to the occupants it leaves. The locomotor's cached
/// layer projects it ([`LocomotorState::store_ground_layer`]), and VERA's
/// coarse level adds the deck for it ([`stored_level`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub(crate) struct OnBridge(bool);

impl OnBridge {
    /// Whether the object stands on a bridge deck.
    pub(crate) const fn get(self) -> bool {
        self.0
    }

    /// Store OnBridge, as the native writer the caller ports does.
    pub(crate) fn store(&mut self, on_bridge: bool) {
        self.0 = on_bridge;
    }
}

/// Result of the gamemd on_bridge transition predicate at a cell boundary.
///
/// Two independent conditions:
///   Enter: dst.height_level == src.height_level - 4 AND dst has bridge structural flag
///   Exit:  !(dst has bridge structural flag) AND src has bridge structural flag
/// Both conditions are mutually exclusive on retail data but evaluated
/// independently to match the original behavior exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BridgeTransition {
    /// Unit just entered the bridge body deck. Sets on_bridge=true. Z is
    /// recomputed from the terrain level plus the post-transition flag, per
    /// `ObjectClass::SetHeight` 0x005F5FA0.
    Enter,
    /// Unit just exited the bridge structure. Sets on_bridge=false.
    Exit,
    /// No layer-state change at this transition.
    NoChange,
}

/// Bridge state update produced by `resolve_cell_transition_bridge_state`.
/// Drives `on_bridge` independently from `loco.layer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BridgeStateUpdate {
    /// on_bridge = true
    Set,
    /// on_bridge = false
    Clear,
    /// Leave on_bridge unchanged
    Unchanged,
}

/// Persisted analogue of the runtime Foot bridge-state mismatch byte
/// (`Foot+0x68B`).
///
/// The Foot constructor zeroes it (`0x004D33BA`); the Drive (`0x004B3391`,
/// `0x004B45ED`) and Walk (`0x0075B662`) movement processors set it when the
/// candidate cell's bridge bit and the current bridge state differ
/// ([`Self::latch`]), and nothing clears it. It is intentionally independent
/// from A* bridge-layer selection and from the `on_bridge` occupancy byte.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct RuntimeBridgeTransitionState {
    pending_mismatch: bool,
}

impl RuntimeBridgeTransitionState {
    /// `Foot+0x68B`: a bridge mismatch was seen.
    pub(crate) const fn pending_mismatch(self) -> bool {
        self.pending_mismatch
    }

    /// The mismatch store, `Foot+0x68B = 1`.
    pub(super) fn latch(&mut self) {
        self.pending_mismatch = true;
    }
}

/// Read-only runtime bridge row for oracle diagnostics.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct BridgeRuntimeOracleTick {
    pub tick: u64,
    pub current_cell: (u16, u16),
    pub next_cell: (u16, u16),
    pub loco_layer_before: MovementLayer,
    pub next_path_layer: MovementLayer,
    pub on_bridge_before: bool,
    pub on_bridge_after: bool,
    pub bridge_update: String,
    pub visible_z_after: u8,
}

pub(super) fn projected_on_bridge(current: bool, update: BridgeStateUpdate) -> bool {
    match update {
        BridgeStateUpdate::Set => true,
        BridgeStateUpdate::Clear => false,
        BridgeStateUpdate::Unchanged => current,
    }
}

/// The on_bridge cell-flag predicate at a cell-boundary crossing.
///
/// gamemd has no shared helper for this: each ground locomotor carries its
/// own copy of the same block, and the two that matter agree instruction for
/// instruction.
///
/// `WalkLocomotionClass::ProcessMovement` 0x0075C154 - 0x0075C199 and
/// `DriveLocomotionClass::Process_Drive_Track` 0x004B2561 - 0x004B259B, with
/// ESI/ECX the source cell and EAX the destination cell:
///
/// ```text
/// MOVSX EDX, byte [src + 0x11B]      ; source ground level, SIGNED
/// MOVSX EDI, byte [dst + 0x11B]      ; destination ground level, SIGNED
/// SUB   EDX, 4
/// CMP   EDI, EDX          ; JNZ over the enter arm
///   TEST [dst + 0x140], 0x100        ; JZ over the enter arm
///     foot->+0x8C = 1                ; ENTER
/// TEST  [dst + 0x140], 0x100         ; JNZ done - destination is a bridge cell
/// TEST  [src + 0x140], 0x100         ; JZ  done - source was not
///   foot->+0x8C = 0                  ; EXIT
/// ```
///
/// So the enter arm is an exact equality on level indices and the exit arm
/// reads only the two bridge flags. Both arms are evaluated in sequence, not
/// as if/else, which is what the function below does.
///
/// `ObjectClass::ShouldBeOnBridge` 0x005F6A70 is NOT this predicate despite
/// the name - it compares ground heights in leptons at the object's
/// destination coordinate and feeds zone reachability queries. See
/// the ShouldBeOnBridge residual note in this file's tests module for the
/// evidence and the one place the two really do diverge.
///
/// Height arithmetic uses signed i8 via `wrapping_sub` where the native
/// sign-extends to 32 bits first and subtracts without wrapping. The two
/// disagree only for a source level in 128..=131, where `wrapping_sub` lands
/// back inside the i8 range and can match a destination level of 124..=127
/// that the native's -132..=-129 never equals. Retail maps use levels 0-15,
/// so no map reaches it; recorded rather than papered over.
pub(super) fn compute_bridge_transition(
    src: &crate::sim::pathfinding::PathCell,
    dst: &crate::sim::pathfinding::PathCell,
) -> BridgeTransition {
    let src_h = src.ground_level as i8;
    let dst_h = dst.ground_level as i8;

    let entry = dst_h == src_h.wrapping_sub(4) && dst.has_structural_bridge();
    let exit = !dst.has_structural_bridge() && src.has_structural_bridge();

    if entry {
        return BridgeTransition::Enter;
    }
    if exit {
        return BridgeTransition::Exit;
    }
    BridgeTransition::NoChange
}

/// Apply the on_bridge cell-flag predicate at a cell-boundary crossing.
///
/// Reads src and dst PathCells and computes the BridgeStateUpdate using
/// `compute_bridge_transition`. Writes `position.z` to the post-transition height
/// (deck_level on Enter, dst.ground_level on Exit, or next_layer's effective height
/// on NoChange).
///
/// Does NOT return a layer. The predicate drives `on_bridge` via the returned
/// `BridgeStateUpdate`.
///
/// Fallback: returns `Unchanged` (no position.z modification) when `path_grid` is
/// `None` or either cell lookup is out-of-bounds. Out-of-bounds at the boundary
/// crossing indicates a path-data bug elsewhere; the resolver is not the recovery point.
pub(super) fn resolve_cell_transition_bridge_state(
    position: &mut Position,
    path_grid: Option<&PathGrid>,
    src: (u16, u16),
    dst: (u16, u16),
    on_bridge_before: bool,
) -> BridgeStateUpdate {
    let Some(grid) = path_grid else {
        return BridgeStateUpdate::Unchanged;
    };
    let (Some(src_cell), Some(dst_cell)) = (grid.cell(src.0, src.1), grid.cell(dst.0, dst.1))
    else {
        return BridgeStateUpdate::Unchanged;
    };

    // The predicate owns the flag; the height function owns Z. Keeping them
    // separate is the native split, and it is why Z is recomputed here from the
    // post-transition flag rather than carried out of the transition arm.
    let transition = compute_bridge_transition(src_cell, dst_cell);
    let update = match transition {
        BridgeTransition::Enter => BridgeStateUpdate::Set,
        BridgeTransition::Exit => BridgeStateUpdate::Clear,
        BridgeTransition::NoChange => BridgeStateUpdate::Unchanged,
    };
    let on_bridge_after = projected_on_bridge(on_bridge_before, update);

    // `ObjectClass::SetHeight` 0x005F5FA0:
    //   Location.Z = CellClass::GetGroundHeight(own cell) + arg
    //                + (OnBridge ? g_nFootOnBridgeDeckOffsetLeptons : 0)
    // The ground term (`CellClass::ComputeGroundHeightAtCoord` 0x0047B3A0) reads
    // the destination cell's own signed terrain level and consults no bridge
    // field; the deck term is gated on the object's `+0x8C` OnBridge byte and
    // nothing else. There is no stored per-cell deck height in the native model
    // and therefore no value that can be absent, so this must not consult the A*
    // layer or any cell-side walkability permission — both are VERA inventions
    // that silently substituted ground level for the deck.
    position.store_cell_level(dst_cell.ground_level, on_bridge_after);
    // Raw Object Z has a separate setter cadence. Paid Drive/Ship points and
    // Walk commits refresh it; a residual crossing retains it (0x4B253F).
    update
}

/// The coarse level VERA stores in [`Position::z`] for an object standing in
/// a cell of terrain `level` (the cell's raw signed byte): that level, plus
/// the bridge deck when OnBridge — `ObjectClass::SetHeight @ 0x005F5FA0`'s
/// Z at height 0, in whole levels. Every mover that changes cell keeps it,
/// since sight, radar, selection depth and crew placement read it.
pub(crate) fn stored_level(level: u8, on_bridge: bool) -> u8 {
    level.wrapping_add(if on_bridge {
        crate::util::lepton::BRIDGE_DECK_HEIGHT_LEVELS as u8
    } else {
        0
    })
}

/// Diagnostic wrapper for a single boundary crossing. It computes the same
/// bridge update as `resolve_cell_transition_bridge_state` and returns an
/// oracle row; callers opt in explicitly from tests/tools.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn resolve_cell_transition_bridge_state_oracle(
    position: &mut Position,
    path_grid: Option<&PathGrid>,
    src: (u16, u16),
    dst: (u16, u16),
    current_layer: MovementLayer,
    next_layer: MovementLayer,
    on_bridge_before: bool,
    tick: u64,
) -> (BridgeStateUpdate, BridgeRuntimeOracleTick) {
    let update =
        resolve_cell_transition_bridge_state(position, path_grid, src, dst, on_bridge_before);
    let on_bridge_after = projected_on_bridge(on_bridge_before, update);
    let row = BridgeRuntimeOracleTick {
        tick,
        current_cell: src,
        next_cell: dst,
        loco_layer_before: current_layer,
        next_path_layer: next_layer,
        on_bridge_before,
        on_bridge_after,
        bridge_update: format!("{:?}", update),
        visible_z_after: position.z(),
    };
    (update, row)
}

/// Apply the post-resolver bridge state to a ground Foot at a cell crossing
/// (the Walk boundary, a Drive/Ship track crossing).
///
/// `on_bridge` follows the cell-flag predicate's `bridge_update`, never a path
/// layer: on a ramp going up the A* layer is Bridge before the predicate fires
/// Enter, and going down it is Ground while OnBridge is still set. A Foot
/// keeps no path layer; its `loco.layer` is the OnBridge projection, which is
/// what its next Find_Path starts from (AStar 0x00429A90 picks the start
/// height from Foot+0x8C).
///
/// The predicate's stores are each ground locomotor's own copy: Walk
/// `0x0075C179`/`0x0075C193`, and the Drive track's paid point
/// (`0x004B1830`/`0x004B184A`) and residual step (`0x004B2586`/`0x004B25A0`),
/// with Ship's at `0x006A0EBC`/`0x006A0ED6` and `0x006A1BD7`/`0x006A1BF1`.
pub(super) fn apply_bridge_layer_state(
    locomotor: &mut Option<LocomotorState>,
    on_bridge: &mut OnBridge,
    bridge_update: BridgeStateUpdate,
) {
    match bridge_update {
        BridgeStateUpdate::Set => on_bridge.store(true),
        BridgeStateUpdate::Clear => on_bridge.store(false),
        BridgeStateUpdate::Unchanged => {}
    }
    if let Some(loco) = locomotor {
        loco.store_ground_layer(on_bridge.get());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::util::fixed_math::SimFixed;

    // ------------------------------------------------------------------------
    // Resolver tests (resolve_cell_transition_bridge_state)
    // ------------------------------------------------------------------------

    use crate::sim::components::Position;
    use crate::sim::pathfinding::PathGrid;

    fn make_grid_with_cells(cells: &[(u16, u16, u8, bool, bool)]) -> PathGrid {
        let mut g = PathGrid::new(16, 16);
        for &(x, y, ground_level, bridge_walkable, transition) in cells {
            g.set_cell_for_test(x, y, ground_level, bridge_walkable, transition);
        }
        g
    }

    // ------------------------------------------------------------------------
    // Full-span coarse bridge projection at each explicit cell transition.
    //
    // `ObjectClass::SetHeight` 0x005F5FA0 recomputes
    //   Location.Z = GroundHeight(own cell) + (OnBridge ? 4 levels : 0)
    // with no stored per-cell deck height and no second gate. These tests walk a
    // multi-cell span because a two-cell fixture is satisfied by the Enter
    // arm alone and proves nothing about the deck-to-deck steps in between,
    // which are where a tank actually spends the crossing. These assertions
    // concern legacy Position.z only. Authoritative raw Z follows SetHeight
    // cadence and can lag XY during Drive/Ship residual movement.
    // ------------------------------------------------------------------------

    fn pos_at(rx: u16, ry: u16, z: u8) -> Position {
        Position::new(rx, ry, z, None, SimFixed::ZERO, SimFixed::ZERO)
    }

    #[test]
    fn resolver_oracle_reports_runtime_bridge_split_fields() {
        let g = make_grid_with_cells(&[(5, 5, 4, true, true), (6, 5, 0, true, false)]);
        let mut p = pos_at(6, 5, 0);
        let (update, row) = resolve_cell_transition_bridge_state_oracle(
            &mut p,
            Some(&g),
            (5, 5),
            (6, 5),
            MovementLayer::Ground,
            MovementLayer::Bridge,
            false,
            123,
        );

        assert_eq!(update, BridgeStateUpdate::Set);
        assert_eq!(row.tick, 123);
        assert_eq!(row.next_path_layer, MovementLayer::Bridge);
        assert!(row.on_bridge_after);
        assert_eq!(row.visible_z_after, 4);
    }

    // ------------------------------------------------------------------------
    // Render-state apply tests (apply_bridge_layer_state)
    // ------------------------------------------------------------------------
}

// Bridge reachability residual.
//
// RESIDUAL - gamemd 0x005F6A70 `ObjectClass::ShouldBeOnBridge`, its
// FootClass override 0x004DDC40, and the reachability queries they feed.
//
// Corrected 2026-08-19. An earlier note in this file claimed this
// function was the native counterpart of `compute_bridge_transition` and
// that the port diverged from it. That pairing was wrong, and acting on
// it would have replaced a correct port. Slot +0xBC is genuinely
// ShouldBeOnBridge, but nothing behind that slot writes the OnBridge byte:
//
// * The transition really is the locomotor block cited on
//   `compute_bridge_transition` - the only `+0x8C = 1` stores on the
//   ground-movement path are 0x0075C179 (Walk) and 0x004B1830 / 0x004B2586
//   (Drive), each guarded by the level-equality and flag tests ported here.
// * The boundary-time clear is `FootClass::PerCellProcess`'s own tail:
//   `if (OnBridge && !(currentCell->+0x140 & 0x100)) vtable+0xEC`, where
//   +0xEC is `ObjectClass::DropIn` 0x005F4160 and the byte it zeroes at
//   `this+0x8C` is OnBridge.
// * `ShouldBeOnBridge` takes its candidate coordinate from vtable+0x4C,
//   which for a Foot is `FootClass::GetDestinationCoords` 0x004DBDF0 - the
//   NavCom destination or tube exit, not the next cell. Its result is
//   consumed as the source-side on-bridge argument of
//   `MapClass::Can_Reach_Zone` 0x0056D100. Three call sites verified with
//   the receiver read out of the disassembly - `FootClass::Locomotion_AI`
//   0x005210E9, `WalkLocomotionClass::ProcessMovement` 0x0075B163 and
//   `FootClass::PerCellProcess` 0x004D8BE6 - each pushing the result, then
//   `TechnoType+0x5B4` as the MovementZone, into the same query. Further
//   `[reg+0xBC]` sites on what is probably the same slot
//   (`FootClass::CanReachDestination` 0x004D38F3,
//   `TechnoClass::Set_Destination` 0x00741FE3,
//   `FootClass::Is_Cell_Harvestable` 0x004DCF6F) have NOT had their
//   receiver verified individually and are candidates only.
//
// What IS unported, and it is only this: gamemd answers those queries on
// the layer `ShouldBeOnBridge` returns, which is the mover's OnBridge byte
// *adjusted by where it is headed* -
//
// ```text
// if (!OnBridge && (gh_location - gh_destination) > 3 * 104
//     && (destinationCell->+0x140 & 0x100))   return 1;
// if ( OnBridge && (gh_destination - gh_location) > 3 * 104) return 0;
// return OnBridge;
// ```
//
// where both terms are `CellClass::GetGroundHeight` 0x00578080 results in
// leptons at exact coordinates, so they carry slope interpolation and are
// terrain heights, not deck heights. `104` is `g_nFootLevelHeightLeptons`
// 0x00AC13C8; its two derived globals, 2x for the flight threshold and 4x
// for the 416-lepton deck offset, are already pinned in `util::lepton`.
// VERA instead passes the mover's raw layer as `start_layer` and the goal
// cell's own bridge flag as `goal_layer` (`zone_search::admit_zone_search`,
// `zone_map::ZoneGrid::can_reach`).
//
// Trigger: a reachability query by a ground unit whose destination ground
// is four or more levels below its current ground and carries a bridge
// flag, or four or more levels above it - i.e. ordering a unit that is not
// yet on a bridge to a cell on the deck, or a unit on the deck to a cell
// up on the bank.
//
// Effect: the zone id is looked up on the wrong layer, so a move across a
// bridge can be judged unreachable, or judged reachable and pathed on the
// wrong layer. It moves where the unit ends up, not whether it renders on
// the deck.
//
// Frequency: `FootClass::Locomotion_AI` is a per-tick caller, so this is
// per tick per moving ground unit whose destination sits four or more
// levels off its current ground - not per order. On a bridged map with
// traffic crossing, that is often. The retracted note put the cadence at
// every cell crossing; the real one is lower than that but not by much,
// and it lands on a different system.
//
// Blocker: the one production search (`FootPathRequest::search`) passes
// the mover's current layer as `start_layer`, and this needs the mover's
// location and its destination coordinate at the same point, in leptons,
// to compute two `GetGroundHeight`s. That is a signature change along the
// Foot search, not a change here.
// Residual (formerly an ignored placeholder test): gamemd 0x005F6A70 adjusts the reachability on-bridge layer by destination ground height; VERA passes the raw mover layer.
// Unimplemented: destination-height on-bridge layer for Can_Reach_Zone 0x0056D100.
