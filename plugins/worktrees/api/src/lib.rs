//! wisp-worktrees-api: wisp.worktrees's contract. Each session may get its own checkout and branch
//! (`Worktree`, kept in runtime's `ext["wisp.worktrees"]`); the plugin prepares it (ignored files, the
//! repo's setup), brings it back after a cleanup, removes it only when nothing would be lost, sweeps old
//! ones every hour, asks on Done, and holds a turn (`before:run`) until the repo's own programs are
//! trusted. Git itself is `git.service@1`; this plugin never runs git directly.

pub mod model;

use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Command, Event, Point};

pub use model::*;

/// The session ext slot this plugin owns.
pub const EXT: &str = "wisp.worktrees";

// ---------- commands ----------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    pub session_id: String,
    /// where the task was launched (a repo, or a subfolder of one)
    pub cwd: String,
    pub title: String,
    /// the task's permission mode (`auto` runs an untrusted setup at once)
    #[serde(default)]
    pub mode: String,
}

/// A fresh worktree and branch for a session; None outside a repo with commits.
#[derive(Debug)]
pub struct Create;
impl Command for Create {
    const ID: &'static str = "worktrees.create";
    type Args = CreateArgs;
    type Out = Option<Worktree>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeArgs {
    pub worktree: Worktree,
}

/// Brings a removed (cleaned-up) worktree back from its branch, waiting for a removal under way.
#[derive(Debug)]
pub struct Ensure;
impl Command for Ensure {
    const ID: &'static str = "worktrees.ensure";
    type Args = WorktreeArgs;
    type Out = ();
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveArgs {
    pub worktree: Worktree,
    #[serde(default)]
    pub opts: RemoveOpts,
}

#[derive(Debug)]
pub struct Remove;
impl Command for Remove {
    const ID: &'static str = "worktrees.remove";
    type Args = RemoveArgs;
    type Out = Removed;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusArgs {
    pub worktree: Worktree,
    /// the head commit of the branch's merged PR: only commits after it are unpushed (edge case Git 6)
    #[serde(default)]
    pub merged: Option<String>,
}

#[derive(Debug)]
pub struct Status;
impl Command for Status {
    const ID: &'static str = "worktrees.status";
    const READ_ONLY: bool = true;
    type Args = StatusArgs;
    type Out = WorktreeStatus;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Empty {}

/// Settings → Worktrees (GET /api/worktrees).
#[derive(Debug)]
pub struct View;
impl Command for View {
    const ID: &'static str = "worktrees.view";
    const READ_ONLY: bool = true;
    type Args = Empty;
    type Out = WorktreesView;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanArgs {
    /// None: every idle one
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    #[serde(default)]
    pub leftovers: Vec<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanOut {
    pub queued: u32,
    pub skipped: Vec<String>,
}

/// Clean up by hand (POST /api/worktrees/clean): runs in the background, `View` shows `cleaning`.
#[derive(Debug)]
pub struct Clean;
impl Command for Clean {
    const ID: &'static str = "worktrees.clean";
    type Args = CleanArgs;
    type Out = CleanOut;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SweepOut {
    pub removed: u32,
    /// "busy" while the machine is short
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

#[derive(Debug)]
pub struct Sweep;
impl Command for Sweep {
    const ID: &'static str = "worktrees.sweep";
    type Args = Empty;
    type Out = SweepOut;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneArgs {
    pub session_id: String,
    #[serde(default = "yes")]
    pub sizes: bool,
}

const fn yes() -> bool {
    true
}

#[derive(Debug)]
pub struct DoneFolders;
impl Command for DoneFolders {
    const ID: &'static str = "worktrees.done.list";
    const READ_ONLY: bool = true;
    type Args = DoneArgs;
    type Out = DoneList;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneApplyArgs {
    pub session_id: String,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub force: Vec<String>,
    #[serde(default)]
    pub keep: Vec<String>,
}

#[derive(Debug)]
pub struct DoneApply;
impl Command for DoneApply {
    const ID: &'static str = "worktrees.done.apply";
    type Args = DoneApplyArgs;
    type Out = DoneApplyOut;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyArgs {
    pub session_id: String,
}

/// Done with nobody to ask (a phone tap, a channel, Ship it, a crew job ending): removes only what's
/// clean and fully on its branch with no open PR. The paths removed.
#[derive(Debug)]
pub struct DoneTidy;
impl Command for DoneTidy {
    const ID: &'static str = "worktrees.done.tidy";
    type Args = TidyArgs;
    type Out = Vec<String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustArgs {
    pub key: String,
    pub ids: Vec<String>,
    /// a new worktree whose setup was held: it runs now (Trust and start)
    #[serde(default)]
    pub worktree: Option<Worktree>,
}

/// Trust and start: remembers the items per repo (its main checkout), then runs a held setup.
#[derive(Debug)]
pub struct Trust;
impl Command for Trust {
    const ID: &'static str = "worktrees.trust";
    type Args = TrustArgs;
    type Out = Option<Prepared>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingArgs {
    pub dir: String,
    pub agent: String,
    #[serde(default)]
    pub extra: Vec<TrustItem>,
}

/// What a run of `agent` in `dir` would run that isn't trusted (the card), or None.
#[derive(Debug)]
pub struct TrustPending;
impl Command for TrustPending {
    const ID: &'static str = "worktrees.trust.pending";
    const READ_ONLY: bool = true;
    type Args = PendingArgs;
    type Out = Option<Pending>;
}

// ---------- events ----------

/// A new folder: sizes are stale, and past the cap a sweep comes a few minutes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeAdded {
    pub root: String,
    pub path: String,
    pub session_id: Option<String>,
}
impl Event for WorktreeAdded {
    const TYPE: &'static str = "worktree.added";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeRemoved {
    pub root: String,
    pub path: String,
    pub branch_deleted: bool,
}
impl Event for WorktreeRemoved {
    const TYPE: &'static str = "worktree.removed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreesCleaned(pub CleanedRecord);
impl Event for WorktreesCleaned {
    const TYPE: &'static str = "worktrees.cleaned";
}

// ---------- the setup-source point ----------

/// A repo's scripts as one source reads them (`.conductor/settings.toml` is contributed by the plugin
/// that reads Conductor's files). `problem`: a file it can't read for sure, which refuses all of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceScripts {
    pub file: String,
    pub setup: Option<String>,
    pub run: Option<RunScript>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunScript {
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupEnvCtx {
    pub root: String,
    pub dir: String,
    pub branch: String,
}

/// Another tool's worktree config, after wisp's own `.wisp/worktree.json` and Cursor's
/// `.cursor/worktrees.json`, in contribution order.
pub trait SetupSource: Send + Sync + 'static {
    /// None: the repo isn't set up for this tool
    fn read(&self, root: &str) -> BoxFuture<'static, Option<SourceScripts>>;
    /// what its setup is told besides `ROOT_WORKTREE_PATH`
    fn env(&self, ctx: &SetupEnvCtx) -> Vec<(String, String)>;
    /// a path that looks like this tool's own worktrees: never wisp's to remove (`isForeign`)
    fn owns(&self, path: &str) -> bool;
}

pub const SETUP_SOURCES: Point<dyn SetupSource> = Point::new("worktrees.setup", 1);
