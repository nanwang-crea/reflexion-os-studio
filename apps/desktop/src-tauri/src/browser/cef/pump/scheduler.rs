use std::time::{Duration, Instant};
#[derive(Default)]
pub(super) struct Scheduler {
    pub deadline: Option<Instant>,
    pub stopped: bool,
    pub posted: bool,
    pub running: bool,
    drain: u8,
}
impl Scheduler {
    pub fn schedule(&mut self, now: Instant, delay: Duration) {
        if self.stopped {
            return;
        }
        self.drain = 64;
        let next = now + delay;
        self.deadline = Some(self.deadline.map_or(next, |old| old.min(next)));
    }
    pub fn claim(&mut self, now: Instant) -> bool {
        if self.stopped || self.posted || self.running || self.deadline.is_none_or(|d| d > now) {
            return false;
        }
        self.posted = true;
        self.deadline = None;
        true
    }
    pub fn enter(&mut self) -> bool {
        self.posted = false;
        if self.stopped || self.running {
            return false;
        }
        self.running = true;
        true
    }
    pub fn finish(&mut self, now: Instant, pending: bool) {
        self.running = false;
        if self.stopped {
            return;
        }
        if pending {
            self.schedule(now, Duration::ZERO);
        } else if self.deadline.is_none() && self.drain > 0 {
            self.drain -= 1;
            self.deadline = Some(now + Duration::from_millis(16));
        }
    }
    pub fn stop(&mut self) {
        self.stopped = true;
        self.deadline = None;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notifications_coalesce_and_never_post_a_second_inflight_pump() {
        let mut s = Scheduler::default();
        let now = Instant::now();
        s.schedule(now, Duration::ZERO);
        assert!(s.claim(now));
        for _ in 0..1000 {
            s.schedule(now, Duration::ZERO);
            assert!(!s.claim(now));
        }
        assert!(s.enter());
        assert!(!s.enter());
        assert!(!s.claim(now));
        s.finish(now, false);
        assert!(s.claim(now));
    }
    #[test]
    fn later_deadline_never_postpones_urgent_work() {
        let mut s = Scheduler::default();
        let now = Instant::now();
        s.schedule(now, Duration::ZERO);
        s.schedule(now, Duration::from_secs(60));
        assert!(s.claim(now));
    }
    #[test]
    fn stopped_queue_rejects_already_posted_work_and_new_notifications() {
        let mut s = Scheduler::default();
        let now = Instant::now();
        s.schedule(now, Duration::ZERO);
        assert!(s.claim(now));
        s.stop();
        assert!(!s.enter());
        s.schedule(now, Duration::ZERO);
        assert!(!s.claim(now));
        assert!(s.deadline.is_none());
    }
    #[test]
    fn bounded_drain_returns_to_idle_and_does_not_poll_forever() {
        let mut s = Scheduler::default();
        let mut now = Instant::now();
        s.schedule(now, Duration::ZERO);
        let mut runs = 0;
        while s.deadline.is_some() {
            assert!(s.claim(now));
            assert!(s.enter());
            s.finish(now, false);
            now += Duration::from_millis(16);
            runs += 1;
            assert!(runs <= 65);
        }
        assert_eq!(runs, 65);
        assert!(!s.claim(now + Duration::from_secs(1000)));
    }
}
