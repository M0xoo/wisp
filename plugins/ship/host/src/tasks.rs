//! wisp.ship's rows: each task's ship slot (`ShipTask`). Kept here behind this small type until
//! wisp-store lands; then they move to ship's own table (`ship_task`, plugin prefix) and every write goes
//! through a command's transaction. Also what ship hears from runtime about a task (running, asking).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use wisp_ship_api::ShipTask;
use wisp_ship_core::follow::Busy;

#[derive(Debug, Default)]
pub struct Tasks {
    rows: Mutex<HashMap<String, ShipTask>>,
    live: Mutex<HashSet<String>>,
    asking: Mutex<HashSet<String>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Tasks {
    pub fn get(&self, id: &str) -> Option<ShipTask> {
        lock(&self.rows).get(id).cloned()
    }

    pub fn put(&self, task: ShipTask) {
        lock(&self.rows).insert(task.session.clone(), task);
    }

    /// Changes a task in place; None when it's gone.
    pub fn update<R>(&self, id: &str, f: impl FnOnce(&mut ShipTask) -> R) -> Option<R> {
        lock(&self.rows).get_mut(id).map(f)
    }

    pub fn remove(&self, id: &str) {
        lock(&self.rows).remove(id);
    }

    pub fn all(&self) -> Vec<ShipTask> {
        lock(&self.rows).values().cloned().collect()
    }

    pub fn set_live(&self, id: &str, on: bool) {
        let mut l = lock(&self.live);
        if on { l.insert(id.to_owned()) } else { l.remove(id) };
    }

    pub fn set_asking(&self, id: &str, on: bool) {
        let mut a = lock(&self.asking);
        if on { a.insert(id.to_owned()) } else { a.remove(id) };
    }

    pub fn is_live(&self, id: &str) -> bool {
        lock(&self.live).contains(id)
    }

    pub fn busy(&self, task: &ShipTask, starting: bool) -> Busy {
        Busy { live: self.is_live(&task.session), ask: lock(&self.asking).contains(&task.session), shipping: task.shipping.is_some(), archived: task.archived, starting }
    }
}
