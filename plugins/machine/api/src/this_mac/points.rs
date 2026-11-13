//! What This Mac needs from other plugins, as points they contribute to (ADR-0003: the machine plugin
//! imports none of them). Each is read on a 10 s tick at most, so contributions stay cheap and sync
//! where they can.

use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Call, Point, Result};
use wisp_runtime_api::Session;

use super::commands::{Cleaned, FixFiled};
use super::view::ReclaimGroup;

/// `machine.runs@1`: the runs going now, each with the pid of the harness CLI the runner started (the
/// root of its process tree). wisp.runtime contributes it; its subagents and delegates count.
pub const RUNS: Point<dyn LiveRuns> = Point::new("machine.runs", 1);
/// `machine.facts@1`: what other plugins know about a task that This Mac shows or decides on.
pub const FACTS: Point<dyn TaskFacts> = Point::new("machine.facts", 1);
/// `machine.harnessDisk@1`: the harnesses' own folders (v1 server/harness-disk.js).
pub const HARNESS_DISK: Point<dyn HarnessDisk> = Point::new("machine.harnessDisk", 1);
/// `machine.fixer@1`: who takes a File a fix (the crew's Bugsy). Without one, a task in the project.
pub const FIXER: Point<dyn FixFiler> = Point::new("machine.fixer", 1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveRun {
    pub task: String,
    /// 0 while the CLI isn't started yet
    pub pid: u32,
}

/// Called once per tick and once per guard reading: a lock and a copy, no I/O.
pub trait LiveRuns: Send + Sync + 'static {
    fn live(&self) -> Vec<LiveRun>;
}

/// Facts about one task, filled in by each contributor (crew: `crew`, `crew_name`; git: `pr_closed`;
/// worktrees or projects: `project`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// the crew member whose job the task is
    pub crew: Option<String>,
    pub crew_name: Option<String>,
    /// the folder a fix for its leftovers is filed in (its project, else its worktree's root)
    pub project: Option<String>,
    /// its PR, or one of its other PRs, is merged or closed (Clean up's `merged` group)
    pub pr_closed: bool,
}

pub trait TaskFacts: Send + Sync + 'static {
    /// Pure: read the contributor's own ext slot on `session`, no I/O.
    fn facts(&self, session: &Session, out: &mut Facts);
}

pub trait HarnessDisk: Send + Sync + 'static {
    /// The last look, as a reclaim group of kind `harness`, or `None` before the first look.
    fn view(&self) -> Option<ReclaimGroup>;
    /// Removes the crash dumps and stale cwd files of `ids` (none: every harness). `commands`: the
    /// command lines running now, so a cwd file a live process names stays.
    fn clean(&self, ids: Option<Vec<String>>, commands: Vec<String>) -> BoxFuture<'static, Result<Cleaned>>;
}

pub trait FixFiler: Send + Sync + 'static {
    /// Files `prompt` as a job (`job: task`), or `Ok(None)` when it has no one to give it to.
    fn file(&self, call: &Call, prompt: String) -> BoxFuture<'static, Result<Option<FixFiled>>>;
}
