//! Browser codec adapter for the optional approved MP4 menu loop.
//!
//! The browser owns decode time and looping. Only new decoded-frame timestamps
//! are read back through a same-origin Canvas2D and handed to the existing wgpu
//! menu texture. No video, canvas or callback is retained after its menu owner.

use std::cell::Cell;
use std::rc::Rc;

use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement, HtmlVideoElement};

use super::{VideoFrameClock, VideoPlaybackGate};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Playback {
    Paused,
    Pending,
    Playing,
    Failed,
}

struct Signals {
    playback: Cell<Playback>,
    gate: Cell<VideoPlaybackGate>,
    play_generation: Cell<u64>,
    frame_time: Cell<Option<f64>>,
    callback_pending: Cell<bool>,
}

pub(super) enum FrameUpdate {
    Ready(Vec<u8>),
    Waiting,
    Unchanged,
    Failed,
}

pub(super) struct BrowserMenuVideo {
    video: HtmlVideoElement,
    canvas: HtmlCanvasElement,
    context: CanvasRenderingContext2d,
    object_url: String,
    signals: Rc<Signals>,
    frame_callback: Closure<dyn FnMut(f64, JsValue)>,
    request_frame: Option<js_sys::Function>,
    cancel_frame: Option<js_sys::Function>,
    callback_id: Option<JsValue>,
    clock: VideoFrameClock,
    width: u32,
    height: u32,
    reported_first_frame: bool,
    document: web_sys::Document,
    visibility_listener: Closure<dyn FnMut(web_sys::Event)>,
}

fn method(video: &HtmlVideoElement, name: &str) -> Option<js_sys::Function> {
    js_sys::Reflect::get(video, &JsValue::from_str(name))
        .ok()?
        .dyn_into()
        .ok()
}

fn sync_playback(video: &HtmlVideoElement, signals: &Rc<Signals>) {
    let playback = signals.playback.get();
    if playback == Playback::Failed {
        return;
    }
    if !signals.gate.get().playing() {
        if playback != Playback::Paused {
            // pause() can reject an outstanding play Promise with AbortError.
            // Its older completion must not turn an intentional pause into a
            // permanent decoder failure or restart a hidden movie.
            signals
                .play_generation
                .set(signals.play_generation.get().wrapping_add(1));
            signals.playback.set(Playback::Paused);
            let _ = video.pause();
        }
        return;
    }
    if playback != Playback::Paused {
        return;
    }
    let generation = signals.play_generation.get().wrapping_add(1);
    signals.play_generation.set(generation);
    signals.playback.set(Playback::Pending);
    match video.play() {
        Ok(promise) => {
            let signals = Rc::downgrade(signals);
            spawn_local(async move {
                let result = JsFuture::from(promise).await;
                if let Some(signals) = signals.upgrade()
                    && signals.play_generation.get() == generation
                {
                    signals.playback.set(if result.is_ok() {
                        Playback::Playing
                    } else {
                        Playback::Failed
                    });
                }
            });
        }
        Err(_) => signals.playback.set(Playback::Failed),
    }
}

