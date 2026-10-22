//! Let a submitted native loading frame reach a browser rendering opportunity.
//!
//! SurfaceTexture::present does not yield the JS task. Loading the rest of the
//! map synchronously and presenting black in that same task hides the loading
//! artwork. Two animation callbacks cross an actual rendering boundary before
//! admitting that work, without a fixed wall-clock delay or a second UI layer.
//! https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering

#[cfg(target_arch = "wasm32")]
use std::cell::Cell;
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

const PENDING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;

pub(super) struct BrowserPaintGate {
    state: Arc<AtomicU8>,
    scheduled: bool,
}

impl Default for BrowserPaintGate {
    fn default() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(PENDING)),
            scheduled: false,
        }
    }
}

impl BrowserPaintGate {
    fn pending_with(
        &mut self,
        schedule: impl FnOnce(Arc<AtomicU8>) -> Result<(), String>,
    ) -> Result<bool, String> {
        if !self.scheduled {
            schedule(Arc::clone(&self.state))?;
            self.scheduled = true;
        }
        match self.state.load(Ordering::Acquire) {
            PENDING => Ok(true),
            READY => Ok(false),
            _ => Err("browser loading-frame presentation failed".into()),
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn pending(&mut self, queue: &wgpu::Queue) -> Result<bool, String> {
        self.pending_with(|state| {
            // GPU submission is asynchronous on WebGPU. A rendering boundary
            // before the submitted image completes can still expose only the
            // preceding black canvas, so fence this image before yielding.
            SCHEDULED.with(|count| count.set(count.get().saturating_add(1)));
            queue.on_submitted_work_done(move || {
                if schedule_paint(Arc::clone(&state)).is_err() {
                    state.store(FAILED, Ordering::Release);
                    crate::app::browser::wake();
                }
            });
            Ok(())
        })
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static SCHEDULED: Cell<u32> = const { Cell::new(0) };
    static COMPLETED: Cell<u32> = const { Cell::new(0) };
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn counts() -> (u32, u32) {
    (SCHEDULED.with(Cell::get), COMPLETED.with(Cell::get))
}

#[cfg(target_arch = "wasm32")]
fn schedule_paint(state: Arc<AtomicU8>) -> Result<(), String> {
    use wasm_bindgen::{JsCast, closure::Closure};
    let window = web_sys::window().ok_or("loading presentation requires a Window")?;
    let state = Arc::downgrade(&state);
    let next_window = window.clone();
    let first = Closure::once_into_js(move |_now: f64| {
        if state.upgrade().is_none() {
            return;
        }
        let failed = state.clone();
        let second = Closure::once_into_js(move |_now: f64| {
            if let Some(state) = state.upgrade() {
                state.store(READY, Ordering::Release);
                COMPLETED.with(|count| count.set(count.get().saturating_add(1)));
                crate::app::browser::wake();
            }
        });
        if next_window
            .request_animation_frame(second.unchecked_ref())
            .is_err()
        {
            if let Some(state) = failed.upgrade() {
                state.store(FAILED, Ordering::Release);
            }
            crate::app::browser::wake();
        }
    });
    window
        .request_animation_frame(first.unchecked_ref())
        .map_err(|_| "could not schedule the browser loading frame".to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_loading_work_is_admitted_until_the_scheduled_render_boundary() {
        let mut gate = BrowserPaintGate::default();
        let mut completion = None;
        assert!(
            gate.pending_with(|state| {
                completion = Some(state);
                Ok(())
            })
            .unwrap()
        );
        assert!(
            gate.pending_with(|_| panic!("duplicate scheduling"))
                .unwrap()
        );
        completion.unwrap().store(READY, Ordering::Release);
        assert!(
            !gate
                .pending_with(|_| panic!("duplicate scheduling"))
                .unwrap()
        );
    }

    #[test]
    fn failed_schedule_or_callback_never_admits_work() {
        let mut gate = BrowserPaintGate::default();
        assert!(gate.pending_with(|_| Err("no browser".into())).is_err());
        assert!(
            gate.pending_with(|state| {
                state.store(FAILED, Ordering::Release);
                Ok(())
            })
            .is_err()
        );
    }
}
