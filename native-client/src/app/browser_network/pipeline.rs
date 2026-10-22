//! Bounded transport frontiers. This owner never advances the simulation or
//! authorizes gameplay commands; the caller admits a buffered turn only when
//! its exact world tick is about to execute.

use std::collections::VecDeque;
use std::ops::Range;

pub(super) const PROTOCOL: u32 = 3;
pub(super) const MAX_INPUT_DELAY_TICKS: u64 = 16;

pub(super) struct TurnPipeline<T> {
    input_delay: u64,
    first_tick: u64,
    next_submit: u64,
    next_receive: u64,
    turns: VecDeque<(u64, T)>,
}

impl<T> TurnPipeline<T> {
    pub(super) fn new(
        protocol: u32,
        first_tick: u64,
        input_delay: u64,
    ) -> Result<Self, &'static str> {
        if protocol != PROTOCOL
            || first_tick == 0
            || !(1..=MAX_INPUT_DELAY_TICKS).contains(&input_delay)
        {
            return Err("unsupported native input delay or first tick");
        }
        first_tick
            .checked_add(input_delay)
            .ok_or("native input horizon overflow")?;
        Ok(Self {
            input_delay,
            first_tick,
            next_submit: first_tick,
            next_receive: first_tick,
            turns: VecDeque::new(),
        })
    }

    pub(super) fn input_delay(&self) -> u64 {
        self.input_delay
    }

    pub(super) fn submitted_through(&self) -> u64 {
        self.next_submit - 1
    }

    pub(super) fn received_through(&self) -> u64 {
        self.next_receive - 1
    }

    pub(super) fn queued_turns(&self) -> usize {
        self.turns.len()
    }

    /// Seal the initial empty prefix, then one future input per actual world
    /// commit. Repeated polls at the same tick produce no extra submissions.
    /// The caller places its authored input only in the last returned tick.
    pub(super) fn seal(&mut self, next_world_tick: u64) -> Result<Range<u64>, &'static str> {
        if next_world_tick < self.first_tick || next_world_tick > self.next_submit {
            return Err("native world advanced outside submitted input horizon");
        }
        let end = next_world_tick
            .checked_add(self.input_delay)
            .ok_or("native input horizon overflow")?;
        if end < self.next_submit {
            return Err("native world tick moved backwards");
        }
        let range = self.next_submit..end;
        self.next_submit = end;
        Ok(range)
    }

    fn admit_receipt(&mut self, tick: u64) -> Result<(), &'static str> {
        if tick != self.next_receive || tick >= self.next_submit {
            return Err("duplicate, stale, unsubmitted or unordered native turn");
        }
        self.next_receive = tick.checked_add(1).ok_or("native receipt tick overflow")?;
        Ok(())
    }

    pub(super) fn receive(
        &mut self,
        tick: u64,
        next_world_tick: u64,
        commands: T,
    ) -> Result<(), &'static str> {
        let end = next_world_tick
            .checked_add(self.input_delay)
            .ok_or("native receipt horizon overflow")?;
        if tick < next_world_tick || tick >= end || self.turns.len() >= self.input_delay as usize {
            return Err("native turn exceeds the current input window");
        }
        self.admit_receipt(tick)?;
        self.turns.push_back((tick, commands));
        Ok(())
    }

    pub(super) fn take_current(&mut self, next_world_tick: u64) -> Option<T> {
        if self
            .turns
            .front()
            .is_some_and(|(tick, _)| *tick == next_world_tick)
        {
            self.turns.pop_front().map(|(_, commands)| commands)
        } else {
            None
        }
    }

    pub(super) fn clear_buffer(&mut self) {
        self.turns.clear();
    }

    /// An already sealed turn may arrive after local terminal observation.
    /// Authenticate that bounded tail without storing or executing it.
    pub(super) fn retire_receipt(&mut self, tick: u64) -> Result<(), &'static str> {
        self.admit_receipt(tick)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_window_and_refill_do_not_wait_for_receipts() {
        let mut pipeline = TurnPipeline::<()>::new(PROTOCOL, 101, 8).unwrap();
        assert_eq!(pipeline.seal(101).unwrap(), 101..109);
        assert_eq!(pipeline.seal(101).unwrap(), 109..109);
        for tick in 101..109 {
            pipeline.receive(tick, 101, ()).unwrap();
        }
        assert_eq!(pipeline.queued_turns(), 8);
        assert_eq!(pipeline.take_current(101), Some(()));
        assert_eq!(pipeline.seal(102).unwrap(), 109..110);
        assert_eq!(pipeline.submitted_through(), 109);
        assert_eq!(pipeline.received_through(), 108);
        assert_eq!(pipeline.input_delay(), 8);
    }

    #[test]
    fn buffered_future_commands_are_not_exposed_early() {
        let mut pipeline = TurnPipeline::new(PROTOCOL, 11, 3).unwrap();
        pipeline.seal(11).unwrap();
        pipeline.receive(11, 11, vec!["first"]).unwrap();
        pipeline.receive(12, 11, vec!["future"]).unwrap();
        assert_eq!(pipeline.take_current(12), None);
        assert_eq!(pipeline.take_current(11), Some(vec!["first"]));
        assert_eq!(pipeline.take_current(11), None);
        assert_eq!(pipeline.take_current(12), Some(vec!["future"]));
    }

    #[test]
    fn out_of_order_duplicate_and_unsubmitted_receipts_are_rejected() {
        let mut pipeline = TurnPipeline::new(PROTOCOL, 1, 2).unwrap();
        assert!(pipeline.receive(1, 1, ()).is_err());
        pipeline.seal(1).unwrap();
        assert!(pipeline.receive(2, 1, ()).is_err());
        pipeline.receive(1, 1, ()).unwrap();
        assert!(pipeline.receive(1, 1, ()).is_err());
        pipeline.receive(2, 1, ()).unwrap();
        assert!(pipeline.receive(3, 1, ()).is_err());
        assert_eq!(pipeline.received_through(), 2);
    }

    #[test]
    fn terminal_tail_is_bounded_and_never_buffers() {
        let mut pipeline = TurnPipeline::new(PROTOCOL, 1, 8).unwrap();
        pipeline.seal(1).unwrap();
        pipeline.receive(1, 1, ()).unwrap();
        pipeline.receive(2, 1, ()).unwrap();
        pipeline.clear_buffer();
        assert!(pipeline.retire_receipt(2).is_err());
        for tick in 3..9 {
            pipeline.retire_receipt(tick).unwrap();
        }
        assert!(pipeline.retire_receipt(9).is_err());
        assert_eq!(pipeline.queued_turns(), 0);
    }

    #[test]
    fn unsupported_window_and_tick_overflow_are_rejected() {
        assert!(TurnPipeline::<()>::new(2, 1, 8).is_err());
        assert!(TurnPipeline::<()>::new(PROTOCOL, 0, 8).is_err());
        assert!(TurnPipeline::<()>::new(PROTOCOL, 1, 0).is_err());
        assert!(TurnPipeline::<()>::new(PROTOCOL, 1, MAX_INPUT_DELAY_TICKS + 1).is_err());
        assert!(TurnPipeline::<()>::new(PROTOCOL, u64::MAX - 1, 8).is_err());
        let mut pipeline = TurnPipeline::<()>::new(PROTOCOL, 10, 8).unwrap();
        assert!(pipeline.seal(9).is_err());
        assert!(pipeline.seal(11).is_err());
    }
}
