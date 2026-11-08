//! The running Ship it: the shipper (git.service + gh), the tracked tasks, and the sink every
//! announcement goes through (the plugin turns each into its event; tests collect them). The flows are
//! in `flow.rs` (ship, merge, attach, panel) and `follow.rs` (PR polling, conflict fixes, rechecks).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use wisp_ship_api::{ConflictFix, PrRef, PrSummary, ShipTask, Shipping, Synced, ToShip};
use wisp_ship_core::recheck::CheckGate;

use crate::error::{Result, ShipError};
use crate::ops::{Shipper, exists};
use crate::tasks::Tasks;

/// What Ship it announces, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Step {
        session: String,
        shipping: Option<Shipping>,
    },
    ToShip {
        session: String,
        to_ship: ToShip,
    },
    PrOpened {
        session: String,
        repo: String,
        pr: PrSummary,
    },
    PrChanged {
        session: String,
        pr: PrSummary,
        news: bool,
    },
    Merged {
        session: String,
        prs: Vec<PrRef>,
        sync: Synced,
    },
    /// the task should get this follow-up (runtime sends it)
    FollowUp {
        session: String,
        prompt: String,
    },
    Fix {
        session: String,
        fix: ConflictFix,
    },
}

pub type Sink = Arc<dyn Fn(Out) + Send + Sync>;

pub struct Ship {
    pub shipper: Shipper,
    pub tasks: Arc<Tasks>,
    sink: Sink,
    /// one recheck at a time per task
    pub(crate) gate: Mutex<CheckGate>,
    /// the PR tick doesn't overlap itself
    pub(crate) polling: AtomicBool,
    /// tasks whose conflict fix is being decided (asking git about the base)
    starting: Mutex<HashSet<String>>,
    /// v1 `defaults.fixConflicts: 'on'`: conflicts are fixed without the user asking
    auto_fix: AtomicBool,
}

impl std::fmt::Debug for Ship {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ship")
            .field("shipper", &self.shipper)
            .finish_non_exhaustive()
    }
}

impl Ship {
    pub fn new(shipper: Shipper, tasks: Arc<Tasks>, sink: Sink) -> Self {
        Self {
            shipper,
            tasks,
            sink,
            gate: Mutex::default(),
            polling: AtomicBool::new(false),
            starting: Mutex::default(),
            auto_fix: AtomicBool::new(false),
        }
    }

    pub fn set_auto_fix(&self, on: bool) {
        self.auto_fix.store(on, Ordering::SeqCst);
    }

    pub(crate) fn auto_fix(&self) -> bool {
        self.auto_fix.load(Ordering::SeqCst)
    }

    pub(crate) fn starting(&self, session: &str, on: bool) {
        let mut s = self.starting.lock().unwrap_or_else(PoisonError::into_inner);
        if on {
            s.insert(session.to_owned());
        } else {
            s.remove(session);
        }
    }

    pub(crate) fn is_starting(&self, session: &str) -> bool {
        self.starting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(session)
    }

    pub(crate) fn emit(&self, out: Out) {
        (self.sink)(out);
    }

    /// The tracked task, or not found.
    pub fn task(&self, session: &str) -> Result<ShipTask> {
        self.tasks
            .get(session)
            .ok_or_else(|| ShipError::NotFound(format!("no such session: {session}")))
    }

    pub(crate) fn save(&self, task: ShipTask) {
        self.tasks.put(task);
    }

    /// Where gh runs for a task's PRs: its first worktree, else its folder, else the home folder (v1 ghDir).
    pub(crate) async fn gh_dir(task: &ShipTask) -> String {
        if let Some(r) = task.repos.first()
            && exists(&r.worktree.path).await
        {
            return r.worktree.path.clone();
        }
        if exists(&task.cwd).await {
            return task.cwd.clone();
        }
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
    }
}
