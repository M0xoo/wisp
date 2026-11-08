//! The kernel's shared state. Plugins reach it only through `Ctx` (which holds a weak reference, so a
//! plugin's handles never keep a stopped kernel alive) and the edge through `Kernel`.
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::reg::Registry;
use crate::{Clock, Result, WireError};

pub(crate) type Erased = Arc<dyn Any + Send + Sync>;

/// Work the kernel started and owes: queued event deliveries and follow-up root calls. `idle` waits
/// for it to reach zero (tests, graceful shutdown).
#[derive(Debug, Default)]
pub(crate) struct Work {
    n: AtomicUsize,
    zero: Notify,
}

impl Work {
    pub(crate) fn add(&self, k: usize) {
        self.n.fetch_add(k, Ordering::AcqRel);
    }
    pub(crate) fn done(&self, k: usize) {
        if k > 0 && self.n.fetch_sub(k, Ordering::AcqRel) == k {
            self.zero.notify_waiters();
        }
    }
    pub(crate) async fn idle(&self) {
        loop {
            let wait = self.zero.notified();
            tokio::pin!(wait);
            wait.as_mut().enable();
            if self.n.load(Ordering::Acquire) == 0 {
                return;
            }
            wait.await;
        }
    }
}

/// Test-only knobs (plan §6.11.2 rule 8): a random order for interceptors of equal priority, and
/// injected slowness per (plugin, hook).
#[derive(Debug, Default, Clone)]
pub(crate) struct Chaos {
    pub(crate) seed: Option<u64>,
    pub(crate) delays: Vec<(String, String, u64)>,
}

pub(crate) struct KernelState {
    pub(crate) services: RwLock<HashMap<TypeId, Erased>>,
    pub(crate) root: CancellationToken,
    pub(crate) caps: crate::caps::Registry,
    pub(crate) reg: RwLock<Registry>,
    pub(crate) plugins: Mutex<crate::life::Plugins>,
    pub(crate) bus: crate::events::Bus,
    pub(crate) diag: crate::diag::Diagnostics,
    pub(crate) settings: crate::settings::Settings,
    pub(crate) work: Arc<Work>,
    pub(crate) chaos: RwLock<Chaos>,
}

impl Default for KernelState {
    fn default() -> Self {
        let work = Arc::new(Work::default());
        Self {
            services: RwLock::default(),
            root: CancellationToken::new(),
            caps: crate::caps::Registry::default(),
            reg: RwLock::default(),
            plugins: Mutex::default(),
            bus: crate::events::Bus::new(work.clone()),
            diag: crate::diag::Diagnostics::new(50),
            settings: crate::settings::Settings::default(),
            work,
            chaos: RwLock::default(),
        }
    }
}

impl Drop for KernelState {
    fn drop(&mut self) {
        // the last handle is gone: every plugin task, timer and child goes with it
        self.root.cancel();
    }
}

impl KernelState {
    pub(crate) fn service<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        let map = self.services.read().ok()?;
        map.get(&TypeId::of::<T>())
            .and_then(|v| v.clone().downcast::<T>().ok())
    }

    pub(crate) fn clock(&self) -> Option<Arc<dyn Clock>> {
        self.service::<Arc<dyn Clock>>().map(|c| (*c).clone())
    }

    /// Milliseconds since the epoch, from the injected clock when there is one.
    pub(crate) fn now_ms(&self) -> i64 {
        if let Some(c) = self.clock() {
            return c.now_ms();
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }

    /// Sleeps on the injected clock (a fake one in tests), else on tokio's.
    pub(crate) fn sleep(&self, ms: u64) -> crate::BoxFuture<'static, ()> {
        match self.clock() {
            Some(c) => c.sleep(ms),
            None => Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms))),
        }
    }

    pub(crate) fn read_reg(&self) -> Result<std::sync::RwLockReadGuard<'_, Registry>> {
        self.reg
            .read()
            .map_err(|_| WireError::internal("registry lock poisoned"))
    }

    pub(crate) fn write_reg(&self) -> Result<std::sync::RwLockWriteGuard<'_, Registry>> {
        self.reg
            .write()
            .map_err(|_| WireError::internal("registry lock poisoned"))
    }

    pub(crate) fn lock_plugins(&self) -> Result<std::sync::MutexGuard<'_, crate::life::Plugins>> {
        self.plugins
            .lock()
            .map_err(|_| WireError::internal("plugin table lock poisoned"))
    }
}
