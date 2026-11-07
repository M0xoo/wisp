//! wisp-ship-api: wisp.ship's contract. Ship it commits what a worktree task left, pushes its branch
//! and opens (or updates) its PR; then it follows the PR (checks, reviews, conflicts) and squash-merges
//! the exact head that was reviewed. It runs git only through `git.service@^1` and gh through the
//! kernel's proc service. Commands are its whole surface: the v1 routes are thin adapters over them.

pub mod model;

use serde::{Deserialize, Serialize};
use wisp_kernel::{Command, Event};

pub use model::*;

/// The plugin id.
pub const PLUGIN: &str = "wisp.ship";

/// Starts tracking a task's repos (called when a worktree task is made, and by the importer).
#[derive(Debug)]
pub struct Track;
impl Command for Track {
    const ID: &'static str = "ship.track";
    type Args = ShipTask;
    type Out = ();
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionArgs {
    pub session: String,
}

/// What would ship: each repo's branch and status, and the draft message.
#[derive(Debug)]
pub struct View;
impl Command for View {
    const ID: &'static str = "ship.view";
    const READ_ONLY: bool = true;
    type Args = ViewArgs;
    type Out = serde_json::Value;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewArgs {
    pub session: String,
    /// from the task's latest presentation (runtime renders it): the default title and body
    #[serde(default)]
    pub draft: Draft,
}

/// Commit, push, open or update the PR in each repo with something new.
#[derive(Debug)]
pub struct ShipIt;
impl Command for ShipIt {
    const ID: &'static str = "ship.ship";
    type Args = ShipArgs;
    type Out = Shipped;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShipArgs {
    pub session: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub draft: bool,
}

/// Refreshes the task's PRs from GitHub (POST /sessions/:id/pr).
#[derive(Debug)]
pub struct Refresh;
impl Command for Refresh {
    const ID: &'static str = "ship.refresh";
    type Args = SessionArgs;
    type Out = Option<PrSummary>;
}

/// Every PR of the task in full, its own first (GET /sessions/:id/prs).
#[derive(Debug)]
pub struct Details;
impl Command for Details {
    const ID: &'static str = "ship.details";
    const READ_ONLY: bool = true;
    type Args = SessionArgs;
    type Out = Vec<PrPanel>;
}

/// Squash-merges each open PR of the task, syncs the user's base, cleans up wisp's worktrees.
#[derive(Debug)]
pub struct Merge;
impl Command for Merge {
    const ID: &'static str = "ship.merge";
    type Args = SessionArgs;
    type Out = Merged;
}

/// wisp_pr: attach (or detach) a PR by URL or number.
#[derive(Debug)]
pub struct Attach;
impl Command for Attach {
    const ID: &'static str = "ship.attach";
    type Args = AttachArgs;
    type Out = Attached;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachArgs {
    pub session: String,
    pub pr: String,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attached {
    #[serde(flatten)]
    pub pr: PrSummary,
    /// it is the PR of the task's own branch: Ship it pushes to it
    #[serde(default)]
    pub own: bool,
    /// what the agent is told
    pub text: String,
}

/// Fix conflicts: send the task a follow-up to merge its base in (the PR row's button, or Auto-fix).
#[derive(Debug)]
pub struct FixConflicts;
impl Command for FixConflicts {
    const ID: &'static str = "ship.fix_conflicts";
    type Args = SessionArgs;
    type Out = ConflictFix;
}

/// Recheck what the task has to ship (a turn ended, a card opened).
#[derive(Debug)]
pub struct Recheck;
impl Command for Recheck {
    const ID: &'static str = "ship.recheck";
    type Args = RecheckArgs;
    type Out = Option<ToShip>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecheckArgs {
    pub session: String,
    /// a card fetching its session: skipped while it runs, at most every 5 s
    #[serde(default)]
    pub lazy: bool,
}

/// A failing GitHub Actions job's log, its last 80 lines ("" for anything else).
#[derive(Debug)]
pub struct CheckLog;
impl Command for CheckLog {
    const ID: &'static str = "ship.check_log";
    const READ_ONLY: bool = true;
    type Args = CheckLogArgs;
    type Out = String;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckLogArgs {
    pub session: String,
    pub url: String,
}

// ---------- events ----------

/// A ship moved to its next stage (the card follows it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShipStep {
    pub session: String,
    /// None: the ship ended
    pub shipping: Option<Shipping>,
}
impl Event for ShipStep {
    const TYPE: &'static str = "ship.step";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrOpened {
    pub session: String,
    pub repo: String,
    pub pr: PrSummary,
}
impl Event for PrOpened {
    const TYPE: &'static str = "pr.opened";
}

/// A PR changed in a way worth coming back for (state, review, CI settled): the task goes unread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrChanged {
    pub session: String,
    pub pr: PrSummary,
    pub news: bool,
}
impl Event for PrChanged {
    const TYPE: &'static str = "pr.changed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrMerged {
    pub session: String,
    pub prs: Vec<PrRef>,
    pub sync: Synced,
}
impl Event for PrMerged {
    const TYPE: &'static str = "pr.merged";
}

/// The task has a new value for "something to ship".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToShipChanged {
    pub session: String,
    pub to_ship: ToShip,
}
impl Event for ToShipChanged {
    const TYPE: &'static str = "ship.to_ship";
}

/// Ask the runtime to send the task a follow-up (the conflict fix prompt). runtime answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FollowUpWanted {
    pub session: String,
    pub prompt: String,
}
impl Event for FollowUpWanted {
    const TYPE: &'static str = "ship.follow_up";
}
