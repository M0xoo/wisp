//! Two implementations of the kernel's `Clock`: the real one, and a manual one for tests and simulations,
//! where time moves only when the test says so (the coalescer's 250 ms timer, retention, blob grace).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, PoisonError};

use wisp_kernel::{BoxFuture, Clock};

/// Wall-clock milliseconds and tokio sleeps.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }
}

/// A clock that only moves on `advance`/`set`; a `sleep` resolves once time has passed its deadline.
#[derive(Debug)]
pub struct ManualClock {
    now: AtomicI64,
    sleepers: Mutex<Vec<(i64, tokio::sync::oneshot::Sender<()>)>>,
}

impl ManualClock {
    pub fn new(start_ms: i64) -> Self {
        Self {
            now: AtomicI64::new(start_ms),
            sleepers: Mutex::new(Vec::new()),
        }
    }
    pub fn advance(&self, ms: i64) {
        self.set(self.now.load(Ordering::SeqCst) + ms);
    }
    pub fn set(&self, ms: i64) {
        self.now.store(ms, Ordering::SeqCst);
        let due: Vec<_> = {
            let mut s = self.sleepers.lock().unwrap_or_else(PoisonError::into_inner);
            let (due, keep): (Vec<_>, Vec<_>) = s.drain(..).partition(|(at, _)| *at <= ms);
            *s = keep;
            due
        };
        for (_, tx) in due {
            let _ = tx.send(());
        }
    }
    /// sleeps not yet due whose future is still alive
    pub fn pending(&self) -> usize {
        self.sleepers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(_, tx)| !tx.is_closed())
            .count()
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        let at = self
            .now_ms()
            .saturating_add(i64::try_from(ms).unwrap_or(i64::MAX));
        if ms == 0 {
            return Box::pin(async {});
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sleepers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((at, tx));
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}
