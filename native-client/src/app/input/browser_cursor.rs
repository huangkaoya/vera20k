//! Pointer Lock keeps the OS pointer inside the browser while VERA retains its
//! ordinary software cursor and edge-scroll hit tests. Winit already converts
//! web movement deltas to physical pixels, so do not multiply them by DPR again.
//! https://www.w3.org/TR/pointerlock-2/ (locked absolute coordinates are frozen).

fn moved_position(
    position: (f64, f64),
    physical_delta: (f64, f64),
    size: (u32, u32),
) -> Option<(f64, f64)> {
    if size.0 == 0
        || size.1 == 0
        || !position.0.is_finite()
        || !position.1.is_finite()
        || !physical_delta.0.is_finite()
        || !physical_delta.1.is_finite()
    {
        return None;
    }
    Some((
        (position.0 + physical_delta.0).clamp(0.0, f64::from(size.0 - 1)),
        (position.1 + physical_delta.1).clamp(0.0, f64::from(size.1 - 1)),
    ))
}

pub(crate) fn sensitivity_gain(percent: u32) -> Option<f64> {
    (25..=400)
        .contains(&percent)
        .then_some(f64::from(percent) / 100.0)
}

#[cfg(target_arch = "wasm32")]
mod web {
    use std::cell::Cell;

    use winit::dpi::PhysicalPosition;
    use winit::platform::web::WindowExtWebSys;

    use crate::app::{AppState, GameScreen};

    thread_local! {
        static FROM_RELATIVE: Cell<bool> = const { Cell::new(false) };
        static CAPTURE_ALLOWED: Cell<bool> = const { Cell::new(false) };
        static MOTION: Cell<MotionTotals> = const { Cell::new(MotionTotals::EMPTY) };
        static RELATIVE_START: Cell<Option<(f64, f64)>> = const { Cell::new(None) };
    }

    #[derive(Clone, Copy)]
    struct MotionTotals {
        samples: u64,
        physical: (f64, f64),
        applied: (f64, f64),
    }

    impl MotionTotals {
        const EMPTY: Self = Self {
            samples: 0,
            physical: (0.0, 0.0),
            applied: (0.0, 0.0),
        };
    }

    fn accumulated(current: f64, delta: f64) -> f64 {
        (current + delta).clamp(-1.0e12, 1.0e12)
    }

    pub(crate) fn gain(state: &AppState) -> f64 {
        super::sensitivity_gain(state.persistence.options_profile.mouse_sensitivity_percent)
            .unwrap_or(1.0)
    }

    /// Derived by the same app pass that owns menu transitions. The browser's
    /// diagnostics getter can read it immediately without a second AppState
    /// borrow or waiting for the low-frequency full diagnostic snapshot.
    pub(crate) fn policy() -> bool {
        CAPTURE_ALLOWED.with(Cell::get)
    }

    pub(crate) fn diagnostics(state: &AppState) -> serde_json::Value {
        let totals = MOTION.with(Cell::get);
        serde_json::json!({"gain": gain(state), "samples": totals.samples,
            "physicalInput": {"x": totals.physical.0, "y": totals.physical.1},
            "appliedWindowDelta": {"x": totals.applied.0, "y": totals.applied.1},
            "windowScale": state.platform.window.scale_factor(),
            "zoomScale": state.tactical_zoom().map_or(1.0, |zoom| zoom.scale())})
    }

    /// One gameplay-context owner for native input and the browser adapter.
    /// Menus retain ordinary absolute input and must never trap the OS pointer.
    pub(crate) fn eligible(state: &AppState) -> bool {
        state.platform.cursor_confined
            && !state.touch_input_mode()
            && state.frontend.screen == GameScreen::InGame
            && state.match_state.sim_runtime.is_some()
            && !state.match_state.paused()
            && !state.match_state.match_presentation.in_game_menu.is_open()
            && !state.match_state.network_wait.dialog_open()
            && !state.main_menu_dialog_open()
            && !crate::app::frontend::skirmish_shell_render::native_in_game_shell_active(state)
            && state.match_state.input.ios_controls.editor.is_none()
            && state.match_state.scenario_outcome.is_none()
            && state.match_state.scenario_exit.is_none()
            && state.platform.window_active
            && !state.platform.window_hidden
            && state.platform.capture_client_size.is_none()
    }

