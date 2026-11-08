//! What worktrees reads from the rest of wisp, as one kernel service the install provides
//! (`ctx.service::<Arc<dyn Port>>()`): the tasks and their worktrees (runtime's sessions, the
//! `ext["wisp.worktrees"]` slot), whether each is in use (runtime, terminal, preview), its PRs (ship),
//! and the plugin's own settings and trust state. Until wisp-runtime and wisp-store land the adapter is
//! the install's; tests use `MemPort`.

use std::sync::{Arc, Mutex};

use wisp_kernel::BoxFuture;
use wisp_worktrees_api::{CleanedRecord, PrRef, Worktree};
use wisp_worktrees_core::trust::TrustState;

/// One folder of a task (its own, or one of its `also` runs'), with that run's PR.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskTree {
    pub worktree: Worktree,
    pub pr: Option<PrRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // facts about a task the cleanup reads
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub project: String,
    pub done: bool,
    /// running, waiting, asking, shipping, queued, or a shell/app/side discussion in it, or its lead's
    pub busy: bool,
    pub kept: bool,
    pub parked: bool,
    pub updated_at: i64,
    pub created_at: i64,
    pub trees: Vec<TaskTree>,
    /// children and delegated sessions
    pub kids: Vec<String>,
    pub parent_id: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WtSettings {
    /// defaults.worktreeCleanup: days or "off"; None never chosen
    pub cleanup: Option<String>,
    /// defaults.worktreeMax: a count or "off"
    pub max: Option<String>,
    /// defaults.worktreeOnDone: ask | remove | keep
    pub on_done: Option<String>,
    /// defaults.projectAsk: "off" stops trust asking
    pub project_ask: Option<String>,
    /// when the cleanup default arrived (the clock starts then)
    pub cleanup_from: i64,
    pub last: Option<CleanedRecord>,
    pub trust: TrustState,
}

pub trait Port: Send + Sync + 'static {
    fn tasks(&self) -> BoxFuture<'static, Vec<TaskInfo>>;
    fn set_kept(&self, id: String, kept: bool) -> BoxFuture<'static, ()>;
    fn settings(&self) -> BoxFuture<'static, WtSettings>;
    fn save_settings(&self, s: WtSettings) -> BoxFuture<'static, ()>;
    /// the machine is short (memory, load): sweeps and du wait for the next hour
    fn machine_short(&self) -> bool {
        false
    }
}

/// An in-memory port: tests, and a headless install without runtime.
#[derive(Debug, Default)]
pub struct MemPort {
    pub tasks: Mutex<Vec<TaskInfo>>,
    pub settings: Mutex<WtSettings>,
    pub short: std::sync::atomic::AtomicBool,
}

impl MemPort {
    pub fn new(tasks: Vec<TaskInfo>, settings: WtSettings) -> Arc<Self> {
        Arc::new(Self {
            tasks: Mutex::new(tasks),
            settings: Mutex::new(settings),
            short: false.into(),
        })
    }
}

impl Port for MemPort {
    fn tasks(&self) -> BoxFuture<'static, Vec<TaskInfo>> {
        let v = self.tasks.lock().map(|t| t.clone()).unwrap_or_default();
        Box::pin(async move { v })
    }
    fn set_kept(&self, id: String, kept: bool) -> BoxFuture<'static, ()> {
        if let Ok(mut t) = self.tasks.lock() {
            for x in t.iter_mut().filter(|x| x.id == id) {
                x.kept = kept;
            }
        }
        Box::pin(async {})
    }
    fn settings(&self) -> BoxFuture<'static, WtSettings> {
        let v = self.settings.lock().map(|s| s.clone()).unwrap_or_default();
        Box::pin(async move { v })
    }
    fn save_settings(&self, s: WtSettings) -> BoxFuture<'static, ()> {
        if let Ok(mut cur) = self.settings.lock() {
            *cur = s;
        }
        Box::pin(async {})
    }
    fn machine_short(&self) -> bool {
        self.short.load(std::sync::atomic::Ordering::Relaxed)
    }
}
