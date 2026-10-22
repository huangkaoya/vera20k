//! Mouse ownership for the shared editable bar. Only its own panel can capture
//! a press; world and sidebar input continue through their ordinary owners.

use web_time::{Duration, Instant};
use winit::event::TouchPhase;

use super::super::ios_battle_touch::TouchRect;
use super::super::ios_shortcuts::{LandscapeLayout, Shortcut};

struct Press {
    command: Option<Shortcut>,
    rect: TouchRect,
    start: [f32; 2],
    position: [f32; 2],
    moved: bool,
    started: Instant,
}

#[derive(Default)]
pub(super) struct MouseHudPointer {
    press: Option<Press>,
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct MouseHudResult {
    pub consumed: bool,
    pub shortcut: Option<(Shortcut, bool)>,
}

pub(super) fn covers(layout: &LandscapeLayout, point: [f32; 2]) -> bool {
    layout.editor_panel.is_some() || layout.bar_background().contains(point)
}

impl MouseHudPointer {
    pub fn is_active(&self) -> bool {
        self.press.is_some()
    }

    pub fn reset(&mut self) {
        self.press = None;
    }

    pub fn is_pressed(&self, command: Shortcut) -> bool {
        self.press.as_ref().is_some_and(|press| {
            press.command == Some(command) && press.rect.contains(press.position)
        })
    }

    pub fn handle(
        &mut self,
        phase: TouchPhase,
        point: [f32; 2],
        now: Instant,
        layout: &LandscapeLayout,
    ) -> MouseHudResult {
        if phase == TouchPhase::Started {
            if !covers(layout, point) {
                return MouseHudResult::default();
            }
            let button = layout
                .buttons
                .iter()
                .find(|button| button.enabled && button.rect.contains(point));
            self.press = Some(Press {
                command: button.map(|button| button.command),
                rect: button.map_or(layout.bar_background(), |button| button.rect),
                start: point,
                position: point,
                moved: false,
                started: now,
            });
            return MouseHudResult {
                consumed: true,
                shortcut: None,
            };
        }
        let Some(press) = self.press.as_mut() else {
            // A map drag may end over this opaque bar. Consume that release
            // without inventing a button click or targeting the covered map.
            return MouseHudResult {
                consumed: phase == TouchPhase::Ended && covers(layout, point),
                shortcut: None,
            };
        };
        press.position = point;
        press.moved |= point
            .iter()
            .zip(press.start)
            .any(|(next, start)| (next - start).abs() > 7.0 * layout.touch.scale_factor);
        let shortcut = (phase == TouchPhase::Ended && press.rect.contains(point))
            .then(|| {
                press.command.map(|command| {
                    (
                        command,
                        !press.moved
                            && now.saturating_duration_since(press.started)
                                >= Duration::from_millis(500),
                    )
                })
            })
            .flatten();
        if matches!(phase, TouchPhase::Ended | TouchPhase::Cancelled) {
            self.press = None;
        }
        MouseHudResult {
            consumed: true,
            shortcut,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::ios_shortcuts::{Preferences, ShortcutEditor};
    use super::*;

    fn layout(scale: f32, editor: Option<&ShortcutEditor>) -> LandscapeLayout {
        LandscapeLayout::for_input(
            1280.0 * scale,
            720.0 * scale,
            scale,
            180.0 * scale,
            &Preferences::default(),
            editor,
            false,
        )
    }

    #[test]
    fn mouse_world_has_no_hidden_touch_targets_and_bar_matches_its_art() {
        for scale in [1.0, 3.0] {
            let layout = layout(scale, None);
            assert!(layout.touch.joystick.is_none());
            assert!(
                layout
                    .buttons
                    .iter()
                    .all(|button| { (button.rect.y - layout.bar_button_y()).abs() < 0.001 })
            );
            let mut pointer = MouseHudPointer::default();
            let world = [200.0 * scale, 300.0 * scale];
            assert!(
                !pointer
                    .handle(TouchPhase::Started, world, Instant::now(), &layout)
                    .consumed
            );
            assert!(
                !pointer
                    .handle(TouchPhase::Ended, world, Instant::now(), &layout)
                    .consumed
            );
            let blank = [1.0, layout.bar_background().y + scale];
            let world_release = pointer.handle(TouchPhase::Ended, blank, Instant::now(), &layout);
            assert!(world_release.consumed);
            assert_eq!(world_release.shortcut, None);
            assert!(
                pointer
                    .handle(TouchPhase::Started, blank, Instant::now(), &layout)
                    .consumed
            );
            let release = pointer.handle(TouchPhase::Ended, world, Instant::now(), &layout);
            assert!(release.consumed);
            assert_eq!(release.shortcut, None);
        }
    }

    #[test]
    fn team_button_uses_500ms_hold_and_release_outside_never_activates() {
        let layout = layout(1.0, None);
        let button = layout
            .buttons
            .iter()
            .find(|button| button.command == Shortcut::Team1)
            .unwrap();
        let point = button.rect.center();
        let now = Instant::now();
        let mut pointer = MouseHudPointer::default();
        pointer.handle(TouchPhase::Started, point, now, &layout);
        assert!(pointer.is_pressed(Shortcut::Team1));
        assert_eq!(
            pointer
                .handle(
                    TouchPhase::Ended,
                    point,
                    now + Duration::from_millis(500),
                    &layout
                )
                .shortcut,
            Some((Shortcut::Team1, true))
        );
        pointer.handle(TouchPhase::Started, point, now, &layout);
        assert_eq!(
            pointer
                .handle(TouchPhase::Ended, [point[0], 100.0], now, &layout)
                .shortcut,
            None
        );
        assert!(!pointer.is_pressed(Shortcut::Team1));
        pointer.handle(TouchPhase::Started, point, now, &layout);
        pointer.handle(TouchPhase::Moved, [point[0] + 20.0, point[1]], now, &layout);
        assert_eq!(
            pointer
                .handle(
                    TouchPhase::Ended,
                    point,
                    now + Duration::from_millis(600),
                    &layout
                )
                .shortcut,
            Some((Shortcut::Team1, false))
        );
    }

    #[test]
    fn editor_blocks_world_and_reuses_the_same_save_and_cancel_targets() {
        let editor = ShortcutEditor::new(&Preferences::default());
        let layout = layout(1.0, Some(&editor));
        assert!(covers(&layout, [900.0, 100.0]));
        let now = Instant::now();
        let mut pointer = MouseHudPointer::default();
        for command in [Shortcut::Save, Shortcut::Discard] {
            let point = layout
                .buttons
                .iter()
                .find(|button| button.command == command)
                .unwrap()
                .rect
                .center();
            pointer.handle(TouchPhase::Started, point, now, &layout);
            assert_eq!(
                pointer
                    .handle(TouchPhase::Ended, point, now, &layout)
                    .shortcut,
                Some((command, false))
            );
        }
    }

    #[test]
    fn mere_footer_hover_keeps_edge_scroll_available_but_a_press_owns_it() {
        let layout = layout(1.0, None);
        let point = [300.0, 719.0];
        let now = Instant::now();
        let mut pointer = MouseHudPointer::default();
        assert!(covers(&layout, point));
        pointer.handle(TouchPhase::Moved, point, now, &layout);
        assert!(!pointer.is_active());
        pointer.handle(TouchPhase::Started, point, now, &layout);
        assert!(pointer.is_active());
        pointer.handle(TouchPhase::Ended, point, now, &layout);
        assert!(!pointer.is_active());
    }
}
