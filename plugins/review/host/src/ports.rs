//! Everything review reads and writes, as one port: the kernel-backed implementation (lib.rs) goes
//! through runtime's commands, git.service and review's own points; tests use a fake.

use serde_json::Value;
use wisp_git_api::FileDiff;
use wisp_kernel::{BoxFuture, Call, Result};
use wisp_review_api::{Pick, Review, ReviewFinished, TestsRun};
use wisp_review_core::Agent;

pub type Fut<T> = BoxFuture<'static, T>;

/// A task as review sees it (v1's `s.pr`, `s.worktree`, `s.goal`, `s.review`), read from the session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // facts about the task review reads
pub struct Task {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub is_child: bool,
    /// a turn is running
    pub live: bool,
    /// Ship it is under way
    pub shipping: bool,
    pub pr_open: bool,
    pub pr_head: String,
    /// the worktree folder, "" without one
    pub dir: String,
    pub cwd: String,
    pub base_ref: String,
    pub goal: String,
    pub review: Option<Review>,
}

/// What a session's ext slots hold, v1 shapes: `wisp.ship` → `{pr: {state, head}, shipping}`,
/// `wisp.worktrees` → `{path, baseRef}`, `wisp.goal` → `{text}`, `wisp.review` → the review.
pub fn task_of(s: &wisp_runtime_api::model::Session) -> Task {
    let ship = s.ext_of(wisp_review_api::SHIP_EXT);
    let pr = &ship["pr"];
    let wt = s.ext_of(wisp_review_api::WORKTREES_EXT);
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    Task {
        id: s.id.as_str().to_owned(),
        title: s.title.clone(),
        agent: s.agent.clone(),
        is_child: s.parent_id.is_some(),
        live: s.state == wisp_runtime_api::model::SessionState::Running,
        shipping: ship["shipping"].as_bool().unwrap_or(false) || ship["shipping"].is_object(),
        pr_open: pr["state"] == "OPEN",
        pr_head: text(&pr["head"]),
        dir: text(&wt["path"]),
        cwd: s.cwd.clone(),
        base_ref: text(&wt["baseRef"]),
        goal: text(&s.ext_of(wisp_review_api::GOAL_EXT)["text"]),
        review: serde_json::from_value(s.ext_of(wisp_review_api::EXT).clone()).ok(),
    }
}

pub trait Env: Send + Sync + 'static {
    fn task(&self, call: &Call, id: &str) -> Fut<Result<Task>>;
    /// The harnesses of the task's turns, oldest first, and its first prompt.
    fn turns(&self, call: &Call, id: &str) -> Fut<(Vec<String>, String)>;
    /// `defaults.review`: off | other | a harness
    fn setting(&self, call: &Call) -> Fut<String>;
    fn agents(&self, call: &Call) -> Fut<Vec<Agent>>;
    /// Some(why): the reviewer's own account is past Automations' stop at
    fn hold(&self, call: &Call, agent: &str) -> Fut<Option<String>>;
    fn constraints(&self, call: &Call, id: &str) -> Fut<Vec<String>>;
    /// HEAD of the folder, None when git can't tell
    fn head(&self, call: &Call, dir: &str) -> Fut<Option<String>>;
    /// the work since the merge-base with `base`: None when git answered nothing
    fn changes(
        &self,
        call: &Call,
        dir: &str,
        base: &str,
    ) -> Fut<Option<(Vec<FileDiff>, Vec<String>)>>;
    fn tests(&self, call: &Call, dir: &str, cwd: &str) -> Fut<Option<TestsRun>>;
    /// the reviewer's JSON answer, None when it gave none
    fn ask(
        &self,
        call: &Call,
        prompt: String,
        cwd: &str,
        pick: &Pick,
        timeout_ms: u64,
    ) -> Fut<Option<Value>>;
    /// writes the task's review slot (None clears it); marks it unread when `unread`
    fn save(&self, call: &Call, id: &str, review: Option<&Review>, unread: bool)
    -> Fut<Result<()>>;
    fn finished(&self, call: &Call, e: &ReviewFinished);
    fn now(&self) -> i64;
}
