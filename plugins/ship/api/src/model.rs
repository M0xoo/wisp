//! The rows wisp.ship owns and the PR shapes the UI reads. Field for field v1's JSON (server/git.js
//! prSummary/prDetailOf, server/services/ship.js), camelCase, so the v1 routes stay thin adapters and v1
//! clients keep reading them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A PR's checks, counted: SUCCESS/NEUTRAL/SKIPPED pass, FAILURE/ERROR/… fail, the rest pending.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Checks {
    pub pass: u32,
    pub fail: u32,
    pub pending: u32,
}

/// What a card keeps of a PR (`session.pr`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct PrSummary {
    pub number: u64,
    pub url: String,
    pub title: String,
    /// OPEN | CLOSED | MERGED
    pub state: String,
    pub draft: bool,
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
    pub review: String,
    pub merge_state: String,
    /// GitHub can't merge it into its base (UNKNOWN while it computes is not a conflict)
    pub conflict: bool,
    /// the head commit GitHub has (`--match-head-commit` merges exactly this)
    pub head: String,
    pub branch: String,
    pub base: String,
    pub merged_at: Option<String>,
    pub checks: Checks,
    /// ms since the epoch: when wisp last asked GitHub
    pub checked_at: i64,
}

impl PrSummary {
    pub fn is_open(&self) -> bool {
        self.state == "OPEN"
    }
    pub fn is_merged(&self) -> bool {
        self.state == "MERGED"
    }
}

/// One check run or status as the PR panel lists it: failing first, then running, then passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct CheckItem {
    pub name: String,
    pub workflow: String,
    /// fail | pending | pass | skip
    pub state: String,
    pub url: String,
    pub ms: Option<i64>,
    pub started_at: Option<i64>,
}

/// A comment, or a review with words, in the order they were said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Note {
    /// comment | review
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<String>,
    pub author: String,
    pub bot: bool,
    pub body: String,
    pub at: Option<i64>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct ThreadNote {
    pub author: String,
    pub bot: bool,
    pub body: String,
    pub at: Option<i64>,
    pub url: String,
}

/// Inline review comments on one line. `outdated`: the line it was on has changed since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Thread {
    pub path: String,
    pub line: Option<i64>,
    pub outdated: bool,
    pub notes: Vec<ThreadNote>,
}

/// Where a reviewer stands now: their latest approval or change request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Reviewer {
    pub author: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct PrFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// What the PR panel has beyond the summary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct PrMore {
    pub author: String,
    pub body: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    /// the first 300
    pub files: Vec<PrFile>,
    pub check_list: Vec<CheckItem>,
    pub reviewers: Vec<Reviewer>,
    pub notes: Vec<Note>,
    pub threads: Vec<Thread>,
    pub updated_at: Option<i64>,
}

/// One PR in full for the panel (v1 prDetailOf without its `summary` copy, which stays on the server).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct PrDetail {
    #[serde(flatten)]
    pub pr: PrSummary,
    #[serde(flatten)]
    pub more: PrMore,
}

/// A PR panel entry (GET /sessions/:id/prs): the PR in full, or what the card knew and why gh couldn't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct PrPanel {
    pub repo: String,
    #[serde(flatten)]
    pub pr: PrSummary,
    #[serde(flatten)]
    #[ts(optional)]
    pub more: Option<PrMore>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// A worktree as ship reads it (wisp.worktrees owns the record; ship gets a copy with each task).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct Worktree {
    pub path: String,
    /// the main checkout
    pub root: String,
    pub branch: String,
    /// the base branch name (`main`)
    pub base: String,
    /// what it branched from (`origin/main`, or a sha)
    pub base_ref: String,
    pub remote: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    /// brought in, or under ~/conductor: never ours to remove (edge case Git 7)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub foreign: bool,
}

/// Whether there is something to ship: uncommitted paths, commits past the base, commits not on the
/// PR. `repos`: in a task across several repos, how many have something.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct ToShip {
    pub dirty: u32,
    pub ahead: u32,
    pub unpushed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repos: Option<u32>,
}

/// A worktree's status for Ship it (v1 worktreeStatus).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct RepoStatus {
    pub exists: bool,
    pub dirty: u32,
    pub ahead: u32,
    pub unpushed: u32,
}

/// The stage a ship is at, sent with each summary so the card follows along.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct Shipping {
    /// start | commit | push | pr
    pub step: String,
    /// every PR it ships to is already open
    pub update: bool,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub of: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub at: Option<u32>,
}

/// A conflict fix: the task was asked to merge the base in. step: fixing | pushing | done | failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct ConflictFix {
    pub step: String,
    /// the PR head it was started for: the poll never retries the same head
    pub head: String,
    pub tries: u32,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
}

/// One repo a task ships: its own worktree first, then its other folders' (`also`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct ShipRepo {
    pub name: String,
    pub worktree: Worktree,
    pub pr: Option<PrSummary>,
}

/// A PR the agent attached to its task (wisp_pr) that isn't its own branch's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct AttachedPr {
    pub repo: String,
    pub pr: PrSummary,
}

/// wisp.ship's slot of a task: what it ships, the PRs it follows, and where a ship stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "ship/")]
pub struct ShipTask {
    pub session: String,
    /// the folder the task was launched in: where gh runs for an attached PR once the worktree is gone
    #[serde(default)]
    pub cwd: String,
    pub repos: Vec<ShipRepo>,
    #[serde(default)]
    pub prs: Vec<AttachedPr>,
    #[serde(default)]
    pub to_ship: Option<ToShip>,
    #[serde(default)]
    pub shipping: Option<Shipping>,
    #[serde(default)]
    pub conflict_fix: Option<ConflictFix>,
    /// ms: a PR is polled fast for five minutes after a push
    #[serde(default)]
    pub pushed_at: i64,
    /// a subagent's task: its lead ships
    #[serde(default)]
    pub child: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub updated_at: i64,
}

impl ShipTask {
    /// The task's own PR (its first repo's).
    pub fn pr(&self) -> Option<&PrSummary> {
        self.repos.first().and_then(|r| r.pr.as_ref())
    }
}

/// One PR of a task, as a list names them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct PrRef {
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub state: String,
}

/// The draft commit message and PR text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Draft {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Synced {
    pub ok: bool,
    pub text: String,
}

/// What Merge did: the task's own PR (else the first), the user's checkout synced, every PR.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Merged {
    pub pr: PrSummary,
    pub sync: Synced,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prs: Option<Vec<PrRef>>,
}

/// What Ship it returns: the PR (the task's own, else the first shipped), and every PR in a task
/// across repos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct Shipped {
    #[serde(flatten)]
    pub pr: PrSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prs: Option<Vec<PrRef>>,
}

/// GET /sessions/:id/ship, per repo (the first repo's fields also at the top level).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "ship/")]
pub struct RepoView {
    pub repo: String,
    pub branch: String,
    pub base: String,
    pub remote: Option<String>,
    #[serde(flatten)]
    pub status: RepoStatus,
    pub pr: Option<PrSummary>,
}
