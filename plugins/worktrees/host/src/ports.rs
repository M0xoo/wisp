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
    /// projects whose Bring in offer was dismissed (Not now)
    pub dismissed: Vec<String>,
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
    /// the declared projects, (name, folder): where Bring in looks
    fn projects(&self) -> BoxFuture<'static, Vec<(String, String)>> {
        Box::pin(async { Vec::new() })
    }
    /// a working task (running, asking or queued) has `path`, or a folder inside it, as one of its extra folders
    /// (`dirs`): an archived task's worktree it names stays while it works
    fn extra_in_use(&self, _path: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    /// a harness session ran outside wisp in this folder (a chat Bring in resumes)
    fn chat_in(&self, _path: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    /// make a task in another tool's worktree (marked foreign: the cleanup never touches it); its id
    fn bring_in(&self, _item: wisp_worktrees_api::OfferItem, _root: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

/// An in-memory port: tests, and a headless install without runtime.
#[derive(Debug, Default)]
pub struct MemPort {
    pub tasks: Mutex<Vec<TaskInfo>>,
    pub settings: Mutex<WtSettings>,
    pub short: std::sync::atomic::AtomicBool,
    pub projects: Mutex<Vec<(String, String)>>,
    /// what `bring_in` made: (path, root)
    pub brought: Mutex<Vec<(String, String)>>,
    /// the extra folders (`dirs`) of the tasks working now
    pub extras: Mutex<Vec<String>>,
}

impl MemPort {
    pub fn new(tasks: Vec<TaskInfo>, settings: WtSettings) -> Arc<Self> {
        Arc::new(Self {
            tasks: Mutex::new(tasks),
            settings: Mutex::new(settings),
            short: false.into(),
            projects: Mutex::new(Vec::new()),
            brought: Mutex::new(Vec::new()),
            extras: Mutex::new(Vec::new()),
        })
    }
}

impl Port for MemPort {
    fn tasks(&self) -> BoxFuture<'static, Vec<TaskInfo>> {
        let v = self.tasks.lock().map(|t| t.clone()).unwrap_or_default();
        Box::pin(async move { v })
    }
    fn extra_in_use(&self, path: String) -> BoxFuture<'static, bool> {
        let extras = self.extras.lock().map(|v| v.clone()).unwrap_or_default();
        // as RuntimePort compares: as the disk sees both
        Box::pin(async move {
            for d in &extras {
                if crate::fsx::within_real(d, &path).await {
                    return true;
                }
            }
            false
        })
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
    fn projects(&self) -> BoxFuture<'static, Vec<(String, String)>> {
        let v = self.projects.lock().map(|p| p.clone()).unwrap_or_default();
        Box::pin(async move { v })
    }
    fn bring_in(&self, item: wisp_worktrees_api::OfferItem, root: String) -> BoxFuture<'static, Option<String>> {
        let id = self.brought.lock().ok().map(|mut b| {
            b.push((item.path.clone(), root));
            format!("brought-{}", b.len())
        });
        Box::pin(async move { id })
    }
}