    fn locked(state: &AppState) -> bool {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return false;
        };
        let Some(element) = document.pointer_lock_element() else {
            return false;
        };
        state
            .platform
            .window
            .canvas()
            .is_some_and(|canvas| element.is_same_node(Some(canvas.as_ref())))
    }

    pub(crate) fn apply(state: &AppState) {
        // The invisible JS adapter owns requests from trusted mouse gestures.
        // Native policy releases on menu transitions; browser focus handling
        // also releases. Observe actual ownership, never infer request success.
        let allowed = eligible(state);
        CAPTURE_ALLOWED.with(|policy| policy.set(allowed));
        // Native menu changes precede the diagnostic snapshot consumed by JS.
        // Release at this owner's next app pass instead of waiting for the
        // browser's 250 ms diagnostic/100 ms adapter polling cadence.
        if !allowed {
            release(state);
        } else {
            state.platform.pointer_held.set(locked(state));
        }
    }

    pub(crate) fn release(state: &AppState) {
        CAPTURE_ALLOWED.with(|policy| policy.set(false));
        state.platform.pointer_held.set(false);
        if locked(state)
            && let Some(document) = web_sys::window().and_then(|window| window.document())
        {
            document.exit_pointer_lock();
        }
    }

    pub(crate) fn begin_relative(position: (f32, f32)) {
        FROM_RELATIVE.with(|active| active.set(true));
        RELATIVE_START
            .with(|start| start.set(Some((f64::from(position.0), f64::from(position.1)))));
    }

    pub(crate) fn end_relative(position: (f32, f32)) {
        FROM_RELATIVE.with(|active| active.set(false));
        if let Some(start) = RELATIVE_START.with(|start| start.take()) {
            let delta = (
                f64::from(position.0) - start.0,
                f64::from(position.1) - start.1,
            );
            if delta.0.is_finite() && delta.1.is_finite() {
                MOTION.with(|motion| {
                    let mut totals = motion.get();
                    totals.applied.0 = accumulated(totals.applied.0, delta.0);
                    totals.applied.1 = accumulated(totals.applied.1, delta.1);
                    motion.set(totals);
                });
            }
        }
    }

    pub(crate) fn raw_motion(state: &AppState, delta: (f64, f64)) -> Option<PhysicalPosition<f64>> {
        apply(state);
        if !state.platform.pointer_held.get() {
            return None;
        }
        let (x, y) = state.window_cursor_position();
        let size = state.platform.window.inner_size();
        let gain = gain(state);
        let point = super::moved_position(
            (f64::from(x), f64::from(y)),
            (delta.0 * gain, delta.1 * gain),
            (size.width, size.height),
        )?;
        MOTION.with(|motion| {
            let mut totals = motion.get();
            totals.samples = totals.samples.saturating_add(1);
            totals.physical.0 = accumulated(totals.physical.0, delta.0);
            totals.physical.1 = accumulated(totals.physical.1, delta.1);
            motion.set(totals);
        });
        Some(PhysicalPosition::new(point.0, point.1))
    }

    pub(crate) fn absolute_motion(
        state: &AppState,
        position: PhysicalPosition<f64>,
    ) -> Option<PhysicalPosition<f64>> {
        // Browser offsetX/Y remain at the lock anchor. Only our integrated
        // relative event may update the existing window-pointer owner.
        if !eligible(state) || !locked(state) || FROM_RELATIVE.with(Cell::get) {
            Some(position)
        } else {
            None
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) use web::{
    absolute_motion, apply, begin_relative, diagnostics, eligible, end_relative, gain, policy,
    raw_motion, release,
};

#[cfg(test)]
mod tests {
    use super::moved_position;

    #[test]
    fn physical_web_delta_is_applied_once() {
        assert_eq!(
            moved_position((400.0, 300.0), (20.0, -10.0), (1600, 1200)),
            Some((420.0, 290.0))
        );
    }

    #[test]
    fn pointer_reaches_exact_edge_pixels_and_can_move_back_inward() {
        assert_eq!(
            moved_position((400.0, 300.0), (-10000.0, -10000.0), (800, 600)),
            Some((0.0, 0.0))
        );
        assert_eq!(
            moved_position((0.0, 0.0), (1.0, 1.0), (800, 600)),
            Some((1.0, 1.0))
        );
        assert_eq!(
            moved_position((1.0, 1.0), (10000.0, 10000.0), (800, 600)),
            Some((799.0, 599.0))
        );
    }

    #[test]
    fn unavailable_or_invalid_motion_never_poisons_cursor_state() {
        for (position, delta, size) in [
            ((0.0, 0.0), (1.0, 1.0), (0, 600)),
            ((0.0, 0.0), (1.0, 1.0), (800, 0)),
            ((f64::NAN, 0.0), (1.0, 1.0), (800, 600)),
            ((0.0, 0.0), (f64::INFINITY, 1.0), (800, 600)),
        ] {
            assert_eq!(moved_position(position, delta, size), None);
        }
    }

    #[test]
    fn bounded_sensitivity_has_one_linear_factor_and_rejects_invalid_settings() {
        for (percent, expected) in [(25, 0.25), (100, 1.0), (200, 2.0), (400, 4.0)] {
            let gain = super::sensitivity_gain(percent).unwrap();
            assert_eq!(gain, expected);
            assert_eq!(
                moved_position((500.0, 500.0), (20.0 * gain, -10.0 * gain), (1600, 1200)),
                Some((500.0 + 20.0 * expected, 500.0 - 10.0 * expected))
            );
        }
        for invalid in [0, 24, 401, u32::MAX] {
            assert_eq!(super::sensitivity_gain(invalid), None);
        }
    }
}
