//! wisp.later pure logic (follow-ups and reminders scheduled on tasks, For later, /after plans).
//! Sans-IO: time comes in as `now` (ms since the epoch); the host owns ids, rows, the runtime and the clock.
//!
//! - [`time`]: when an entry goes (`at` / `in`), ISO times, and how wisp writes a time on a reminder.
//! - [`rules`]: what may be scheduled, edited, parked and cancelled, and the texts the agent reads.
//! - [`decide`]: the scheduler's decisions: which due entries go, wait for the plan, lapse or are
//!   missed; which plans start or wait in Drafts; what an early reset pulls forward; the next wake.

pub mod decide;
pub mod rules;
pub mod time;

pub use decide::{Action, Decision, PlanAction, PlanDecision, Task, TaskState, due, due_plans, next_at, pull_forward};
pub use rules::TaskMeta;

/// One error enum for the crate; the host maps it to the wire (`WireError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LaterError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
}

pub(crate) fn bad(m: impl Into<String>) -> LaterError {
    LaterError::Invalid(m.into())
}

pub type Result<T, E = LaterError> = std::result::Result<T, E>;
