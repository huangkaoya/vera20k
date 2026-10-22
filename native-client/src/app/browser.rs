//! Browser lifecycle for the ordinary native App, menus and tactical input.
//!
//! Resource hydration is completed by web_entry before this module starts.
//! The browser owns its event loop; no executor blocks JavaScript while wgpu
//! requests its adapter/device. AppState and every gameplay owner remain native.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use web_sys::HtmlCanvasElement;
use web_time::Instant;
use winit::event::{ElementState, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::platform::web::EventLoopExtWebSys;
use winit::window::Window;

use super::{App, AppState, GameScreen, GpuContext};

mod network_launch;

thread_local! {
    static STARTED: Cell<bool> = const { Cell::new(false) };
    static DIAGNOSTICS_ENABLED: Cell<bool> = const { Cell::new(false) };
    // Presentation-only derived state for resource activation. Reading it must
    // not enable full unit/terrain acceptance diagnostics in ordinary play.
    static MENU_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static DIAGNOSTICS: RefCell<Value> = RefCell::new(json!({"stage":"not-started"}));
    static NETWORK_START: RefCell<Option<network_launch::NetworkStartConfig>> = const { RefCell::new(None) };
    static NETWORK_LEAVE: RefCell<Option<String>> = const { RefCell::new(None) };
    static BROWSER_PROXY: RefCell<Option<EventLoopProxy<()>>> = const { RefCell::new(None) };
}

/// Wake the ordinary winit app pass from transport callbacks, including when
/// requestAnimationFrame is suspended in a hidden browser tab.
pub fn wake() {
    BROWSER_PROXY.with(|proxy| {
        if let Some(proxy) = proxy.borrow().as_ref() {
            let _ = proxy.send_event(());
        }
    });
}

pub fn leave_network_match(match_id: &str) -> Result<(), JsValue> {
    let pending = NETWORK_START.with(|pending| {
        pending
            .borrow()
            .as_ref()
            .is_some_and(|config| config.match_id == match_id)
    });
    let current = crate::app::browser_network::status()["matchId"].as_str() == Some(match_id);
    if !pending && !current {
        return Err(JsValue::from_str("该网络对局已经结束"));
    }
    NETWORK_LEAVE.with(|pending| *pending.borrow_mut() = Some(match_id.to_owned()));
    wake();
    Ok(())
}

pub fn start_network_match(config_json: &str) -> Result<(), JsValue> {
    if !STARTED.with(Cell::get) {
        return Err(JsValue::from_str("游戏尚未初始化"));
    }
    if config_json.len() > 65_536 {
        return Err(JsValue::from_str("网络对局配置过大"));
    }
    let config = serde_json::from_str(config_json)
        .map_err(|error| JsValue::from_str(&format!("网络对局配置无效：{error}")))?;
    NETWORK_START.with(|pending| {
        if pending.borrow().is_some() {
            return Err(JsValue::from_str("网络对局正在启动"));
        }
        *pending.borrow_mut() = Some(config);
        Ok(())
    })?;
    wake();
    Ok(())
}

fn notify(name: &str) {
    if let (Some(window), Ok(event)) = (web_sys::window(), web_sys::Event::new(name)) {
        let _ = window.dispatch_event(&event);
    }
}

pub(super) fn request_network_lobby() {
    notify("vera-native-network");
}

pub(super) fn request_content(pack: &str) {
    let Some(window) = web_sys::window() else {
        return;
    };
    let detail = js_sys::Object::new();
    if js_sys::Reflect::set(
        &detail,
        &JsValue::from_str("pack"),
        &JsValue::from_str(pack),
    )
    .is_err()
    {
        return;
    }
    let init = web_sys::CustomEventInit::new();
    init.set_detail(&detail);
    if let Ok(event) =
        web_sys::CustomEvent::new_with_event_init_dict("vera-content-required", &init)
    {
        let _ = window.dispatch_event(&event);
    }
}

pub(super) fn notify_network_return() {
    notify("vera-native-network-return");
}

struct PendingInitialization {
    window: Arc<Window>,
    result: Rc<RefCell<Option<anyhow::Result<Box<AppState>>>>>,
    live: Rc<Cell<bool>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BrowserViewport {
    width: u32,
    height: u32,
    dpr_bits: u64,
}

impl BrowserViewport {
    fn measured(width: f64, height: f64, dpr: f64) -> Option<Self> {
        if !width.is_finite()
            || !height.is_finite()
            || !dpr.is_finite()
            || width < 1.0
            || height < 1.0
            || dpr <= 0.0
            || width > u32::MAX as f64
            || height > u32::MAX as f64
        {
            return None;
        }
        Some(Self {
            width: width.round() as u32,
            height: height.round() as u32,
            dpr_bits: dpr.to_bits(),
        })
    }

    fn current() -> Option<Self> {
        let window = web_sys::window()?;
        Self::measured(
            window.inner_width().ok()?.as_f64()?,
            window.inner_height().ok()?.as_f64()?,
            window.device_pixel_ratio(),
        )
    }
}

pub(super) struct BrowserState {
    canvas: HtmlCanvasElement,
    pending: Option<PendingInitialization>,
    attempted: bool,
    last_diagnostics: Option<Instant>,
    last_document_hidden: Option<bool>,
    /// Winit writes explicit canvas CSS dimensions. Observe the browser rather
    /// than that now-fixed client rect; no resize listeners outlive this owner.
    last_viewport: Option<BrowserViewport>,
}

/// Start once, after the retail provider has mounted and hydrated its files.
/// winit retains App and returns control to the browser immediately.
pub fn start(canvas: HtmlCanvasElement) -> Result<(), JsValue> {
    if STARTED.with(Cell::get) {
        return Err(JsValue::from_str(
            "The native browser event loop is already running",
        ));
    }
    let event_loop = EventLoop::new().map_err(|error| JsValue::from_str(&error.to_string()))?;
    canvas.set_attribute("tabindex", "0")?;
    canvas.set_attribute("data-vera-stage", "starting")?;
    let mut app = App::default();
    app.browser = Some(BrowserState {
        canvas,
        pending: None,
        attempted: false,
        last_diagnostics: None,
        last_document_hidden: None,
        last_viewport: BrowserViewport::current(),
    });
    BROWSER_PROXY.with(|proxy| *proxy.borrow_mut() = Some(event_loop.create_proxy()));
    STARTED.with(|started| started.set(true));
    event_loop.spawn_app(app);
    Ok(())
}

/// Explicitly enable a low-frequency, read-only acceptance snapshot. No hashes,
/// commands, or writable simulation references are exposed to JavaScript.
pub fn diagnostics() -> JsValue {
    DIAGNOSTICS_ENABLED.with(|enabled| enabled.set(true));
    DIAGNOSTICS.with(|value| {
        let mut snapshot = value.borrow().clone();
        // Pointer admission is consumed synchronously by trusted mouse events.
        // Keep it current even while the heavier acceptance snapshot is throttled.
        snapshot["pointerCaptureAllowed"] = json!(super::input::cursor::browser::policy());
        js_sys::JSON::parse(&snapshot.to_string()).unwrap_or(JsValue::NULL)
    })
}

pub fn pointer_capture_allowed() -> bool {
    super::input::cursor::browser::policy()
}

pub fn menu_active() -> bool {
    MENU_ACTIVE.with(Cell::get)
}

fn set_stage(browser: &BrowserState, stage: &str, error: Option<&str>) {
    let _ = browser.canvas.set_attribute("data-vera-stage", stage);
    if let Some(error) = error {
        let _ = browser.canvas.set_attribute("data-vera-error", error);
    }
    DIAGNOSTICS.with(|value| *value.borrow_mut() = json!({"stage":stage,"error":error}));
}

impl App {
    pub(super) fn poll_browser_network(&mut self) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        if let Some(browser) = self.browser.as_mut()
            && let Some(viewport) = BrowserViewport::current()
            && browser.last_viewport != Some(viewport)
        {
            browser.last_viewport = Some(viewport);
            // Feed the ordinary Resized path so GPU, shell layout, tactical
            // viewport and native sidebar all agree on the same physical size.
            let _ = state
                .platform
                .window
                .request_inner_size(winit::dpi::LogicalSize::new(
                    f64::from(viewport.width),
                    f64::from(viewport.height),
                ));
            state.platform.window.request_redraw();
        }
        if let Some(match_id) = NETWORK_LEAVE.with(|pending| pending.borrow_mut().take()) {
            let canceled = NETWORK_START.with(|pending| {
                let mut pending = pending.borrow_mut();
                if pending
                    .as_ref()
                    .is_some_and(|config| config.match_id == match_id)
                {
                    *pending = None;
                    true
                } else {
                    false
                }
            });
            let current = crate::app::browser_network::status()["matchId"].as_str()
                == Some(match_id.as_str());
            if current && state.match_state.browser_network.is_some() {
                crate::app::loading::pump::clear_loading_state(state);
                Self::return_to_main_menu(state);
            } else if canceled {
                notify_network_return();
            }
        }
        if let Some(config) = NETWORK_START.with(|pending| pending.borrow_mut().take()) {
            match network_launch::start(state, config) {
                Ok(()) => notify("vera-native-network-started"),
                Err(error) => {
                    let message = format!("网络对局启动失败：{error:#}");
                    log::error!("{message}");
                    if let Some(browser) = self.browser.as_ref() {
                        let _ = browser
                            .canvas
                            .set_attribute("data-vera-network-error", &message);
                    }
                    notify("vera-native-network-error");
                }
            }
        }
        crate::app::browser_network::poll(state);
        if let Some(browser) = self.browser.as_mut()
            && let Some(document) = web_sys::window().and_then(|window| window.document())
        {
            let hidden = document.hidden();
            if browser.last_document_hidden != Some(hidden) {
                browser.last_document_hidden = Some(hidden);
                Self::set_window_hidden(state, hidden);
            }
        }
        notify("vera-native-network-service");
    }
    pub(super) fn begin_browser_initialization(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let Some(browser) = self.browser.as_mut() else {
            log::error!("Browser App must be started with app::browser::start(canvas)");
            event_loop.exit();
            return;
        };
        if browser.attempted {
            return;
        }
        browser.attempted = true;
        set_stage(browser, "gpu", None);
        let prepared = match Self::prepare_initialization(
            event_loop,
            None,
            self.startup_options,
            false,
            browser.canvas.clone(),
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                let text = format!("Native browser window initialization failed: {error:#}");
                log::error!("{text}");
                set_stage(browser, "error", Some(&text));
                self.startup_failure = Some(text);
                event_loop.exit();
                return;
            }
        };
        let window = prepared.window.clone();
        let result = Rc::new(RefCell::new(None));
        let live = Rc::new(Cell::new(true));
        browser.pending = Some(PendingInitialization {
            window: window.clone(),
            result: result.clone(),
            live: live.clone(),
        });
        wasm_bindgen_futures::spawn_local(async move {
            let initialized = match GpuContext::new_async(window.clone()).await {
                Ok(gpu) if live.get() => App::finish_initialization(prepared, gpu),
                Ok(_) => return,
                Err(error) => Err(error),
            };
            if live.get() {
                *result.borrow_mut() = Some(initialized);
                window.request_redraw();
            }
        });
    }

    pub(super) fn poll_browser_initialization(&mut self, event_loop: &ActiveEventLoop) -> bool {
        if self.state.is_some() {
            return true;
        }
        let Some(browser) = self.browser.as_mut() else {
            return false;
        };
        let result = browser
            .pending
            .as_ref()
            .and_then(|pending| pending.result.borrow_mut().take());
        let Some(result) = result else {
            return false;
        };
        let pending = browser.pending.take();
        match result {
            Ok(state) => {
                super::input::cursor::apply_cursor_confinement(&state);
                state.platform.window.request_redraw();
                set_stage(browser, "ready", None);
                self.state = Some(state);
                log::info!("Native browser initialization complete");
                true
            }
            Err(error) => {
                if let Some(pending) = pending {
                    pending.window.set_cursor_visible(true);
                }
                let text = format!("Native browser initialization failed: {error:#}");
                log::error!("{text}");
                set_stage(browser, "error", Some(&text));
                self.startup_failure = Some(text);
                event_loop.exit();
                false
            }
        }
    }

    pub(super) fn admit_browser_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        event: &WindowEvent,
    ) -> bool {
        if matches!(event, WindowEvent::CloseRequested) && self.state.is_none() {
            self.cancel_browser_initialization();
            event_loop.exit();
            return false;
        }
        if !self.poll_browser_initialization(event_loop) {
            return false;
        }
        let trusted_input = matches!(
            event,
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                ..
            } | WindowEvent::KeyboardInput {
                event: winit::event::KeyEvent {
                    state: ElementState::Pressed,
                    ..
                },
                ..
            } | WindowEvent::Touch(winit::event::Touch {
                phase: TouchPhase::Started,
                ..
            })
        );
        if trusted_input {
            if let Err(error) = crate::audio::browser_output::unlock() {
                log::warn!("Browser audio activation was refused: {error:?}");
            }
        }
        true
    }

    pub(super) fn cancel_browser_initialization(&mut self) {
        MENU_ACTIVE.with(|active| active.set(false));
        if let Some(state) = self.state.as_ref() {
            super::input::cursor::browser::release(state);
            state.platform.window.set_cursor_visible(true);
        }
        if let Some(browser) = self.browser.as_mut() {
            browser.last_viewport = None;
            if let Some(pending) = browser.pending.take() {
                pending.live.set(false);
                pending.window.set_cursor_visible(true);
            }
            if self.startup_failure.is_none() {
                set_stage(browser, "closed", None);
            }
        }
    }

    pub(super) fn update_browser_diagnostics(&mut self) {
        MENU_ACTIVE.with(|active| {
            active.set(
                self.state
                    .as_ref()
                    .is_some_and(|state| state.frontend.screen == GameScreen::MainMenu),
            );
        });
        if !DIAGNOSTICS_ENABLED.with(Cell::get) {
            return;
        }
        let Some(browser) = self.browser.as_mut() else {
            return;
        };
        let now = Instant::now();
        if browser
            .last_diagnostics
            .is_some_and(|last| now.duration_since(last).as_millis() < 250)
        {
            return;
        }
        browser.last_diagnostics = Some(now);
        let Some(state) = self.state.as_ref() else {
            return;
        };
        let snapshot = diagnostic_snapshot(state);
        DIAGNOSTICS.with(|value| *value.borrow_mut() = snapshot);
    }
}

