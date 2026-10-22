//! Browser boundary for the complete native client. Rules, UI, input and drawing
//! remain owned by the original VERA modules.
use wasm_bindgen::prelude::*;

struct BrowserLogger;
static LOGGER: BrowserLogger = BrowserLogger;
impl log::Log for BrowserLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = JsValue::from_str(&format!("[VERA {}] {}", record.level(), record.args()));
        match record.level() {
            log::Level::Error => web_sys::console::error_1(&message),
            log::Level::Warn => web_sys::console::warn_1(&message),
            _ => web_sys::console::log_1(&message),
        }
    }
    fn flush(&self) {}
}

#[wasm_bindgen(start)]
pub fn initialize_browser_module() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
    std::panic::set_hook(Box::new(|panic| {
        let error = js_sys::Error::new(&panic.to_string());
        web_sys::console::error_1(&error);
    }));
}

#[wasm_bindgen]
pub fn mount_resource(name: &str, bytes: Vec<u8>) -> Result<(), JsValue> {
    crate::util::browser_io::register_asset(name, bytes).map_err(|error| JsValue::from_str(&error))
}

/// Presentation-only menu video; retail resources stay frozen after startup.
#[wasm_bindgen]
pub fn install_menu_animation(bytes: Vec<u8>) -> Result<(), JsValue> {
    crate::util::browser_menu_media::install(bytes).map_err(|error| JsValue::from_str(&error))?;
    crate::app::browser::wake();
    Ok(())
}

#[wasm_bindgen]
pub fn configure_content(json: &str) -> Result<(), JsValue> {
    crate::util::browser_content::configure(json).map_err(|error| JsValue::from_str(&error))
}

/// Semantic content/lobby receipts only; no battle command admission here.
#[wasm_bindgen]
pub fn browser_shell_update(json: &str) -> Result<(), JsValue> {
    crate::app::browser_shell::update_snapshot(json).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub fn start_browser(canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
    crate::util::browser_content::freeze();
    crate::util::browser_io::finish_mount_and_hydrate()
        .map_err(|error| JsValue::from_str(&error))?;
    crate::app::browser::start(canvas)
}

#[wasm_bindgen]
pub fn source_revision() -> String {
    option_env!("VERA_WEB_SOURCE_REVISION")
        .unwrap_or("unrecorded-build")
        .into()
}

#[wasm_bindgen]
pub fn browser_diagnostics() -> JsValue {
    crate::app::browser::diagnostics()
}

/// Cheap capability reads for the invisible browser adapters. These do not
/// enable full acceptance snapshots or allocate unit/terrain JSON.
#[wasm_bindgen]
pub fn browser_pointer_capture_allowed() -> bool {
    crate::app::browser::pointer_capture_allowed()
}

#[wasm_bindgen]
pub fn browser_menu_active() -> bool {
    crate::app::browser::menu_active()
}

#[wasm_bindgen]
pub fn network_start(config_json: &str) -> Result<(), JsValue> {
    crate::app::browser::start_network_match(config_json)
}

#[wasm_bindgen]
pub fn network_leave(match_id: &str) -> Result<(), JsValue> {
    crate::app::browser::leave_network_match(match_id)
}

#[wasm_bindgen]
pub fn network_status() -> JsValue {
    js_sys::JSON::parse(&crate::app::browser_network::status().to_string()).unwrap_or(JsValue::NULL)
}

#[wasm_bindgen]
pub fn network_drain_outbox() -> String {
    crate::app::browser_network::drain_outbox().to_string()
}

#[wasm_bindgen]
pub fn network_receive(message: &str) -> Result<(), JsValue> {
    if message.len() > 1024 * 1024 {
        return Err(JsValue::from_str("native network message exceeds one MiB"));
    }
    let mut value: serde_json::Value =
        serde_json::from_str(message).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let match_id = value
        .get("matchId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| JsValue::from_str("native network message requires matchId"))?
        .to_owned();
    value
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("native network message must be an object"))?
        .remove("matchId");
    crate::app::browser_network::receive(&match_id, &value.to_string())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}
