//! Client-side in-game Options (0xBBB) state: the six [Options] values plus the
//! transient interaction state the overlay needs. App/ui-level only — never sim/.
//!
//! Values are stored in gamemd's INTERNAL representation: GameSpeed/ScrollRate are
//! 0..6 with 0 = fastest (the dialog slider position is `6 - value`); DetailLevel
//! is 0..2 direct. Defaults match gamemd OptionsClass::SetDefaults.

use crate::ui::shell::trackbar::{thumb_left, trackbar_position_from_x};
use crate::ui::skirmish_shell::RectPx;

/// GameSpeed/ScrollRate internal range (0 = fastest .. 6 = slowest).
pub const OPTIONS_SPEED_MIN: u32 = 0;
pub const OPTIONS_SPEED_MAX: u32 = 6;
/// DetailLevel range (0 = low .. 2 = high), direct (not inverted).
pub const OPTIONS_DETAIL_MAX: u32 = 2;
/// Web pointer movement gain. Independent of the map's ScrollRate and of
/// simulation speed; the shared settings profile persists this percentage.
pub const MOUSE_SENSITIVITY_MIN: u32 = 25;
pub const MOUSE_SENSITIVITY_MAX: u32 = 400;
pub const MOUSE_SENSITIVITY_STEP: u32 = 5;
pub const MOUSE_SENSITIVITY_DEFAULT: u32 = 100;
pub const MOUSE_SENSITIVITY_STOPS: u32 =
    (MOUSE_SENSITIVITY_MAX - MOUSE_SENSITIVITY_MIN) / MOUSE_SENSITIVITY_STEP;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InGameOptionsState {
    /// Internal GameSpeed 0..6 (0 = fastest). Slider position is `6 - game_speed`.
    pub game_speed: u32,
    /// Internal ScrollRate 0..6 (0 = fastest). Slider position is `6 - scroll_rate`.
    pub scroll_rate: u32,
    /// DetailLevel 0..2 (direct). Hidden in 0xBBB but carried for persistence.
    pub detail_level: u32,
    pub unit_action_lines: bool,
    pub show_hidden: bool,
    pub tooltips: bool,
    pub mouse_sensitivity_percent: u32,
    /// Transient: which owner-draw button is held (for the pressed frame).
    pub buttons: super::button::ShellButtonInteraction<u16>,
    /// Native4E2201..2229 projects the common audio-device predicate.
    pub sound_enabled: bool,
    /// Transient: control id of the slider currently being dragged, if any.
    pub dragging_slider: Option<u16>,
    /// Init hid the GameSpeed row this open (see `control_shown`).
    pub game_speed_hidden: bool,
}

impl Default for InGameOptionsState {
    fn default() -> Self {
        // gamemd OptionsClass::SetDefaults: GameSpeed 3, ScrollRate 3,
        // DetailLevel 2, UnitActionLines 1, ShowHidden 0, ToolTips 1.
        Self {
            game_speed: 3,
            scroll_rate: 3,
            detail_level: 2,
            unit_action_lines: true,
            show_hidden: false,
            tooltips: true,
            mouse_sensitivity_percent: MOUSE_SENSITIVITY_DEFAULT,
            buttons: Default::default(),
            sound_enabled: true,
            dragging_slider: None,
            game_speed_hidden: false,
        }
    }
}

impl InGameOptionsState {
    pub fn reset_mouse_sensitivity(&mut self) {
        self.mouse_sensitivity_percent = MOUSE_SENSITIVITY_DEFAULT;
    }

    /// Reset the transient interaction state when the overlay (re)opens; gamemd
    /// recreates the dialog each open, and init decides the GameSpeed row.
    pub fn on_open(&mut self, game_speed_hidden: bool) {
        self.buttons = Default::default();
        self.dragging_slider = None;
        self.game_speed_hidden = game_speed_hidden;
    }
}

/// Slider position (0..6) shown for an internal speed value: `6 - value`.
/// GameSpeed/ScrollRate only (DetailLevel is direct).
pub fn speed_slider_pos(internal: u32) -> u32 {
    OPTIONS_SPEED_MAX - internal.min(OPTIONS_SPEED_MAX)
}

/// Internal speed value from a slider position (0..6): `6 - pos`.
pub fn speed_from_slider_pos(pos: u32) -> u32 {
    OPTIONS_SPEED_MAX - pos.min(OPTIONS_SPEED_MAX)
}

pub fn normalized_mouse_sensitivity(value: i32) -> u32 {
    if !(MOUSE_SENSITIVITY_MIN as i32..=MOUSE_SENSITIVITY_MAX as i32).contains(&value) {
        return MOUSE_SENSITIVITY_DEFAULT;
    }
    ((value as u32 + MOUSE_SENSITIVITY_STEP / 2) / MOUSE_SENSITIVITY_STEP) * MOUSE_SENSITIVITY_STEP
}

