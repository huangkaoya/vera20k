//! Real rodio mixer output through CPAL WebAudio, retaining the exact contexts
//! so the native input owner can resume them during a trusted user gesture.

use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::cell::{Cell, RefCell};
use std::num::NonZero;
use wasm_bindgen::JsValue;

thread_local! {
    static CONTEXTS: RefCell<Vec<(u64, web_sys::AudioContext)>> = const { RefCell::new(Vec::new()) };
    static NEXT_CONTEXT: Cell<u64> = const { Cell::new(1) };
}

pub struct BrowserDevice {
    stream: rodio::cpal::Stream,
    mixer: rodio::mixer::Mixer,
    context_id: u64,
}

impl BrowserDevice {
    pub fn open(low_latency: bool) -> Result<Self, String> {
        let device = rodio::cpal::default_host()
            .default_output_device()
            .ok_or_else(|| "WebAudio output device unavailable".to_string())?;
        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        if supported.sample_format() != rodio::cpal::SampleFormat::F32 {
            return Err("WebAudio output requires f32 samples".into());
        }
        let channels = NonZero::new(supported.channels()).ok_or("zero WebAudio channels")?;
        let rate = NonZero::new(supported.sample_rate()).ok_or("zero WebAudio sample rate")?;
        let (mixer, mut source) = rodio::mixer::mixer(channels, rate);
        let frames = low_latency.then(|| {
            crate::audio::sfx::sfx_buffer_frames(supported.sample_rate(), supported.buffer_size())
        });
        let mut config: rodio::cpal::StreamConfig = supported.into();
        if let Some(frames) = frames {
            config.buffer_size = rodio::cpal::BufferSize::Fixed(frames);
        }
        let stream = device
            .build_output_stream::<f32, _, _>(
                &config,
                move |output, _| {
                    for sample in output {
                        *sample = source.next().unwrap_or(0.0);
                    }
                },
                |error| log::error!("WebAudio stream error: {error}"),
                None,
            )
            .map_err(|e| e.to_string())?;
        let rodio::cpal::platform::StreamInner::WebAudio(inner) = stream.as_inner();
        let context = inner.audio_context().clone();
        let context_id = NEXT_CONTEXT.with(|next| {
            let id = next.get();
            next.set(id + 1);
            id
        });
        CONTEXTS.with(|contexts| contexts.borrow_mut().push((context_id, context)));
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self {
            stream,
            mixer,
            context_id,
        })
    }

    pub fn mixer(&self) -> &rodio::mixer::Mixer {
        &self.mixer
    }
}

impl Drop for BrowserDevice {
    fn drop(&mut self) {
        let _ = self.stream.pause();
        CONTEXTS.with(|contexts| {
            let mut contexts = contexts.borrow_mut();
            if let Some(index) = contexts.iter().position(|(id, _)| *id == self.context_id) {
                let (_, context) = contexts.remove(index);
                let _ = context.close();
            }
        });
    }
}

/// Call directly from a trusted pointer/key event, never from the downloader.
/// The contexts belong to real music/SFX devices, and no global JS constructor
/// interception or unrelated silent audio source is used.
pub fn unlock() -> Result<(), JsValue> {
    let contexts = CONTEXTS.with(|contexts| {
        contexts
            .borrow()
            .iter()
            .map(|(_, c)| c.clone())
            .collect::<Vec<_>>()
    });
    for context in contexts {
        if context.state() == web_sys::AudioContextState::Closed {
            continue;
        }
        let resumed = context.resume()?;
        wasm_bindgen_futures::spawn_local(async move {
            if let Err(error) = wasm_bindgen_futures::JsFuture::from(resumed).await {
                log::warn!("WebAudio resume was denied: {error:?}");
            }
        });
    }
    Ok(())
}
