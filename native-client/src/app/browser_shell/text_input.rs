//! Invisible browser text-service adapter. Rust retains the visible draft,
//! selection, layout, and command authority; the DOM holds only an IME's
//! transient composition and never a copy of the native edit value.

#[derive(Debug)]
pub(super) struct InputEvent {
    pub field: String,
    pub generation: u64,
    pub kind: InputKind,
}

#[derive(Debug)]
pub(super) enum InputKind {
    Commit(String),
    Preedit(String),
    Key {
        key: String,
        ctrl: bool,
        meta: bool,
        shift: bool,
    },
    Paste(String),
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use super::{InputEvent, InputKind};
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use web_sys::{Event, HtmlElement};

    thread_local! {
        static BRIDGE: RefCell<Option<Bridge>> = const { RefCell::new(None) };
        static EVENTS: RefCell<Vec<InputEvent>> = const { RefCell::new(Vec::new()) };
        static FOCUS_TRANSFER: Cell<bool> = const { Cell::new(false) };
    }
    struct Session {
        field: String,
        generation: u64,
        composing: Cell<bool>,
        echo: RefCell<Option<String>>,
    }
    struct Bridge {
        input: HtmlElement,
        session: Rc<Session>,
        listeners: Vec<(&'static str, Closure<dyn FnMut(Event)>)>,
    }
    fn property(value: &JsValue, key: &str) -> JsValue {
        js_sys::Reflect::get(value, &key.into()).unwrap_or(JsValue::UNDEFINED)
    }
    fn text(value: &JsValue, key: &str) -> String {
        property(value, key).as_string().unwrap_or_default()
    }
    fn clear(input: &HtmlElement) {
        let _ = js_sys::Reflect::set(input, &"value".into(), &"".into());
    }
    fn bounded(value: String) -> String {
        value.chars().take(4096).collect()
    }
    fn enqueue(session: &Session, kind: InputKind) {
        EVENTS.with(|events| {
            let mut events = events.borrow_mut();
            if events.len() < 256 {
                events.push(InputEvent {
                    field: session.field.clone(),
                    generation: session.generation,
                    kind,
                });
            }
        });
        crate::app::browser::wake();
    }
    fn key(session: &Session, value: String, event: &Event) {
        enqueue(
            session,
            InputKind::Key {
                key: bounded(value),
                ctrl: property(event, "ctrlKey").as_bool().unwrap_or(false),
                meta: property(event, "metaKey").as_bool().unwrap_or(false),
                shift: property(event, "shiftKey").as_bool().unwrap_or(false),
            },
        );
    }
    fn focused(input: &HtmlElement) -> bool {
        web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.active_element())
            .is_some_and(|element| element == input.clone().unchecked_into::<web_sys::Element>())
    }
    fn focus_element(input: &HtmlElement) {
        if let Ok(method) = property(input, "focus").dyn_into::<js_sys::Function>() {
            let options = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&options, &"preventScroll".into(), &JsValue::TRUE);
            let _ = method.call1(input, &options);
        }
    }
    impl Bridge {
        fn new(field: &str, generation: u64) -> Result<Self, JsValue> {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is unavailable"))?;
            let input: HtmlElement = document.create_element("textarea")?.dyn_into()?;
            for (name, value) in [
                ("tabindex", "-1"),
                ("aria-hidden", "true"),
                ("autocomplete", "off"),
                ("autocapitalize", "off"),
                ("spellcheck", "false"),
                (
                    "style",
                    "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;font-size:16px;",
                ),
            ] {
                input.set_attribute(name, value)?;
            }
            document
                .body()
                .ok_or_else(|| JsValue::from_str("Document body is unavailable"))?
                .append_child(&input)?;
            let mut bridge = Self {
                input,
                session: Rc::new(Session {
                    field: field.to_owned(),
                    generation,
                    composing: Cell::new(false),
                    echo: RefCell::new(None),
                }),
                listeners: Vec::new(),
            };
            for kind in [
                "keydown",
                "keyup",
                "compositionstart",
                "compositionupdate",
                "compositionend",
                "beforeinput",
                "input",
                "paste",
            ] {
                let input = bridge.input.clone();
                let session = Rc::clone(&bridge.session);
                let listener = Closure::wrap(Box::new(move |event: Event| {
                    event.stop_propagation();
                    match kind {
                        "keydown" => {
                            let value = text(&event, "key");
                            if session.composing.get()
                                || property(&event, "isComposing").as_bool() == Some(true)
                                || value == "Process"
                                || property(&event, "keyCode").as_f64() == Some(229.0)
                            {
                                return;
                            }
                            session.echo.borrow_mut().take();
                            // A trusted paste must retain its browser default so
                            // clipboardData is delivered to the paste listener.
                            let paste = value.eq_ignore_ascii_case("v")
                                && (property(&event, "ctrlKey").as_bool() == Some(true)
                                    || property(&event, "metaKey").as_bool() == Some(true));
                            if !paste {
                                event.prevent_default();
                            }
                            key(&session, value, &event);
                        }
                        "compositionstart" => {
                            session.composing.set(true);
                            session.echo.borrow_mut().take();
                        }
                        "compositionupdate" => {
                            enqueue(&session, InputKind::Preedit(bounded(text(&event, "data"))))
                        }
                        "compositionend" => {
                            session.composing.set(false);
                            let mut value = text(&event, "data");
                            if value.is_empty() {
                                value = text(&input, "value");
                            }
                            value = bounded(value);
                            *session.echo.borrow_mut() = Some(value.clone());
                            enqueue(&session, InputKind::Commit(value));
                            clear(&input);
                            // Keep the receipt until final input consumes it.
                            // A microtask can run before that event and would
                            // make the same composition commit twice. The next
                            // key/composition/paste also resets this receipt.
                        }
                        "beforeinput" if !session.composing.get() => {
                            let kind = text(&event, "inputType");
                            if kind.starts_with("delete") {
                                event.prevent_default();
                                clear(&input);
                                key(
                                    &session,
                                    if kind.ends_with("Forward") {
                                        "Delete"
                                    } else {
                                        "Backspace"
                                    }
                                    .into(),
                                    &event,
                                );
                            }
                        }
                        "input"
                            if !session.composing.get()
                                && property(&event, "isComposing").as_bool() != Some(true) =>
                        {
                            let mut value = text(&input, "value");
                            if value.is_empty() {
                                value = text(&event, "data");
                            }
                            value = bounded(value);
                            let echo = session.echo.borrow_mut().take();
                            if !value.is_empty() && echo.as_deref() != Some(value.as_str()) {
                                enqueue(&session, InputKind::Commit(value));
                            }
                            clear(&input);
                        }
                        "paste" => {
                            event.prevent_default();
                            session.echo.borrow_mut().take();
                            let clipboard = property(&event, "clipboardData");
                            if let Ok(get) =
                                property(&clipboard, "getData").dyn_into::<js_sys::Function>()
                            {
                                if let Ok(value) = get.call1(&clipboard, &"text/plain".into()) {
                                    if let Some(value) = value.as_string() {
                                        enqueue(&session, InputKind::Paste(bounded(value)));
                                    }
                                }
                            }
                            clear(&input);
                        }
                        _ => {}
                    }
                }) as Box<dyn FnMut(Event)>);
                bridge
                    .input
                    .add_event_listener_with_callback(kind, listener.as_ref().unchecked_ref())?;
                bridge.listeners.push((kind, listener));
            }
            Ok(bridge)
        }
    }
    impl Drop for Bridge {
        fn drop(&mut self) {
            for (kind, listener) in &self.listeners {
                let _ = self
                    .input
                    .remove_event_listener_with_callback(kind, listener.as_ref().unchecked_ref());
            }
            clear(&self.input);
            self.input.remove();
        }
    }
    pub(crate) fn focus(field: &str, generation: u64) {
        if BRIDGE.with(|bridge| {
            bridge.borrow().as_ref().is_some_and(|bridge| {
                bridge.session.field == field && bridge.session.generation == generation
            })
        }) {
            return;
        }
        drop(BRIDGE.with(|bridge| bridge.borrow_mut().take()));
        match Bridge::new(field, generation) {
            Ok(bridge) => {
                let input = bridge.input.clone();
                BRIDGE.with(|slot| *slot.borrow_mut() = Some(bridge));
                // No RefCell borrow may survive focus(): its synchronous focus
                // edge can reenter the native WindowActive consumer.
                FOCUS_TRANSFER.with(|transfer| transfer.set(true));
                focus_element(&input);
                FOCUS_TRANSFER.with(|transfer| transfer.set(false));
            }
            Err(_) => log::warn!("Browser text service is unavailable"),
        }
    }
    pub(crate) fn blur() {
        let bridge = BRIDGE.with(|bridge| bridge.borrow_mut().take());
        let restore =
            bridge.as_ref().is_some_and(|bridge| focused(&bridge.input)) && document_focused();
        drop(bridge);
        if restore {
            if let Some(canvas) = web_sys::window()
                .and_then(|window| window.document())
                .and_then(|document| document.get_element_by_id("game"))
                .and_then(|element| element.dyn_into::<HtmlElement>().ok())
            {
                focus_element(&canvas);
            }
        }
    }
    pub(crate) fn active() -> bool {
        // Chromium may temporarily expose body as activeElement during the
        // canvas blur dispatched *inside* input.focus(). Only this synchronous
        // owned transfer counts; a later real browser/OS blur never does.
        BRIDGE.with(|bridge| {
            bridge
                .borrow()
                .as_ref()
                .is_some_and(|bridge| focused(&bridge.input) || FOCUS_TRANSFER.with(Cell::get))
        })
    }
    pub(crate) fn document_focused() -> bool {
        web_sys::window()
            .and_then(|window| window.document())
            .is_some_and(|document| {
                !document.hidden()
                    && property(&document, "hasFocus")
                        .dyn_into::<js_sys::Function>()
                        .ok()
                        .and_then(|method| method.call0(&document).ok())
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
            })
    }
    pub(crate) fn drain() -> Vec<InputEvent> {
        EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
    }
}

#[cfg(target_arch = "wasm32")]
pub(super) use browser::{active, blur, document_focused, drain, focus};

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn focus(_field: &str, _generation: u64) {}
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn blur() {}
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn active() -> bool {
    false
}
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn document_focused() -> bool {
    false
}
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn drain() -> Vec<InputEvent> {
    Vec::new()
}
