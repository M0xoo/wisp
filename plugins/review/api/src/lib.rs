//! wisp-review-api: review by another harness (`defaults.review`, off by default). When a task's own PR
//! is open and its head is new, a harness other than the one that wrote it (or the one picked) reads the
//! diff against the base and lists what it would fix, and the project's tests run again on that head.
//! The result sits on the task (`ext["wisp.review"]`) and shows on the PR row, in the PR panel and in
//! Merge's confirmation; Merge stays possible either way. It runs on the reviewing harness's current
//! account: wisp never switches accounts for it, and past Automations' stop the review waits (held).
//!
//! Shapes are v1's (server/services/review.js) field for field.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{BoxFuture, Call, Command, Event, Point, Result};

/// Every harness a review may name, in the order `other` tries them.
pub const HARNESSES: &[&str] = &[
    "claude",
    "codex",
    "antigravity",
    "copilot",
    "opencode",
    "cursor",
    "grok",
];
/// What `defaults.review` may be: off, another harness than the author's, or one harness.
pub const REVIEW_VALUES: &[&str] = &[
    "off",
    "other",
    "claude",
    "codex",
    "antigravity",
    "copilot",
    "opencode",
    "cursor",
    "grok",
];
/// The session ext slots review reads (owned by those plugins, v1 shapes `s.pr` and `s.worktree`) and writes.
pub const EXT: &str = "wisp.review";
pub const SHIP_EXT: &str = "wisp.ship";
pub const WORKTREES_EXT: &str = "wisp.worktrees";
pub const GOAL_EXT: &str = "wisp.goal";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct Pick {
    pub agent: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "review/")]
pub enum Severity {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct Finding {
    pub severity: Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<u32>,
    pub text: String,
    /// the number of the user's constraint it breaks (1-based), and that constraint's words
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub constraint: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rule: Option<String>,
}

/// What of the diff the reviewer was given.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "review/")]
pub struct Coverage {
    pub files: u32,
    pub seen: u32,
    pub chars: u64,
    pub seen_chars: u64,
    pub cut: Vec<String>,
    pub missing: Vec<String>,
    /// names past the 50 shown; left out at 0
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub more: Option<u32>,
}

impl Coverage {
    pub fn partial(&self) -> bool {
        self.seen < self.files
    }
}

/// The tests run on the head: 'pass' | 'fail' | 'skip'.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct TestsSummary {
    pub verdict: String,
    pub command: String,
    pub passed: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "review/")]
pub enum Status {
    #[default]
    Running,
    Held,
    Done,
    Failed,
}

/// The review kept on the task, of one head.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct Review {
    pub status: Status,
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<Pick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<String>,
    pub findings: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tests: Option<TestsSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub coverage: Option<Coverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
    pub at: i64,
}

/// What the page sees: the last review, and whether it is of the PR's head (`current`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct ReviewView {
    pub status: Status,
    pub head: String,
    pub current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<Pick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<String>,
    pub findings: Vec<Finding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tests: Option<TestsSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub coverage: Option<Coverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
    pub at: i64,
}

// ---------- commands and events ----------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct MaybeArgs {
    pub id: String,
    /// Review again (or the first, by hand): runs whatever the setting says
    #[serde(default)]
    pub force: bool,
}

/// Why it didn't start; "" when it did (or one is already running for that head).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct Maybe {
    pub why: String,
}

/// `review.maybe`: start a review of the task's PR head when one is due. Ship calls it when a PR's head
/// changes; a turn's end calls it too.
#[derive(Debug)]
pub struct MaybeReview;
impl Command for MaybeReview {
    const ID: &'static str = "review.maybe";
    type Args = MaybeArgs;
    type Out = Maybe;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "review/")]
pub struct ViewArgs {
    pub id: String,
}

/// `review.view`: the task's review as the page sees it, or null.
#[derive(Debug)]
pub struct View;
impl Command for View {
    const ID: &'static str = "review.view";
    const READ_ONLY: bool = true;
    type Args = ViewArgs;
    type Out = Option<ReviewView>;
}

/// A review ended (done or failed): telemetry and notify listen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "review/")]
pub struct ReviewFinished {
    pub session_id: String,
    pub head: String,
    pub status: Status,
    pub reviewer: String,
    pub author: String,
    pub findings: u32,
    pub constraints: u32,
    /// findings that break a constraint
    pub broken: u32,
    pub tests: String,
    pub partial: bool,
}
impl Event for ReviewFinished {
    const TYPE: &'static str = "review.finished";
}

// ---------- points review owns (others contribute) ----------

/// The project's tests, run on a folder: what the check plugin reports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestsRun {
    pub verdict: String,
    pub command: String,
    pub output: String,
    pub passed: u32,
    pub failed: u32,
}

/// `review.tests@1`: runs the project's tests on the PR head's folder (the check plugin). None: no tests.
pub trait TestRunner: Send + Sync + 'static {
    fn run(
        &self,
        call: &Call,
        dir: &str,
        cwd: &str,
    ) -> BoxFuture<'static, Result<Option<TestsRun>>>;
}
pub const TESTS: Point<dyn TestRunner> = Point::new("review.tests", 1);

/// `review.hold@1`: may `agent` run now? Some(why) holds the review (Automations' stop at, on the
/// reviewer's own account). Any contributor holding holds it.
pub trait Hold: Send + Sync + 'static {
    fn check(&self, call: &Call, agent: &str) -> BoxFuture<'static, Option<String>>;
}
pub const HOLD: Point<dyn Hold> = Point::new("review.hold", 1);

/// `review.constraints@1`: what the user ruled out or narrowed in their own messages ("don't touch
/// migrations/"), extracted by the runtime's handoff (v1 handoff.js constraintsOf). First contributor answers.
pub trait Constraints: Send + Sync + 'static {
    fn of(&self, call: &Call, session: &str) -> BoxFuture<'static, Result<Vec<String>>>;
}
pub const CONSTRAINTS: Point<dyn Constraints> = Point::new("review.constraints", 1);
