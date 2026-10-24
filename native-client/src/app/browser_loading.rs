//! Bounded observations of the browser's map-to-first-battle-frame handoff.
//!
//! This owns no game or GPU state. Callers provide their clock observations;
//! repeated stage marks update elapsed time without growing the history.

use std::collections::VecDeque;

const HISTORY_LIMIT: usize = 24;

struct StageObservation {
    stage: &'static str,
    elapsed_ms: f64,
}

pub(super) struct BrowserLoadingTrace {
    generation: u64,
    active: bool,
    stage: &'static str,
    started_ms: f64,
    observed_ms: f64,
    history: VecDeque<StageObservation>,
}

impl Default for BrowserLoadingTrace {
    fn default() -> Self {
        Self {
            generation: 0,
            active: false,
            stage: "idle",
            started_ms: 0.0,
            observed_ms: 0.0,
            history: VecDeque::new(),
        }
    }
}

impl BrowserLoadingTrace {
    pub(super) fn begin(&mut self, now_ms: f64) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.active = true;
        self.stage = "map-loading";
        self.started_ms = if now_ms.is_finite() { now_ms } else { 0.0 };
        self.observed_ms = self.started_ms;
        self.history.clear();
        self.history.push_back(StageObservation {
            stage: self.stage,
            elapsed_ms: 0.0,
        });
    }

    pub(super) fn mark(&mut self, stage: &'static str, now_ms: f64) {
        if !self.active {
            return;
        }
        if now_ms.is_finite() {
            self.observed_ms = self.observed_ms.max(now_ms);
        }
        if self.stage == stage {
            return;
        }
        self.stage = stage;
        if self.history.len() == HISTORY_LIMIT {
            self.history.pop_front();
        }
        self.history.push_back(StageObservation {
            stage,
            elapsed_ms: self.elapsed_ms(),
        });
    }

    pub(super) fn stage(&self) -> &str {
        self.stage
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn complete(&mut self, generation: u64, now_ms: f64) {
        if !self.active || generation != self.generation {
            return;
        }
        self.mark("battle-ready", now_ms);
        self.active = false;
    }

    /// Freeze the failure location before outstanding GPU callbacks can arrive.
    pub(super) fn fail(&mut self) {
        self.active = false;
    }

    pub(super) fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "stage": self.stage,
            "elapsedMs": self.elapsed_ms(),
            "generation": self.generation,
            "active": self.active,
            "history": self.history.iter().map(|observation| serde_json::json!({
                "stage": observation.stage,
                "elapsedMs": observation.elapsed_ms,
            })).collect::<Vec<_>>(),
        })
    }

    fn elapsed_ms(&self) -> f64 {
        self.observed_ms - self.started_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_loading_trace_reentry_resets_history_and_elapsed_time() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(100.0);
        let first = trace.generation();
        trace.mark("font-start", 120.0);
        assert_eq!(trace.snapshot()["elapsedMs"], 20.0);
        trace.begin(200.0);
        assert_ne!(trace.generation(), first);
        assert_eq!(trace.stage(), "map-loading");
        let snapshot = trace.snapshot();
        assert_eq!(snapshot["elapsedMs"], 0.0);
        assert_eq!(snapshot["history"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["history"][0]["stage"], "map-loading");
        assert_eq!(snapshot["active"], true);
    }

    #[test]
    fn browser_loading_trace_stale_gpu_completion_cannot_finish_new_match() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(10.0);
        let old_generation = trace.generation();
        trace.mark("first-submit", 20.0);
        trace.begin(30.0);
        trace.mark("world-installed", 35.0);
        let before = trace.snapshot();
        trace.complete(old_generation, 90.0);
        assert_eq!(trace.snapshot(), before);
        trace.complete(trace.generation(), 100.0);
        assert_eq!(trace.stage(), "battle-ready");
        assert_eq!(trace.snapshot()["elapsedMs"], 70.0);
    }

    #[test]
    fn browser_loading_trace_duplicate_stage_marks_update_time_without_history() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(10.0);
        trace.mark("first-render", 20.0);
        trace.mark("first-render", 30.0);
        trace.mark("first-render", 40.0);
        let snapshot = trace.snapshot();
        assert_eq!(snapshot["elapsedMs"], 30.0);
        assert_eq!(snapshot["history"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["history"][1]["elapsedMs"], 10.0);
    }

    #[test]
    fn browser_loading_trace_history_retains_at_most_latest_24_changes() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(0.0);
        for index in 0..32 {
            let stage = if index % 2 == 0 { "phase-a" } else { "phase-b" };
            trace.mark(stage, f64::from(index + 1));
        }
        let snapshot = trace.snapshot();
        let history = snapshot["history"].as_array().unwrap();
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history[0]["elapsedMs"], 9.0);
        assert_eq!(history[HISTORY_LIMIT - 1]["elapsedMs"], 32.0);
        assert_eq!(trace.stage(), "phase-b");
    }

    #[test]
    fn browser_loading_trace_completed_frame_stays_frozen_until_new_begin() {
        let mut trace = BrowserLoadingTrace::default();
        trace.mark("first-render", 1.0);
        assert_eq!(trace.stage(), "idle");
        trace.complete(0, 2.0);
        assert_eq!(trace.stage(), "idle");
        trace.begin(10.0);
        let generation = trace.generation();
        trace.mark("first-submit", 20.0);
        trace.complete(generation, 30.0);
        let completed = trace.snapshot();
        assert_eq!(completed["active"], false);
        for _ in 0..5 {
            trace.mark("first-render", 100.0);
            trace.mark("first-submit", 110.0);
            trace.complete(generation, 120.0);
        }
        assert_eq!(trace.snapshot(), completed);
    }

    #[test]
    fn browser_loading_trace_failure_freezes_stage_despite_matching_gpu_completion() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(10.0);
        let generation = trace.generation();
        trace.mark("first-submit", 20.0);
        trace.fail();
        let failed = trace.snapshot();
        assert_eq!(failed["active"], false);
        assert_eq!(failed["stage"], "first-submit");
        assert_eq!(failed["elapsedMs"], 10.0);
        trace.complete(generation, 30.0);
        trace.mark("first-render", 40.0);
        trace.fail();
        assert_eq!(trace.snapshot(), failed);

        trace.begin(50.0);
        trace.complete(trace.generation(), 60.0);
        assert_eq!(trace.stage(), "battle-ready");
    }

    #[test]
    fn browser_loading_trace_invalid_or_older_clock_samples_do_not_regress() {
        let mut trace = BrowserLoadingTrace::default();
        trace.begin(10.0);
        trace.mark("first-render", 20.0);
        trace.mark("first-render", f64::NAN);
        trace.mark("first-render", 15.0);
        assert_eq!(trace.snapshot()["elapsedMs"], 10.0);
    }
}
