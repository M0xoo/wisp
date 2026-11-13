//! Commit and epoch listeners. A listener runs on the writer thread right after its transaction commits
//! (never for a rolled-back one), so commit order is the order listeners hear; dropping the returned
//! `Subscription` unsubscribes.

use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};

use crate::changes::ChangeRow;
use crate::store::{Shared, Store};

impl Store {
    // ---------- listeners ----------

    /// Hears every committed transaction's change rows, in commit order, on the writer thread right after
    /// the commit (never for a rolled-back one). Keep it quick: hand the rows to a channel. Dropping the
    /// returned guard unsubscribes.
    pub fn on_commit(&self, f: impl Fn(&Arc<[ChangeRow]>) + Send + Sync + 'static) -> Subscription {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        self.shared.listeners.write().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(f)));
        Subscription { shared: Arc::downgrade(&self.shared), id }
    }

    /// Hears a new epoch (after a restore or an import).
    pub fn on_epoch(&self, f: impl Fn(&str) + Send + Sync + 'static) -> Subscription {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        self.shared.epoch_listeners.write().unwrap_or_else(PoisonError::into_inner).push((id, Arc::new(f)));
        Subscription { shared: Arc::downgrade(&self.shared), id }
    }
}

/// Unsubscribes its listener when dropped.
#[must_use = "dropping a Subscription unsubscribes at once"]
pub struct Subscription {
    shared: std::sync::Weak<Shared>,
    id: u64,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription").field("id", &self.id).finish_non_exhaustive()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(s) = self.shared.upgrade() {
            s.listeners.write().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
            s.epoch_listeners.write().unwrap_or_else(PoisonError::into_inner).retain(|(id, _)| *id != self.id);
        }
    }
}
