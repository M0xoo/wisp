//! Time, injected: every part of the grid asks a `Clock` for "now" in epoch milliseconds, so tests
//! (and the wake bench) can run hours of idle timers in a few milliseconds.
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

pub trait Clock: Send + Sync + std::fmt::Debug {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
}

/// The wall clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

/// A clock a test moves by hand.
#[derive(Debug, Default)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(at: i64) -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(at)))
    }
    pub fn set(&self, at: i64) {
        self.0.store(at, Ordering::SeqCst);
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub type SharedClock = Arc<dyn Clock>;

/// The wall clock, shared.
pub fn system() -> SharedClock {
    Arc::new(SystemClock)
}