pub fn mouse_sensitivity_slider_pos(percent: u32) -> u32 {
    (normalized_mouse_sensitivity(i32::try_from(percent).unwrap_or(-1)) - MOUSE_SENSITIVITY_MIN)
        / MOUSE_SENSITIVITY_STEP
}

pub fn mouse_sensitivity_from_slider_pos(position: u32) -> u32 {
    MOUSE_SENSITIVITY_MIN + position.min(MOUSE_SENSITIVITY_STOPS) * MOUSE_SENSITIVITY_STEP
}

pub fn mouse_sensitivity_thumb_left(percent: u32, rect: RectPx) -> i32 {
    thumb_left(
        mouse_sensitivity_slider_pos(percent) as i32,
        rect.w,
        0,
        MOUSE_SENSITIVITY_STOPS as i32,
    )
}

/// Control-local thumb left for BBB's plain rail. Active 4E1FE0 sends 4AC=0
/// at 4E207F..2089 / 4E2128..2132, disabling the default 50px plaque.
/// Native 61DA52..61DA79 and 61E486..61E4A8 project using range, not range+1.
pub fn plain_trackbar_thumb_left(position: u32, rect: RectPx) -> i32 {
    let range = OPTIONS_SPEED_MAX as i32;
    thumb_left(position.min(OPTIONS_SPEED_MAX) as i32, rect.w, 0, range)
}

/// Quantized position for BBB's plain rail. Native 61DC00..61DC58 uses
/// range+1 mouse partitions, unlike the range-based thumb projection above.
/// The shared implementation has original-instruction goldens in
/// tools/storage_oracle/launcher_trackbar.py; BBB supplies reserve=0 and range=6.
pub fn trackbar_pos_from_mouse_x(mouse_x: i32, min: i32, max: i32, rect: RectPx) -> i32 {
    min + trackbar_position_from_x(mouse_x - rect.x, rect.w, 0, (max - min).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_gamemd_setdefaults() {
        let s = InGameOptionsState::default();
        assert_eq!((s.game_speed, s.scroll_rate, s.detail_level), (3, 3, 2));
        assert!(s.unit_action_lines && !s.show_hidden && s.tooltips);
    }

    #[test]
    fn mouse_gain_range_round_trips_and_reset_keeps_map_and_game_speeds() {
        let mut state = InGameOptionsState::default();
        assert_eq!(state.mouse_sensitivity_percent, 100);
        for position in 0..=MOUSE_SENSITIVITY_STOPS {
            let percent = mouse_sensitivity_from_slider_pos(position);
            assert!((25..=400).contains(&percent));
            assert_eq!(percent % 5, 0);
            assert_eq!(mouse_sensitivity_slider_pos(percent), position);
        }
        for invalid in [-1, 0, 24, 401, i32::MAX] {
            assert_eq!(normalized_mouse_sensitivity(invalid), 100);
        }
        assert_eq!(normalized_mouse_sensitivity(103), 105);
        state.scroll_rate = 5;
        state.game_speed = 2;
        state.mouse_sensitivity_percent = 400;
        state.reset_mouse_sensitivity();
        assert_eq!(
            (
                state.mouse_sensitivity_percent,
                state.scroll_rate,
                state.game_speed
            ),
            (100, 5, 2)
        );
    }

    #[test]
    fn plain_192_rail_matches_original_thumb_and_partition_boundaries() {
        // Original-instruction fixture includes the ordinary BBB width192,
        // reserve0, range6 path, preserving D5 comparisons in the same oracle.
        let golden: serde_json::Value = serde_json::from_str(crate::test_fixture::text(
            "tools/storage_oracle/launcher_trackbar.json",
        ))
        .unwrap();
        let geometry = golden["geometries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["width"] == 192 && g["reserve"] == 0 && g["maximum"] == 6)
            .expect("ordinary BBB plain rail fixture");
        let rect = RectPx::new(216, 163, 192, 21);
        let positions = geometry["positions"].as_array().unwrap();
        let pointers = geometry["pointers"].as_array().unwrap();
        assert_eq!((positions.len(), pointers.len()), (7, 209));
        for sample in positions {
            let position = sample["position"].as_u64().unwrap() as u32;
            let left = plain_trackbar_thumb_left(position, rect);
            assert_eq!(left, sample["thumb_left"].as_i64().unwrap() as i32);
            assert_eq!(left + 12, sample["thumb_right"].as_i64().unwrap() as i32);
        }
        for sample in pointers {
            let x = sample["x"].as_i64().unwrap() as i32;
            let position = trackbar_pos_from_mouse_x(rect.x + x, 0, 6, rect);
            assert_eq!(
                position,
                sample["position"].as_i64().unwrap() as i32,
                "x={x}"
            );
            let left = plain_trackbar_thumb_left(position as u32, rect);
            assert_eq!(left, sample["thumb_left"].as_i64().unwrap() as i32, "x={x}");
        }
    }
}
