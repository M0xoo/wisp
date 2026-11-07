//! wisp.later's events: facts, published after the command that caused them commits.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Event;

use crate::model::{LaterView, PlanKind};

macro_rules! event {
    ($name:ident = $ty:literal) => {
        impl Event for $name {
            const TYPE: &'static str = $ty;
        }
    };
}

/// A follow-up or reminder was scheduled (v1 telemetry `resume_later` for an agent's own).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Added {
    pub session_id: String,
    pub entry: LaterView,
}
event!(Added = "later.added");

/// A follow-up went into its task, or a reminder came due.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Fired {
    pub session_id: String,
    pub entry_id: String,
    pub by: String,
    pub remind: bool,
}
event!(Fired = "later.fired");

/// An entry wisp scheduled went without being sent: `cancelled` by the user, or the task was marked
/// `done`. wisp.goal hears it for a round that waited for the plan (the goal waits for the user now).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Dropped {
    pub session_id: String,
    pub entry: LaterView,
    pub why: String,
}
event!(Dropped = "later.dropped");

/// A goal round that waited for the plan came due (or the user pressed Send now). wisp.later doesn't
/// send it: the goal does, or lets it lapse when it was dropped or resumed meanwhile (v1 goal.carryOn).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct GoalRoundDue {
    pub session_id: String,
    pub text: String,
    pub goal: u32,
}
event!(GoalRoundDue = "later.goalRoundDue");

/// A plan started: a task launched, or a reminder became a task of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct PlanStarted {
    pub plan_id: String,
    pub session_id: String,
    pub kind: PlanKind,
}
event!(PlanStarted = "later.planStarted");
