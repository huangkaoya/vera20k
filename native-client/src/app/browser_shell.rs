//! Native presentation and input owner for browser services.
//!
//! JavaScript owns download/cache and transport operations; it may publish only
//! these semantic receipts. This owner paints real shell art/font and emits
//! intents, never simulation commands. No DOM UI or screenshot surface exists.
mod content;
mod lobby;
mod model;
mod text_input;

use serde::Deserialize;
use serde_json::{Value, json};
use winit::event::{ElementState, Ime, MouseButton, TouchPhase, WindowEvent};
use winit::keyboard::{Key, NamedKey};

use crate::app::{App, AppState};
use crate::render::batch::SpriteInstance;
use crate::render::shell_paint::{self, PaintButton, PaintLabel};
use crate::render::shell_text::ShellAlign;
use crate::ui::game_screen::GameScreen;
use crate::ui::shell::geom::RectPx;
use model::{ContentSnapshot, LobbySnapshot};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Surface {
    Content,
    Lobby,
}
impl Surface {
    fn name(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Lobby => "lobby",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditField {
    Name,
    Code,
}

#[derive(Clone)]
pub(super) struct Choice {
    pub label: String,
    pub action: Value,
}
#[derive(Clone)]
pub(super) enum ControlKind {
    Button,
    Check(bool),
    Edit(EditField),
    Select(Vec<Choice>),
}
#[derive(Clone)]
pub(super) struct Control {
    pub id: String,
    pub label: String,
    pub rect: RectPx,
    pub enabled: bool,
    pub action: Value,
    pub kind: ControlKind,
}
impl Control {
    pub fn button(
        id: impl Into<String>,
        label: impl Into<String>,
        rect: RectPx,
        enabled: bool,
        action: Value,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            rect,
            enabled,
            action,
            kind: ControlKind::Button,
        }
    }
    pub fn check(
        id: impl Into<String>,
        label: impl Into<String>,
        rect: RectPx,
        enabled: bool,
        checked: bool,
        action: Value,
    ) -> Self {
        Self {
            kind: ControlKind::Check(checked),
            ..Self::button(id, label, rect, enabled, action)
        }
    }
    fn edit(id: &str, value: &str, rect: RectPx, enabled: bool, field: EditField) -> Self {
        Self {
            kind: ControlKind::Edit(field),
            ..Self::button(id, value, rect, enabled, Value::Null)
        }
    }
    fn select(
        id: impl Into<String>,
        label: impl Into<String>,
        rect: RectPx,
        enabled: bool,
        choices: Vec<Choice>,
    ) -> Self {
        Self {
            kind: ControlKind::Select(choices),
            ..Self::button(id, label, rect, enabled, Value::Null)
        }
    }
}
pub(super) struct Label {
    pub text: String,
    pub rect: RectPx,
    pub rgb: [f32; 3],
}
impl Label {
    pub fn new(text: impl Into<String>, rect: RectPx) -> Self {
        Self {
            text: text.into(),
            rect,
            rgb: shell_paint::SHELL_TEXT_RGB_ENABLED,
        }
    }
}
pub(super) struct ProgressBar {
    pub rect: RectPx,
    pub fraction: f32,
}
#[derive(Default)]
pub(super) struct Panel {
    pub title: String,
    pub subtitle: String,
    pub controls: Vec<Control>,
    pub labels: Vec<Label>,
    pub bars: Vec<ProgressBar>,
}

#[derive(Default)]
pub(crate) struct BrowserShellUi {
    content: ContentSnapshot,
    lobby: LobbySnapshot,
    pressed: Option<String>,
    focused: Option<String>,
    popup: Option<String>,
    name: String,
    code: String,
    caret: usize,
    selection_all: bool,
    preedit: String,
    input_generation: u64,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Update {
    schema: u32,
    content: Option<ContentSnapshot>,
    lobby: Option<LobbySnapshot>,
}

#[cfg(target_arch = "wasm32")]
thread_local! { static PENDING: std::cell::RefCell<Update> = std::cell::RefCell::new(Update::default()); }

#[cfg(target_arch = "wasm32")]
pub(crate) fn update_snapshot(raw: &str) -> Result<(), String> {
    if raw.len() > 256 * 1024 {
        return Err("browser shell snapshot exceeds 256 KiB".into());
    }
    let update: Update = serde_json::from_str(raw)
        .map_err(|error| format!("invalid browser shell snapshot: {error}"))?;
    if update.schema != 1 {
        return Err("unsupported browser shell snapshot schema".into());
    }
    PENDING.with(|pending| {
        let mut pending = pending.borrow_mut();
        if update.content.is_some() {
            pending.content = update.content;
        }
        if update.lobby.is_some() {
            pending.lobby = update.lobby;
        }
    });
    crate::app::browser::wake();
    Ok(())
}

fn emit(surface: Surface, mut action: Value) {
    if let Some(object) = action.as_object_mut() {
        object.insert("surface".into(), json!(surface.name()));
    } else {
        return;
    }
    #[cfg(target_arch = "wasm32")]
    {
        let Some(window) = web_sys::window() else {
            return;
        };
        let Ok(detail) = js_sys::JSON::parse(&action.to_string()) else {
            return;
        };
        let init = web_sys::CustomEventInit::new();
        init.set_detail(&detail);
        if let Ok(event) =
            web_sys::CustomEvent::new_with_event_init_dict("werhd-shell-action", &init)
        {
            let _ = window.dispatch_event(&event);
        }
    }
}

pub(crate) fn surface(state: &AppState) -> Option<Surface> {
    if state.frontend.screen != GameScreen::MainMenu {
        return None;
    }
    match state.frontend.shell_route {
        crate::app::shell_route::ShellRoute::BrowserContent => Some(Surface::Content),
        crate::app::shell_route::ShellRoute::BrowserLobby => Some(Surface::Lobby),
        _ => None,
    }
}

pub(crate) fn open(state: &mut AppState, page: Surface, pack: Option<&str>) {
    open_impl(state, page, pack, true);
}

fn open_impl(state: &mut AppState, page: Surface, pack: Option<&str>, notify: bool) {
    if state.frontend.screen != GameScreen::MainMenu {
        return;
    }
    // Tear down the old dialog's slide/movie ownership, not its game state.
    crate::app::frontend::main_menu_shell_render::clear_ra2ts_movie_session(state);
    crate::app::frontend::shell_transition::invalidate_main_menu_dialog_instance(state);
    state.frontend.shell_exit = None;
    state.frontend.shell_first_paint_slide = None;
    state.frontend.shell_slide_active_shell = None;
    let _ = App::ensure_skirmish_shell_chrome(state);
    state.frontend.shell_route = match page {
        Surface::Content => crate::app::shell_route::ShellRoute::BrowserContent,
        Surface::Lobby => crate::app::shell_route::ShellRoute::BrowserLobby,
    };
    let ui = &mut state.frontend.browser_shell;
    ui.pressed = None;
    ui.focused = None;
    ui.popup = None;
    ui.preedit.clear();
    ui.selection_all = false;
    ui.input_generation = ui.input_generation.wrapping_add(1);
    text_input::blur();
    match page {
        Surface::Content => ui.content.open = true,
        Surface::Lobby => ui.lobby.open = true,
    }
    let mut action = json!({"action":"open"});
    if let Some(pack) = pack {
        action["pack"] = json!(pack);
    }
    if notify {
        emit(page, action);
    }
    state.platform.window.request_redraw();
}

fn close(state: &mut AppState, notify: bool) {
    let Some(page) = surface(state) else {
        return;
    };
    state.frontend.browser_shell.pressed = None;
    state.frontend.browser_shell.popup = None;
    state.frontend.browser_shell.focused = None;
    state.frontend.browser_shell.preedit.clear();
    state.frontend.browser_shell.input_generation = state
        .frontend
        .browser_shell
        .input_generation
        .wrapping_add(1);
    text_input::blur();
    match page {
        Surface::Content => state.frontend.browser_shell.content.open = false,
        Surface::Lobby => state.frontend.browser_shell.lobby.open = false,
    }
    // Reuse the original menu constructor, including its controller and reveal.
    App::close_single_player_shell(state);
    if notify {
        emit(page, json!({"action":"close"}));
    }
    state.platform.window.set_ime_allowed(false);
    state.platform.window.request_redraw();
}

pub(crate) fn poll(state: &mut AppState) {
    #[cfg(target_arch = "wasm32")]
    {
        let update = PENDING.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
        if let Some(content) = update.content {
            let wants_open = content.open;
            state.frontend.browser_shell.content = content;
            // Content progress is observational. Only a native menu/campaign
            // action opens this page; background downloads never steal focus.
            if !wants_open && surface(state) == Some(Surface::Content) {
                close(state, false);
            }
        }
        if let Some(lobby) = update.lobby {
            let wants_open = lobby.open;
            let ui = &mut state.frontend.browser_shell;
            let editing = ui.focused.as_deref();
            if editing != Some("lobby.name") {
                ui.name = lobby.name.clone();
            }
            if editing != Some("lobby.code") {
                ui.code = lobby.code.clone();
            }
            ui.lobby = lobby;
            if wants_open
                && surface(state) != Some(Surface::Lobby)
                && state.frontend.screen == GameScreen::MainMenu
            {
                // The controller already owns this open receipt. Echoing an
                // open intent here would clear its newly published error.
                open_impl(state, Surface::Lobby, None, false);
            } else if !wants_open && surface(state) == Some(Surface::Lobby) {
                close(state, false);
            }
        }
    }
    let view = panel(state);
    let focused = state.frontend.browser_shell.focused.as_deref();
    let text_field_active = surface(state) == Some(Surface::Lobby)
        && view.controls.iter().any(|control| {
            control.enabled
                && Some(control.id.as_str()) == focused
                && matches!(control.kind, ControlKind::Edit(_))
        });
    if !text_field_active && text_input::active() {
        state.frontend.browser_shell.input_generation = state
            .frontend
            .browser_shell
            .input_generation
            .wrapping_add(1);
        text_input::blur();
    }
    if text_input::active() {
        App::set_window_active(state, text_input::document_focused());
    }
    for input in text_input::drain() {
        if !accepts_text_input(
            text_field_active,
            &input.field,
            input.generation,
            state.frontend.browser_shell.focused.as_deref(),
            state.frontend.browser_shell.input_generation,
        ) {
            continue;
        }
        match input.kind {
            text_input::InputKind::Commit(text) | text_input::InputKind::Paste(text) => {
                state.frontend.browser_shell.preedit.clear();
                edit(state, None, Some(&text));
            }
            text_input::InputKind::Preedit(text) => state.frontend.browser_shell.preedit = text,
            text_input::InputKind::Key {
                key,
                ctrl,
                meta,
                shift,
            } => platform_key(state, &key, ctrl || meta, shift),
        }
        state.platform.window.request_redraw();
    }
}

fn accepts_text_input(
    active: bool,
    field: &str,
    generation: u64,
    focused: Option<&str>,
    current_generation: u64,
) -> bool {
    active
        && matches!(field, "lobby.name" | "lobby.code")
        && generation == current_generation
        && Some(field) == focused
}

fn platform_key(state: &mut AppState, key: &str, command: bool, shift: bool) {
    if command {
        if key.eq_ignore_ascii_case("a") {
            state.frontend.browser_shell.selection_all = true;
        }
        return;
    }
    match key {
        "Escape" => {
            close(state, true);
        }
        "Tab" => {
            let view = panel(state);
            let all: Vec<_> = view
                .controls
                .into_iter()
                .filter(|control| control.enabled)
                .collect();
            if all.is_empty() {
                return;
            }
            let current = all.iter().position(|control| {
                Some(control.id.as_str()) == state.frontend.browser_shell.focused.as_deref()
            });
            let next = if shift {
                current.unwrap_or(0).checked_sub(1).unwrap_or(all.len() - 1)
            } else {
                current.map_or(0, |index| (index + 1) % all.len())
            };
            let control = all[next].clone();
            if matches!(control.kind, ControlKind::Edit(_)) {
                activate(state, control);
            } else {
                state.frontend.browser_shell.focused = Some(control.id);
                state.frontend.browser_shell.input_generation = state
                    .frontend
                    .browser_shell
                    .input_generation
                    .wrapping_add(1);
                text_input::blur();
            }
        }
        "Enter" => {
            if state.frontend.browser_shell.focused.as_deref() == Some("lobby.code") {
                if let Some(control) = panel(state)
                    .controls
                    .into_iter()
                    .find(|control| control.id == "lobby.join")
                {
                    activate(state, control);
                }
            }
        }
        "Backspace" => edit(state, Some(NamedKey::Backspace), None),
        "Delete" => edit(state, Some(NamedKey::Delete), None),
        "ArrowLeft" => edit(state, Some(NamedKey::ArrowLeft), None),
        "ArrowRight" => edit(state, Some(NamedKey::ArrowRight), None),
        "Home" => edit(state, Some(NamedKey::Home), None),
        "End" => edit(state, Some(NamedKey::End), None),
        text if text.chars().count() == 1 => edit(state, None, Some(text)),
        _ => {}
    }
}

fn panel(state: &AppState) -> Panel {
    match surface(state) {
        Some(Surface::Content) => content::view(&state.frontend.browser_shell.content),
        Some(Surface::Lobby) => lobby::view(
            &state.frontend.browser_shell.lobby,
            &state.frontend.browser_shell.name,
            &state.frontend.browser_shell.code,
        ),
        None => Panel::default(),
    }
}

#[derive(Clone, Copy)]
struct Fit {
    scale: f32,
    x: f32,
    y: f32,
}
impl Fit {
    fn new(width: u32, height: u32) -> Self {
        let scale = (width as f32 / 800.0).min(height as f32 / 600.0).max(0.1);
        Self {
            scale,
            x: (width as f32 - 800.0 * scale) * 0.5,
            y: (height as f32 - 600.0 * scale) * 0.5,
        }
    }
    fn rect(self, r: RectPx) -> RectPx {
        RectPx::new(
            (self.x + r.x as f32 * self.scale).round() as i32,
            (self.y + r.y as f32 * self.scale).round() as i32,
            (r.w as f32 * self.scale).round().max(1.0) as i32,
            (r.h as f32 * self.scale).round().max(1.0) as i32,
        )
    }
    fn point(self, x: f64, y: f64) -> (i32, i32) {
        (
            ((x as f32 - self.x) / self.scale) as i32,
            ((y as f32 - self.y) / self.scale) as i32,
        )
    }
}

fn controls(state: &AppState, view: &Panel) -> Vec<Control> {
    let mut result = view.controls.clone();
    if let Some(id) = state.frontend.browser_shell.popup.as_deref() {
        if let Some(control) = view
            .controls
            .iter()
            .find(|control| control.id == id && control.enabled)
        {
            if let ControlKind::Select(choices) = &control.kind {
                let height = choices.len() as i32 * 25;
                let y = (control.rect.y + control.rect.h).min(580 - height).max(70);
                for (index, choice) in choices.iter().enumerate() {
                    result.push(Control::button(
                        format!("popup.{index}"),
                        &choice.label,
                        RectPx::new(control.rect.x, y + index as i32 * 25, control.rect.w, 25),
                        true,
                        choice.action.clone(),
                    ));
                }
            }
        }
    }
    result
}

fn activate(state: &mut AppState, control: Control) {
    if !control.enabled {
        return;
    }
    match control.kind {
        ControlKind::Edit(field) => {
            state.frontend.browser_shell.focused = Some(control.id);
            state.frontend.browser_shell.caret = match field {
                EditField::Name => state.frontend.browser_shell.name.chars().count(),
                EditField::Code => state.frontend.browser_shell.code.chars().count(),
            };
            state.frontend.browser_shell.popup = None;
            state.frontend.browser_shell.preedit.clear();
            state.frontend.browser_shell.selection_all = false;
            state.frontend.browser_shell.input_generation = state
                .frontend
                .browser_shell
                .input_generation
                .wrapping_add(1);
            let generation = state.frontend.browser_shell.input_generation;
            let field = state
                .frontend
                .browser_shell
                .focused
                .clone()
                .unwrap_or_default();
            text_input::focus(&field, generation);
            state.platform.window.set_ime_allowed(true);
        }
        ControlKind::Select(_) => {
            let ui = &mut state.frontend.browser_shell;
            ui.popup = if ui.popup.as_deref() == Some(&control.id) {
                None
            } else {
                Some(control.id.clone())
            };
            ui.focused = Some(control.id);
            ui.preedit.clear();
            ui.selection_all = false;
            ui.input_generation = ui.input_generation.wrapping_add(1);
            text_input::blur();
            state.platform.window.set_ime_allowed(false);
        }
        _ => {
            state.frontend.browser_shell.popup = None;
            state.frontend.browser_shell.focused = Some(control.id);
            state.frontend.browser_shell.preedit.clear();
            state.frontend.browser_shell.selection_all = false;
            state.frontend.browser_shell.input_generation = state
                .frontend
                .browser_shell
                .input_generation
                .wrapping_add(1);
            text_input::blur();
            state.platform.window.set_ime_allowed(false);
            if control.action["action"].as_str() == Some("close") {
                close(state, true);
            } else if let Some(page) = surface(state) {
                emit(page, control.action);
            }
        }
    }
}

fn click(state: &mut AppState, pressed: bool) {
    let fit = Fit::new(
        state.renderer.gpu.config.width,
        state.renderer.gpu.config.height,
    );
    let (x, y) = fit.point(
        state.match_state.input.cursor_x as f64,
        state.match_state.input.cursor_y as f64,
    );
    let view = panel(state);
    let all = controls(state, &view);
    let hit = all
        .into_iter()
        .rev()
        .find(|control| control.enabled && control.rect.contains(x, y));
    if pressed {
        state.frontend.browser_shell.pressed = hit.as_ref().map(|control| control.id.clone());
    } else {
        let previous = state.frontend.browser_shell.pressed.take();
        if let Some(control) =
            hit.filter(|control| Some(control.id.as_str()) == previous.as_deref())
        {
            activate(state, control);
        } else if previous.is_none() {
            state.frontend.browser_shell.popup = None;
            state.frontend.browser_shell.focused = None;
            state.frontend.browser_shell.input_generation = state
                .frontend
                .browser_shell
                .input_generation
                .wrapping_add(1);
            text_input::blur();
            state.platform.window.set_ime_allowed(false);
        }
    }
}

fn edit(state: &mut AppState, key: Option<NamedKey>, text: Option<&str>) {
    let view = panel(state);
    if !view.controls.iter().any(|control| {
        control.enabled
            && Some(control.id.as_str()) == state.frontend.browser_shell.focused.as_deref()
            && matches!(control.kind, ControlKind::Edit(_))
    }) {
        return;
    }
    let ui = &mut state.frontend.browser_shell;
    let Some(field) = ui.focused.as_deref() else {
        return;
    };
    let (value, limit, is_code) = match field {
        "lobby.name" => (&mut ui.name, 24, false),
        "lobby.code" => (&mut ui.code, 12, true),
        _ => return,
    };
    let mut chars: Vec<_> = value.chars().collect();
    ui.caret = ui.caret.min(chars.len());
    if ui.selection_all
        && (text.is_some() || matches!(key, Some(NamedKey::Backspace | NamedKey::Delete)))
    {
        chars.clear();
        ui.caret = 0;
    }
    ui.selection_all = false;
    match key {
        Some(NamedKey::Backspace) if ui.caret > 0 => {
            ui.caret -= 1;
            chars.remove(ui.caret);
        }
        Some(NamedKey::Delete) if ui.caret < chars.len() => {
            chars.remove(ui.caret);
        }
        Some(NamedKey::ArrowLeft) => {
            ui.caret = ui.caret.saturating_sub(1);
        }
        Some(NamedKey::ArrowRight) => {
            ui.caret = (ui.caret + 1).min(chars.len());
        }
        Some(NamedKey::Home) => ui.caret = 0,
        Some(NamedKey::End) => ui.caret = chars.len(),
        _ => {
            if let Some(text) = text {
                for mut ch in text.chars().filter(|ch| !ch.is_control()) {
                    if chars.len() >= limit {
                        break;
                    }
                    if is_code {
                        if !ch.is_ascii_alphanumeric() {
                            continue;
                        }
                        ch = ch.to_ascii_uppercase();
                    }
                    chars.insert(ui.caret, ch);
                    ui.caret += 1;
                }
            }
        }
    }
    *value = chars.into_iter().collect();
    let action = if is_code {
        json!({"action":"setCode","code":value})
    } else {
        json!({"action":"setName","name":value})
    };
    emit(Surface::Lobby, action);
}

/// The page consumes its complete native pointer/keyboard stream before either
/// the retail menu controller or tactical input can see it.
pub(crate) fn handle_event(state: &mut AppState, event: &WindowEvent) -> bool {
    if surface(state).is_none() {
        return false;
    }
    match event {
        WindowEvent::CursorMoved { position, .. } => {
            state.match_state.input.cursor_x = position.x as f32;
            state.match_state.input.cursor_y = position.y as f32;
            state.platform.pointer_in_client = true;
        }
        WindowEvent::MouseInput {
            button: MouseButton::Left,
            state: edge,
            ..
        } => click(state, edge.is_pressed()),
        WindowEvent::MouseInput {
            button: MouseButton::Right,
            state: ElementState::Pressed,
            ..
        } => {
            state.frontend.browser_shell.popup = None;
        }
        WindowEvent::KeyboardInput { event, .. } => {
            if event.state.is_pressed() {
                match &event.logical_key {
                    Key::Named(NamedKey::Escape) => {
                        if state.frontend.browser_shell.popup.take().is_none() {
                            close(state, true);
                        }
                    }
                    Key::Named(NamedKey::Tab) => {
                        let view = panel(state);
                        let controls: Vec<_> =
                            view.controls.into_iter().filter(|c| c.enabled).collect();
                        let current = controls.iter().position(|c| {
                            Some(c.id.as_str()) == state.frontend.browser_shell.focused.as_deref()
                        });
                        if !controls.is_empty() {
                            let backwards = state.platform.live_modifiers.shift_key();
                            let next = if backwards {
                                current
                                    .unwrap_or(0)
                                    .checked_sub(1)
                                    .unwrap_or(controls.len() - 1)
                            } else {
                                current.map_or(0, |i| (i + 1) % controls.len())
                            };
                            let control = controls[next].clone();
                            state.frontend.browser_shell.focused = Some(control.id.clone());
                            if matches!(control.kind, ControlKind::Edit(_)) {
                                activate(state, control);
                            } else {
                                state.platform.window.set_ime_allowed(false);
                            }
                        }
                    }
                    Key::Named(NamedKey::ArrowDown | NamedKey::ArrowUp)
                        if state.frontend.browser_shell.popup.is_some() =>
                    {
                        let view = panel(state);
                        let all = controls(state, &view);
                        let choices: Vec<_> = all
                            .iter()
                            .filter(|control| control.id.starts_with("popup."))
                            .collect();
                        if !choices.is_empty() {
                            let current = choices.iter().position(|control| {
                                Some(control.id.as_str())
                                    == state.frontend.browser_shell.focused.as_deref()
                            });
                            let backwards = event.logical_key == Key::Named(NamedKey::ArrowUp);
                            let next = if backwards {
                                current
                                    .unwrap_or(0)
                                    .checked_sub(1)
                                    .unwrap_or(choices.len() - 1)
                            } else {
                                current.map_or(0, |index| (index + 1) % choices.len())
                            };
                            state.frontend.browser_shell.focused = Some(choices[next].id.clone());
                        }
                    }
                    Key::Named(NamedKey::Enter | NamedKey::Space) => {
                        let view = panel(state);
                        let all = controls(state, &view);
                        let id = state.frontend.browser_shell.focused.clone();
                        if let Some(control) = all.into_iter().find(|c| Some(&c.id) == id.as_ref())
                        {
                            if matches!(control.kind, ControlKind::Edit(EditField::Code))
                                && event.logical_key == Key::Named(NamedKey::Enter)
                            {
                                if let Some(join) =
                                    view.controls.into_iter().find(|c| c.id == "lobby.join")
                                {
                                    activate(state, join);
                                }
                            } else if matches!(control.kind, ControlKind::Edit(_)) {
                                edit(state, None, event.text.as_deref());
                            } else {
                                activate(state, control);
                            }
                        }
                    }
                    Key::Named(key) => edit(state, Some(*key), None),
                    Key::Character(_) => {
                        let select_all = matches!(&event.logical_key,Key::Character(value) if value.eq_ignore_ascii_case("a"))
                            && (state.platform.live_modifiers.control_key()
                                || state.platform.live_modifiers.super_key());
                        if select_all {
                            state.frontend.browser_shell.selection_all = true;
                        } else if !state.platform.live_modifiers.control_key()
                            && !state.platform.live_modifiers.super_key()
                        {
                            edit(state, None, event.text.as_deref());
                        }
                    }
                    _ => {}
                }
            }
        }
        WindowEvent::Ime(Ime::Commit(text)) => {
            state.frontend.browser_shell.preedit.clear();
            edit(state, None, Some(text));
        }
        WindowEvent::Ime(Ime::Preedit(text, _)) => {
            state.frontend.browser_shell.preedit = text.clone();
        }
        WindowEvent::Touch(touch) => {
            state.match_state.input.cursor_x = touch.location.x as f32;
            state.match_state.input.cursor_y = touch.location.y as f32;
            match touch.phase {
                TouchPhase::Started => click(state, true),
                TouchPhase::Ended => click(state, false),
                TouchPhase::Cancelled => state.frontend.browser_shell.pressed = None,
                _ => {}
            }
        }
        WindowEvent::Focused(false) => {
            // The hidden platform IME target is part of this native page.
            // Canvas -> IME focus is not an application focus loss.
            if text_input::active() && text_input::document_focused() {
                return true;
            }
            state.frontend.browser_shell.pressed = None;
            state.frontend.browser_shell.popup = None;
            return false;
        }
        WindowEvent::ModifiersChanged(_) => return false,
        WindowEvent::CursorEntered { .. } => {
            state.platform.pointer_in_client = true;
        }
        WindowEvent::CursorLeft { .. } => {
            state.platform.pointer_in_client = false;
            state.frontend.browser_shell.pressed = None;
        }
        WindowEvent::MouseWheel { .. } | WindowEvent::MouseInput { .. } | WindowEvent::Ime(_) => {}
        _ => return false,
    }
    state.platform.window.request_redraw();
    true
}

pub(crate) fn render(
    state: &mut AppState,
    encoder: &mut wgpu::CommandEncoder,
    destination: &wgpu::Texture,
) -> anyhow::Result<()> {
    use crate::app::frontend::shell_pass::{
        ShellComposition, TexturedDraw, encode_shell_pass, software_cursor,
    };
    let view = panel(state);
    let all = controls(state, &view);
    let Some(atlas) = state.frontend.main_menu_shell_chrome.as_ref() else {
        return Ok(());
    };
    let fit = Fit::new(
        state.renderer.gpu.config.width,
        state.renderer.gpu.config.height,
    );
    let mut art = Vec::new();
    if let Some(background) = atlas.parent_background_large_mnscrnl {
        shell_paint::push_entry_sized(
            &mut art,
            background,
            0.0,
            0.0,
            [
                state.renderer.gpu.config.width as f32,
                state.renderer.gpu.config.height as f32,
            ],
            shell_paint::PARENT_BACKGROUND_DEPTH,
        );
    }
    let fill = |out: &mut Vec<SpriteInstance>, rect: RectPx, rgb: [f32; 3], depth: f32| {
        if let Some(pixel) = atlas.white_pixel {
            let rect = fit.rect(rect);
            shell_paint::push_entry_sized(
                out,
                pixel,
                rect.x as f32,
                rect.y as f32,
                [rect.w as f32, rect.h as f32],
                depth,
            );
            if let Some(last) = out.last_mut() {
                last.tint = rgb;
            }
        }
    };
    // Native shell list/edit bevel, integrated with the original parent art.
    fill(
        &mut art,
        RectPx::new(17, 82, 766, 456),
        [0.025, 0.035, 0.045],
        0.00089,
    );
    for (rect, color) in [
        (RectPx::new(16, 81, 768, 2), [0.43, 0.48, 0.5]),
        (RectPx::new(16, 81, 2, 457), [0.43, 0.48, 0.5]),
        (RectPx::new(16, 537, 768, 2), [0.15, 0.19, 0.21]),
        (RectPx::new(783, 81, 2, 458), [0.15, 0.19, 0.21]),
    ] {
        fill(&mut art, rect, color, 0.00088);
    }
    let mut labels = vec![
        PaintLabel {
            text: view.title.clone().into(),
            rect: fit.rect(RectPx::new(30, 20, 740, 28)),
            align: ShellAlign::H_CENTER,
            rgb: shell_paint::SHELL_TEXT_RGB_ENABLED,
            path_a_reveal: None,
        },
        PaintLabel {
            text: view.subtitle.clone().into(),
            rect: fit.rect(RectPx::new(32, 53, 736, 22)),
            align: ShellAlign::H_CENTER,
            rgb: [0.7, 0.77, 0.8],
            path_a_reveal: None,
        },
    ];
    for label in &view.labels {
        labels.push(PaintLabel {
            text: label.text.clone().into(),
            rect: fit.rect(label.rect),
            align: ShellAlign::NONE,
            rgb: label.rgb,
            path_a_reveal: None,
        });
    }
    let (cx, cy) = fit.point(
        state.match_state.input.cursor_x as f64,
        state.match_state.input.cursor_y as f64,
    );
    let mut checkbox_art = Vec::new();
    let mut popup_art = Vec::new();
    let mut popup_text = Vec::new();
    for control in &all {
        let popup = control.id.starts_with("popup.");
        let focused = state.frontend.browser_shell.focused.as_deref() == Some(&control.id);
        let pressed = state.frontend.browser_shell.pressed.as_deref() == Some(&control.id);
        let mut rect = control.rect;
        let mut caption = control.label.clone();
        match &control.kind {
            ControlKind::Button | ControlKind::Select(_) => {
                let mut sprites = shell_paint::paint_buttons(
                    atlas,
                    &[PaintButton {
                        rect: fit.rect(control.rect),
                        pressed,
                        hovered: control.enabled && control.rect.contains(cx, cy),
                        enabled: control.enabled,
                    }],
                    shell_paint::ButtonPolicy {
                        art_fit: shell_paint::ArtFit::FitRightAnchored {
                            panel_w: 156.0,
                            tile_h: 42.0,
                        },
                        hover_flash: false,
                        art_sink_y: 0.0,
                    },
                    web_time::Instant::now(),
                    None,
                );
                if popup {
                    fill(&mut popup_art, control.rect, [0.035, 0.055, 0.065], 0.00031);
                    for sprite in &mut sprites {
                        sprite.depth = 0.00030;
                    }
                    popup_art.extend(sprites);
                } else {
                    art.extend(sprites);
                }
                rect =
                    crate::app::frontend::shell_pass::owner_draw_button_label_rect(rect, pressed);
                if matches!(&control.kind, ControlKind::Select(_)) {
                    caption.push_str("  v");
                }
            }
            ControlKind::Edit(_) => {
                fill(&mut art, control.rect, [0.32, 0.38, 0.40], 0.00083);
                fill(
                    &mut art,
                    RectPx::new(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4),
                    [0.015, 0.025, 0.03],
                    0.00082,
                );
                rect = RectPx::new(rect.x + 7, rect.y + 3, rect.w - 14, rect.h - 6);
                if focused {
                    if state.frontend.browser_shell.selection_all {
                        fill(
                            &mut art,
                            RectPx::new(rect.x, rect.y, rect.w, rect.h),
                            [0.12, 0.19, 0.25],
                            0.00080,
                        );
                    }
                    let caret = state
                        .frontend
                        .browser_shell
                        .caret
                        .min(caption.chars().count());
                    let mut chars: Vec<_> = caption.chars().collect();
                    chars.insert(caret, '|');
                    caption = chars.into_iter().collect();
                    if !state.frontend.browser_shell.preedit.is_empty() {
                        caption.push_str(&state.frontend.browser_shell.preedit);
                    }
                }
            }
            ControlKind::Check(checked) => {
                let entry = state
                    .frontend
                    .skirmish_shell_chrome
                    .as_ref()
                    .and_then(|atlas| {
                        if *checked {
                            atlas.checkbox_checked_cce_i
                        } else {
                            atlas.checkbox_unchecked_cue_i
                        }
                    });
                if let Some(entry) = entry {
                    let target = fit.rect(RectPx::new(rect.x + 3, rect.y + 5, 18, 18));
                    checkbox_art.push(SpriteInstance {
                        position: [target.x as f32, target.y as f32],
                        size: [target.w as f32, target.h as f32],
                        uv_origin: entry.uv_origin,
                        uv_size: entry.uv_size,
                        depth: 0.00079,
                        tint: [1.0; 3],
                        alpha: 1.0,
                        ..Default::default()
                    });
                } else {
                    caption = format!("[{}] {caption}", if *checked { "X" } else { " " });
                }
                rect = RectPx::new(rect.x + 27, rect.y, rect.w - 27, rect.h);
            }
        }
        if focused && !matches!(control.kind, ControlKind::Edit(_)) {
            fill(
                if popup { &mut popup_art } else { &mut art },
                RectPx::new(
                    control.rect.x + 5,
                    control.rect.y + control.rect.h - 3,
                    control.rect.w - 10,
                    1,
                ),
                [0.85, 0.85, 0.35],
                if popup { 0.00029 } else { 0.00078 },
            );
        }
        let label = PaintLabel {
            text: caption.into(),
            rect: fit.rect(rect),
            align: if matches!(control.kind, ControlKind::Button | ControlKind::Select(_)) {
                ShellAlign::H_CENTER | ShellAlign::V_CENTER
            } else {
                ShellAlign::V_CENTER
            },
            rgb: if control.enabled {
                shell_paint::SHELL_TEXT_RGB_ENABLED
            } else {
                [0.40, 0.43, 0.44]
            },
            path_a_reveal: None,
        };
        if popup {
            popup_text.push(label);
        } else {
            labels.push(label);
        }
    }
    for bar in &view.bars {
        fill(&mut art, bar.rect, [0.22, 0.27, 0.29], 0.00082);
        fill(
            &mut art,
            RectPx::new(
                bar.rect.x + 2,
                bar.rect.y + 2,
                ((bar.rect.w - 4) as f32 * bar.fraction.clamp(0.0, 1.0)) as i32,
                bar.rect.h - 4,
            ),
            [0.65, 0.7, 0.18],
            0.00081,
        );
    }
    let text = shell_paint::paint_labels_scaled(&state.renderer.bit_font, &labels, fit.scale);
    let popup_text = shell_paint::paint_labels_at_depth_scaled(
        &state.renderer.bit_font,
        &popup_text,
        0.0002,
        fit.scale,
    );
    let mut draws = vec![TexturedDraw {
        texture: &atlas.texture,
        instances: art,
    }];
    if let Some(chrome) = state.frontend.skirmish_shell_chrome.as_ref() {
        draws.push(TexturedDraw {
            texture: &chrome.texture,
            instances: checkbox_art,
        });
    }
    encode_shell_pass(
        state,
        encoder,
        destination,
        "native browser service shell",
        ShellComposition {
            draws: &draws,
            text: &text,
            cursor: if popup_art.is_empty() {
                software_cursor(state, shell_paint::CURSOR_DEPTH)
            } else {
                None
            },
            effects: None,
        },
    );
    if !popup_art.is_empty() {
        render_popup_overlay(state, encoder, destination, &popup_art, &popup_text);
    }
    Ok(())
}

/// Shell passthrough batches deliberately use depth=Always. A popup must be
/// painted after the ordinary font/checkbox batches, rather than depending on
/// instance Z values to occlude them. Load the same native RGB565 source, then
/// repaint the software cursor last, as the ordinary shell compositor does.
fn render_popup_overlay(
    state: &AppState,
    encoder: &mut wgpu::CommandEncoder,
    destination: &wgpu::Texture,
    art: &[SpriteInstance],
    text: &[crate::render::shell_text::ShellTextDraw],
) {
    let Some(atlas) = state.frontend.main_menu_shell_chrome.as_ref() else {
        return;
    };
    let gpu = &state.renderer.gpu;
    let batch = &state.renderer.batch_renderer;
    let art_buffer = batch.create_instance_buffer(gpu, art);
    let text_buffers: Vec<_> = text
        .iter()
        .map(|draw| batch.create_instance_buffer(gpu, &draw.instances))
        .collect();
    let cursor =
        crate::app::frontend::shell_pass::software_cursor(state, shell_paint::CURSOR_DEPTH);
    let cursor_buffer = cursor.as_ref().and_then(|(_, instance)| {
        batch.create_instance_buffer(gpu, std::slice::from_ref(instance))
    });
    let color = state.renderer.shell_surface_presenter.source_render_view();
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("native browser shell popup over completed labels"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &color,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &state.renderer.depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if let Some((buffer, count)) = art_buffer.as_ref() {
            batch.draw_with_buffer_passthrough(&mut pass, &atlas.texture, buffer, *count);
        }
        for (draw, buffer) in text.iter().zip(&text_buffers) {
            if let Some((buffer, count)) = buffer.as_ref() {
                pass.set_scissor_rect(
                    draw.scissor.x,
                    draw.scissor.y,
                    draw.scissor.w,
                    draw.scissor.h,
                );
                batch.draw_with_buffer_passthrough(
                    &mut pass,
                    state.renderer.bit_font.atlas(),
                    buffer,
                    *count,
                );
            }
        }
        if let (Some((texture, _)), Some((buffer, count))) = (cursor, cursor_buffer.as_ref()) {
            pass.set_scissor_rect(0, 0, gpu.config.width, gpu.config.height);
            batch.draw_with_buffer_passthrough(&mut pass, texture, buffer, *count);
        }
    }
    state
        .renderer
        .shell_surface_presenter
        .encode_present(encoder, destination);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fitting_keeps_pointer_and_draw_in_same_space() {
        for (w, h) in [(800, 600), (1280, 720), (640, 480), (1920, 1080)] {
            let fit = Fit::new(w, h);
            let rect = fit.rect(RectPx::new(100, 120, 200, 30));
            let (x, y) = fit.point((rect.x + rect.w / 2) as f64, (rect.y + rect.h / 2) as f64);
            assert!(RectPx::new(100, 120, 200, 30).contains(x, y));
        }
    }
    #[test]
    fn snapshots_require_explicit_schema_and_do_not_accept_commands_as_controls() {
        let update: Update = serde_json::from_str(
            r#"{"schema":1,"commands":[{"owner":0}],"lobby":{"open":true,"name":"指挥官"}}"#,
        )
        .unwrap();
        assert_eq!(update.schema, 1);
        assert_eq!(update.lobby.unwrap().name, "指挥官");
        assert!(update.content.is_none());
    }
    #[test]
    fn stale_paste_cannot_target_another_field_or_page_generation() {
        assert!(accepts_text_input(
            true,
            "lobby.code",
            9,
            Some("lobby.code"),
            9
        ));
        assert!(!accepts_text_input(
            true,
            "lobby.code",
            8,
            Some("lobby.code"),
            9
        ));
        assert!(!accepts_text_input(
            true,
            "lobby.code",
            9,
            Some("lobby.name"),
            9
        ));
        assert!(!accepts_text_input(
            false,
            "lobby.code",
            9,
            Some("lobby.code"),
            9
        ));
        assert!(!accepts_text_input(true, "other", 9, Some("other"), 9));
    }
}
