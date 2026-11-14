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

// ---------- the Settings → Worktrees pane's own writes ----------

/// Keep (pin) a task's worktree, or stop keeping it (v1 PATCH /sessions/:id { keepWorktree }).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeepArgs {
    pub id: String,
    pub keep: bool,
}

#[derive(Debug)]
pub struct Keep;
impl Command for Keep {
    const ID: &'static str = "worktrees.keep";
    type Args = KeepArgs;
    type Out = ();
}

/// Bring in worktrees another tool left in a project (v1 POST /projects/:id/foreign-worktrees): each path
/// becomes a task in that folder, marked foreign so wisp's cleanup never touches it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BringInArgs {
    /// the project's name
    pub project: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BringInOut {
    /// the new tasks' ids
    pub created: Vec<String>,
    /// paths that aren't one of the offer's (gone, or already a task's)
    pub skipped: Vec<String>,
}

#[derive(Debug)]
pub struct BringIn;
impl Command for BringIn {
    const ID: &'static str = "worktrees.bringIn";
    type Args = BringInArgs;
    type Out = BringInOut;
}

/// Not now: the project's offer goes and isn't made again (v1 POST …/foreign-worktrees/dismiss).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DismissArgs {
    pub project: String,
}

#[derive(Debug)]
pub struct Dismiss;
impl Command for Dismiss {
    const ID: &'static str = "worktrees.dismiss";
    type Args = DismissArgs;
    type Out = ();
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

/// The task's file view (v1 `GET /sessions/:id/source`): one file of the task's folder (its worktree, else its
/// folder) to read and edit. Additive (2026-11-11).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceArgs {
    /// the task
    pub id: String,
    /// relative to the task's folder
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub path: String,
    pub text: String,
    /// what a save sends back, so it refuses a file that changed since
    pub hash: String,
    /// the folder it's in (the gutter's blame asks there)
    pub root: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveArgs {
    pub id: String,
    pub path: String,
    pub text: String,
    /// the hash it was opened with; empty: save whatever is there
    #[serde(default)]
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesArgs {
    /// a task: its folder's files
    #[serde(default)]
    pub id: String,
    /// or a project of yours, by its folder (New task's @ before there's a task). Additive (2026-11-11).
    #[serde(default)]
    pub path: String,
}

/// Go to definition (v1 `/sessions/:id/grep?def=`): where a name is declared in the task's folder; or, with `q`,
/// Open file…'s text search (v1 `?q=`): where the words are, in any case (at most 60 hits).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepArgs {
    pub id: String,
    #[serde(default)]
    pub def: String,
    /// the words to find (when `def` is empty). Additive (2026-11-14).
    #[serde(default)]
    pub q: String,
}

#[derive(Debug)]
pub struct Grep;
impl Command for Grep {
    const ID: &'static str = "worktrees.grep";
    const READ_ONLY: bool = true;
    type Args = GrepArgs;
    type Out = Vec<Hit>;
}

/// One place a name is found (`git grep -n`: `path:line:text`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileList {
    pub files: Vec<String>,
    /// how many more there were past the list's end
    pub more: usize,
    /// false: not a git folder (nothing listed)
    pub git: bool,
}

#[derive(Debug)]
pub struct SourceCmd;
impl Command for SourceCmd {
    const ID: &'static str = "worktrees.source";
    const READ_ONLY: bool = true;
    type Args = SourceArgs;
    type Out = Source;
}

#[derive(Debug)]
pub struct Save;
impl Command for Save {
    const ID: &'static str = "worktrees.save";
    type Args = SaveArgs;
    type Out = Saved;
}

/// Fetches a project's remote now, while you type its task in New task (v1 POST /launch/warm), so Send doesn't wait
/// on the network for the worktree's base. Answers at once; the fetch is shared while fresh (60 s). Additive
/// (2026-11-13).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarmArgs {
    /// a project of yours, by its folder
    pub path: String,
}

#[derive(Debug)]
pub struct Warm;
impl Command for Warm {
    const ID: &'static str = "worktrees.warm";
    const READ_ONLY: bool = true;
    type Args = WarmArgs;
    type Out = ();
}

#[derive(Debug)]
pub struct Files;
impl Command for Files {
    const ID: &'static str = "worktrees.files";
    const READ_ONLY: bool = true;
    type Args = FilesArgs;
    type Out = FileList;
}
