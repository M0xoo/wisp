//! The rows wisp.worktrees owns. Shapes follow v1's JSON field for field (camelCase on the wire), so v1's
//! `worktree` on a session imports 1:1 into runtime's `ext["wisp.worktrees"]` and v1 clients keep reading
//! Settings → Worktrees and the Done dialog. `ts-rs` exports what the UI reads.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A session's own checkout (v1 `session.worktree`): made by wisp under `<home>/worktrees`, or brought in
/// (`foreign`: the user's, in place, never ours to remove, recreate or tidy).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct Worktree {
    pub path: String,
    /// where the agent runs: `path`, or the subfolder the launch came from (edge case Git 5)
    pub cwd: String,
    pub branch: String,
    /// the base branch name (`main`)
    pub base: String,
    /// what it branched from: `origin/main`, or a sha when there's no remote
    pub base_ref: String,
    /// the base's sha when it was made
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub remote: Option<String>,
    /// the main checkout
    pub root: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub foreign: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prepared: Option<Prepared>,
    /// a moved task's snapshot commit (where its work stood)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snap: Option<String>,
}

/// What preparing a new worktree did: ignored files copied, setup steps run, what went wrong, the steps
/// held for project trust, and the bytes cloned copy-on-write.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct Prepared {
    pub copied: Vec<String>,
    pub ran: Vec<String>,
    pub problems: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<Vec<TrustItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cloned: Option<u64>,
}

impl Prepared {
    /// v1 kept `prepared` on the record only when it says something.
    pub fn is_empty(&self) -> bool {
        self.copied.is_empty()
            && self.ran.is_empty()
            && self.problems.is_empty()
            && self.held.is_none()
    }
}

/// v1 worktreeStatus: changed paths, commits past the base, commits not on the remote branch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct WorktreeStatus {
    pub exists: bool,
    pub dirty: u32,
    pub ahead: u32,
    pub unpushed: u32,
}

/// What a branch does when its worktree goes: stays, goes when nothing is only on it, or goes anyway.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub enum BranchMode {
    #[default]
    Keep,
    IfMerged,
    Force,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct RemoveOpts {
    /// drop uncommitted work too
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub branch: BranchMode,
    /// anything only the folder holds (or that git can't tell) keeps it
    #[serde(default)]
    pub strict: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct Removed {
    pub removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dirty: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub foreign: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub branch_deleted: bool,
}

// ---------- Settings → Worktrees ----------

/// Why a task's folder stays, or `idle`: it can go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "worktrees/")]
pub enum Standing {
    Busy,
    Kept,
    Parked,
    Pr,
    Checking,
    Unreadable,
    Dirty,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct ItemRow {
    pub id: String,
    pub title: String,
    pub project: String,
    pub branch: String,
    pub status: Standing,
    pub only: u32,
    pub size: Option<u64>,
    pub used_at: i64,
    pub clean_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct LeftoverRow {
    pub name: String,
    pub size: Option<u64>,
    pub only: Option<u32>,
    pub used_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct Disk {
    pub free: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct Progress {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct CleanedRecord {
    pub at: i64,
    pub count: u32,
    pub freed: u64,
    pub auto: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct WorktreesView {
    /// days, or "off"
    pub cleanup: String,
    /// a count, or "off"
    pub max: String,
    pub items: Vec<ItemRow>,
    pub leftovers: Vec<LeftoverRow>,
    pub size: Option<u64>,
    pub disk: Option<Disk>,
    pub ready: u32,
    pub looking: bool,
    pub cleaning: Option<Progress>,
    pub last: Option<CleanedRecord>,
}

/// One worktree another tool left in a project, as Bring in offers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct OfferItem {
    pub path: String,
    pub branch: String,
    /// the folder's name
    pub name: String,
    /// uncommitted files
    pub dirty: u32,
    /// a Claude Code chat to resume in it
    pub chat: bool,
}

/// A project's worktrees no wisp task knows (v1 bring-in.js): one offer per project, until brought in or
/// dismissed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct Offer {
    /// the project's name (its id)
    pub project: String,
    pub name: String,
    /// the tool that left them: `Conductor`, else `git`
    pub from: String,
    pub items: Vec<OfferItem>,
    /// worktrees with no branch: they can't be brought in
    pub detached: u32,
}

// ---------- Done asks about the worktree ----------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "worktrees/")]
pub enum OnDone {
    #[default]
    Ask,
    Remove,
    Keep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct PrRef {
    pub number: u64,
    pub url: String,
    /// OPEN | CLOSED | MERGED
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct FolderRow {
    pub path: String,
    pub task: String,
    pub title: String,
    pub own: bool,
    pub branch: String,
    pub size: Option<u64>,
    /// lost with the folder: uncommitted paths, plus one when HEAD left the branch; None: git can't tell
    pub only: Option<u32>,
    pub uncommitted: Option<u32>,
    pub unpushed: u32,
    pub pr: Option<PrRef>,
    pub kept: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "worktrees/")]
pub struct DoneList {
    pub folders: Vec<FolderRow>,
    pub on_done: OnDone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct FailedRemoval {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct DoneApplyOut {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    pub failed: Vec<FailedRemoval>,
}

// ---------- project trust ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "worktrees/")]
pub enum TrustKind {
    Hook,
    Command,
    Plugin,
    Mcp,
    Setup,
}

/// One thing a repo would make run. `id` hashes (kind, file, name, command, extra): a new or changed
/// item asks again, one that's gone doesn't matter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct TrustItem {
    pub kind: TrustKind,
    pub file: Option<String>,
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extra: Option<Vec<String>>,
    pub id: String,
}

/// The items not trusted yet in the repo keyed by its main checkout. `changed`: something there was
/// trusted before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "worktrees/")]
pub struct Pending {
    pub key: String,
    pub items: Vec<TrustItem>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
}
