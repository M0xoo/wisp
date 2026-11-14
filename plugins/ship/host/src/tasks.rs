//! wisp.ship's rows: each task's ship slot (`ShipTask`). Kept here behind this small type until
//! wisp-store lands; then they move to ship's own table (`ship_task`, plugin prefix) and every write goes
//! through a command's transaction. Also what ship hears from runtime about a task (running, asking).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use wisp_ship_api::ShipTask;
use wisp_ship_core::follow::Busy;

/// Told the id of each task written (put or changed in place): the host keeps the slot on the session.
pub type OnChange = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct Tasks {
    rows: Mutex<HashMap<String, ShipTask>>,
    live: Mutex<HashSet<String>>,
    asking: Mutex<HashSet<String>>,
    changed: OnceLock<OnChange>,
}

impl std::fmt::Debug for Tasks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tasks").field("rows", &lock(&self.rows).len()).finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Tasks {
    pub fn get(&self, id: &str) -> Option<ShipTask> {
        lock(&self.rows).get(id).cloned()
    }

    /// Who hears of each write (set once, when the plugin starts).
    pub fn on_change(&self, f: OnChange) {
        let _ = self.changed.set(f);
    }

    fn changed(&self, id: &str) {
        if let Some(f) = self.changed.get() {
            f(id);
        }
    }

    /// Writes a task; told only when it differs from what was there.
    pub fn put(&self, task: ShipTask) {
        let id = task.session.clone();
        let same = {
            let mut rows = lock(&self.rows);
            let same = rows.get(&id) == Some(&task);
            rows.insert(id.clone(), task);
            same
        };
        if !same {
            self.changed(&id);
        }
    }

    /// Changes a task in place; None when it's gone.
    pub fn update<R>(&self, id: &str, f: impl FnOnce(&mut ShipTask) -> R) -> Option<R> {
        let (out, differs) = {
            let mut rows = lock(&self.rows);
            let t = rows.get_mut(id)?;
            let was = t.clone();
            let out = f(t);
            (out, *t != was)
        };
        if differs {
            self.changed(id);
        }
        Some(out)
    }

    pub fn remove(&self, id: &str) {
        lock(&self.rows).remove(id);
    }

    pub fn all(&self) -> Vec<ShipTask> {
        lock(&self.rows).values().cloned().collect()
    }

    pub fn set_live(&self, id: &str, on: bool) {
        let mut l = lock(&self.live);
        if on {
            l.insert(id.to_owned())
        } else {
            l.remove(id)
        };
    }

    pub fn set_asking(&self, id: &str, on: bool) {
        let mut a = lock(&self.asking);
        if on {
            a.insert(id.to_owned())
        } else {
            a.remove(id)
        };
    }

    pub fn is_live(&self, id: &str) -> bool {
        lock(&self.live).contains(id)
    }

    pub fn busy(&self, task: &ShipTask, starting: bool) -> Busy {
        Busy {
            live: self.is_live(&task.session),
            ask: lock(&self.asking).contains(&task.session),
            shipping: task.shipping.is_some(),
            archived: task.archived,
            starting,
        }
    }
}