impl BrowserMenuVideo {
    pub(super) fn new(bytes: &[u8], width: u32, height: u32) -> Result<Self, JsValue> {
        let document = web_sys::window()
            .and_then(|window| window.document())
            .ok_or_else(|| JsValue::from_str("browser video requires a Document"))?;
        let video: HtmlVideoElement = document.create_element("video")?.dyn_into()?;
        video.set_muted(true);
        video.set_loop(true);
        video.set_preload("auto");
        video.set_attribute("playsinline", "")?;
        video.set_attribute("webkit-playsinline", "")?;
        let canvas: HtmlCanvasElement = document.create_element("canvas")?.dyn_into()?;
        canvas.set_width(width);
        canvas.set_height(height);
        let options = js_sys::Object::new();
        js_sys::Reflect::set(
            &options,
            &JsValue::from_str("willReadFrequently"),
            &JsValue::TRUE,
        )?;
        let context: CanvasRenderingContext2d = canvas
            .get_context_with_context_options("2d", &options)?
            .ok_or_else(|| JsValue::from_str("Canvas2D is unavailable"))?
            .dyn_into()?;
        let signals = Rc::new(Signals {
            playback: Cell::new(Playback::Paused),
            gate: Cell::new(VideoPlaybackGate {
                document_visible: !document.hidden(),
                ..VideoPlaybackGate::default()
            }),
            play_generation: Cell::new(0),
            frame_time: Cell::new(None),
            callback_pending: Cell::new(false),
        });
        let observed = Rc::clone(&signals);
        // requestVideoFrameCallback is deliberately feature-detected: the
        // pinned web-sys predates its binding. Metadata.mediaTime belongs to
        // the decoded frame, not the display's requestAnimationFrame clock.
        // https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
        let frame_callback = Closure::wrap(Box::new(move |_now: f64, metadata: JsValue| {
            observed.callback_pending.set(false);
            if let Ok(time) = js_sys::Reflect::get(&metadata, &JsValue::from_str("mediaTime")) {
                observed.frame_time.set(time.as_f64());
            }
        }) as Box<dyn FnMut(f64, JsValue)>);
        let mut request_frame = method(&video, "requestVideoFrameCallback");
        let cancel_frame = method(&video, "cancelVideoFrameCallback");
        if cancel_frame.is_none() {
            request_frame = None;
        }
        // Blob construction snapshots only the compressed MP4. The original
        // VFS Arc remains shared; no raw-frame archive is embedded or expanded.
        let parts = js_sys::Array::new();
        parts.push(&js_sys::Uint8Array::from(bytes));
        let blob_options = web_sys::BlobPropertyBag::new();
        blob_options.set_type("video/mp4");
        let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &blob_options)?;
        let observed = Rc::downgrade(&signals);
        let observed_video = video.clone();
        let visibility_listener = Closure::wrap(Box::new(move |_event: web_sys::Event| {
            let Some(signals) = observed.upgrade() else {
                return;
            };
            let Some(document) = web_sys::window().and_then(|window| window.document()) else {
                return;
            };
            let mut gate = signals.gate.get();
            gate.document_visible = !document.hidden();
            signals.gate.set(gate);
            sync_playback(&observed_video, &signals);
        }) as Box<dyn FnMut(web_sys::Event)>);
        let object_url = web_sys::Url::create_object_url_with_blob(&blob)?;
        // From this point all exits are owned by Drop. The shell explicitly
        // starts playback only after the entry slide's native movie control
        // becomes visible; creating a menu never starts its media clock.
        let surface = Self {
            video,
            canvas,
            context,
            object_url,
            signals,
            frame_callback,
            request_frame,
            cancel_frame,
            callback_id: None,
            clock: VideoFrameClock::default(),
            width,
            height,
            reported_first_frame: false,
            document,
            visibility_listener,
        };
        surface.video.set_src(&surface.object_url);
        surface.document.add_event_listener_with_callback(
            "visibilitychange",
            surface.visibility_listener.as_ref().unchecked_ref(),
        )?;
        Ok(surface)
    }

    pub(super) fn set_playing(&mut self, playing: bool) {
        let mut gate = self.signals.gate.get();
        gate.menu_shown = playing;
        self.signals.gate.set(gate);
        sync_playback(&self.video, &self.signals);
    }

    pub(super) fn set_window_active(&mut self, active: bool) {
        let mut gate = self.signals.gate.get();
        gate.window_active = active;
        self.signals.gate.set(gate);
        sync_playback(&self.video, &self.signals);
    }

    fn request_next_frame(&mut self) {
        if self.signals.callback_pending.get() {
            return;
        }
        let Some(request) = self.request_frame.as_ref() else {
            return;
        };
        match request.call1(&self.video, self.frame_callback.as_ref()) {
            Ok(id) => {
                self.callback_id = Some(id);
                self.signals.callback_pending.set(true);
            }
            Err(_) => self.request_frame = None,
        }
    }

    pub(super) fn frame(&mut self) -> FrameUpdate {
        if self.signals.playback.get() == Playback::Failed || self.video.error().is_some() {
            return FrameUpdate::Failed;
        }
        if self.signals.playback.get() != Playback::Playing
            || self.video.ready_state() < 2
            || self.video.video_width() == 0
            || self.video.video_height() == 0
        {
            return FrameUpdate::Waiting;
        }
        let (time, decoded_timestamp) = if self.request_frame.is_some() {
            let time = self.signals.frame_time.take();
            self.request_next_frame();
            match time {
                Some(time) => (time, true),
                None => return FrameUpdate::Unchanged,
            }
        } else {
            // Older browsers: sample the media clock at the approved 15 fps.
            (self.video.current_time(), false)
        };
        if !self.clock.admit(time, decoded_timestamp) {
            return FrameUpdate::Unchanged;
        }
        let decoded = self
            .context
            .draw_image_with_html_video_element_and_dw_and_dh(
                &self.video,
                0.0,
                0.0,
                f64::from(self.width),
                f64::from(self.height),
            )
            .and_then(|()| {
                self.context
                    .get_image_data(0.0, 0.0, f64::from(self.width), f64::from(self.height))
            });
        let Ok(decoded) = decoded else {
            return FrameUpdate::Failed;
        };
        if !self.reported_first_frame {
            self.reported_first_frame = true;
            log::info!(
                "Browser MP4 menu decoder produced its first frame ({}x{})",
                self.video.video_width(),
                self.video.video_height()
            );
        }
        FrameUpdate::Ready(decoded.data().0)
    }
}

impl Drop for BrowserMenuVideo {
    fn drop(&mut self) {
        let _ = self.document.remove_event_listener_with_callback(
            "visibilitychange",
            self.visibility_listener.as_ref().unchecked_ref(),
        );
        if let (Some(cancel), Some(id)) = (&self.cancel_frame, &self.callback_id) {
            let _ = cancel.call1(&self.video, id);
        }
        let _ = self.video.pause();
        let _ = self.video.remove_attribute("src");
        // load() aborts pending play promises and releases the decoder's source.
        // https://html.spec.whatwg.org/multipage/media.html#dom-media-load
        self.video.load();
        let _ = web_sys::Url::revoke_object_url(&self.object_url);
        self.canvas.set_width(0);
        self.canvas.set_height(0);
    }
}