fn diagnostic_snapshot(state: &AppState) -> Value {
    let game_speed = state.match_state.sim_runtime.as_ref().map_or_else(
        || {
            state
                .match_state
                .match_presentation
                .in_game_options
                .game_speed
                .min(6) as u8
        },
        |runtime| {
            runtime
                .simulation
                .session()
                .game_options()
                .game_speed
                .clamp(0, 6) as u8
        },
    );
    let interpolation = state.match_state.match_presentation.interpolation.readout();
    let mode = match state.frontend.screen {
        GameScreen::MainMenu => "menu",
        GameScreen::Loading => "loading",
        GameScreen::InGame => "ingame",
        GameScreen::MissionResult { .. } => "result",
    };
    let input = &state.match_state.input;
    let viewport = super::input::camera::tactical_viewport_px(state);
    let pool = &state.renderer.instance_pool;
    let instances = |key| pool.get(key).map_or(0, |(_, count)| count);
    let center_base_binding = input
        .hotkey_bindings
        .first_key(super::input::hotkeys::HotkeyCommand::CenterBase);
    let loading_paints = super::loading::pump::browser_paint_counts();
    let mut result = json!({
        "stage":"ready","mode":mode,
        "shellRoute":format!("{:?}",state.frontend.shell_route),
        "menuError":state.frontend.main_menu_shell_error,
        "width":state.render_width(),"height":state.render_height(),
        "windowWidth":state.renderer.gpu.config.width,"windowHeight":state.renderer.gpu.config.height,
        "selected":state.match_state.input.selection_order,
        "gameSpeed":game_speed,
        "speedBucketMs":state.platform.frame_pacer.budget_ms(game_speed),
        "renderInterpolation":interpolation.interpolation,
        "interpolationSampling":interpolation.sampling,
        "observedTps":interpolation.tps,
        "renderFrameAttemptMsMean":state.diag.frame_timer.frame_ms_mean(),
        "camera":{"x":input.camera_x,"y":input.camera_y,"zoom":input.zoom_level},
        "cursor":{"x":input.cursor_x,"y":input.cursor_y},
        "pointerInClient":state.platform.pointer_in_client,
        "cursorConfined":state.platform.cursor_confined,
        "pointerCaptureAllowed":super::input::cursor::browser::eligible(state),
        "pointerMotion":super::input::cursor::browser::diagnostics(state),
        "touchInput":state.touch_input_mode(),
        "brandedHud":state.branded_hud_mode(),
        "loadingPaints":{"scheduled":loading_paints.0,"completed":loading_paints.1},
        "windowActive":state.platform.window_active,
        "windowHidden":state.platform.window_hidden,
        "tacticalViewport":{"x":viewport.0,"y":viewport.1,"width":viewport.2,"height":viewport.3},
        "centerBaseBinding":center_base_binding,
        "hBinding":format!("{:?}",input.hotkey_bindings.command_at(72)),
        "terrain":state.match_state.match_presentation.terrain_grid.as_ref().map(|grid|json!({
            "cells":grid.cells.len(),"originX":grid.origin_x,"originY":grid.origin_y,
            "worldWidth":grid.world_width,"worldHeight":grid.world_height,
        })),
        "renderInstances":{"terrain":instances("terrain"),"cellBodies":instances("cell_body"),
            "smudges":instances("smudge"),"bridgeBodyShadows":instances("overlay_bridge_body_shadow"),
            "cellSparkles":instances("cell_sparkles"),"buildingStatusText":instances("building_status_text")},
        "randomMap":state.frontend.skirmish_shell_state.random_map_setup_modal.as_ref().map(|modal| json!({
            "generating":modal.generating,"generated":modal.generated,
            "seed":modal.options.seed,"width":modal.options.width,"height":modal.options.height,
            "previewGeneration":modal.preview_generation,
        })),
    });
    let Some(runtime) = state.match_state.sim_runtime.as_ref() else {
        return result;
    };
    let sim = &runtime.simulation;
    let rules = &runtime.resources.rules;
    let owner_name = super::input::commands::preferred_local_owner_name(state);
    let owner = owner_name
        .as_deref()
        .and_then(|name| sim.interner().get(name));
    result["tick"] = json!(sim.session().tick());
    result["localOwner"] = json!(owner.map(|id| id.index()));
    result["localOwnerName"] = json!(owner_name);
    result["screenEntityCount"] =
        json!(super::presentation::instances::tactical_screen_entity_encounter_order(state).len());
    result["localVision"] = json!(owner.and_then(|owner|sim.fog().by_owner().get(&owner)).map(|vision| {
        let mut revealed = 0usize;
        let mut visible = 0usize;
        for ry in 0..vision.height() {
            for rx in 0..vision.width() {
                revealed += usize::from(vision.is_revealed(rx,ry));
                visible += usize::from(vision.is_visible(rx,ry));
            }
        }
        json!({"width":vision.width(),"height":vision.height(),"revealedCells":revealed,"visibleCells":visible})
    }));
    result["players"] = json!(sim.houses().iter().map(|(id,house)| {
        let name = sim.resolve(*id);
        let (power,drain) = crate::sim::production::power_balance_for_owner(sim,rules,name);
        json!({"owner":id.index(),"name":name,"credits":crate::sim::production::credits_for_owner(sim,name),"power":power,"drain":drain,"defeated":house.is_defeated()})
    }).collect::<Vec<_>>());
    result["units"] = json!(sim.entities().values_sorted().filter(|entity| Some(entity.owner())==owner).map(|entity| {
        let position = entity.position;
        json!({"id":entity.stable_id(),"type":sim.resolve(entity.type_ref()),"rx":position.rx(),"ry":position.ry(),"hp":entity.health.current(),"limbo":entity.in_limbo(),"alive":entity.is_alive()})
    }).collect::<Vec<_>>());
    if let (Some(owner_name), Some(owner)) = (owner_name.as_deref(), owner) {
        result["queues"] = json!(crate::sim::production::queue_view_for_owner(sim,rules,owner_name).into_iter().map(|queue| {
            let progress = if queue.state == crate::sim::production::BuildQueueState::Queued {
                0
            } else {
                sim.production().factories().view(owner,queue.queue_category).map_or(0,|factory|factory.progress)
            };
            json!({"type":sim.resolve(queue.type_id),"category":format!("{:?}",queue.queue_category),"state":format!("{:?}",queue.state),"progress":progress,"total":crate::sim::production::PRODUCTION_STEPS})
        }).collect::<Vec<_>>());
        result["ready"] = json!(
            crate::sim::production::ready_buildings_for_owner(sim, rules, owner_name)
                .into_iter()
                .map(|item| sim.resolve(item.type_id))
                .collect::<Vec<_>>()
        );
    }
    result
}
