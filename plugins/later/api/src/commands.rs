//! wisp.later's commands. Each id is also its permission (`later.add` → `later:add`). Bodies are v1's
//! (routes/sessions.js `/sessions/:id/later`, routes/automations.js `/later`, routes/internal.js
//! `/internal/later`) plus the task id, so the HTTP adapters stay thin.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Command;

use crate::model::{ForLater, LaterEntry, LaterHeld, LimitRef, Plan, PlanKind};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

/// When: `at` (ms since the epoch, or an ISO time) or `in` (minutes from now).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct When {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | string")]
    pub at: Option<Value>,
    #[serde(rename = "in", default, skip_serializing_if = "Option::is_none")]
    #[ts(rename = "in", optional, type = "number | string")]
    pub in_min: Option<Value>,
}

impl When {
    /// A time was given (an edit without one keeps the time it had).
    pub fn given(&self) -> bool {
        self.at.as_ref().is_some_and(|v| !v.is_null())
            || self.in_min.as_ref().is_some_and(|v| !v.is_null())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct SessionArgs {
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct IdArgs {
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Empty {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Okay {
    pub ok: bool,
}

/// `later.add`: a follow-up (or, with `remind`, a reminder) on a task. `by` defaults to 'user'.
/// `goal` and `limit` are kept only for `by: 'wisp'` (a goal round, the carry-on at a limit).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct AddArgs {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub when: When,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub remind: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<LaterHeld>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<LimitRef>,
}

/// `later.edit`: another time or text; `now: true` sends it now (Send now); item `reminder` snoozes
/// the reminder that came due.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct EditArgs {
    pub session_id: String,
    pub item: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub when: When,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub now: bool,
}

/// What an edit came to: the entry, a reminder snoozed back into a plan, or what sending it did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "later/")]
pub enum Edited {
    Entry(LaterEntry),
    Plan(Plan),
    Sent(#[ts(type = "Record<string, unknown>")] Value),
}

/// `later.cancel`: `goal_round` takes back the goal round waiting on the task (wisp.goal's own).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct CancelArgs {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub goal_round: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Cancelled {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub entry: Option<LaterEntry>,
}

/// `later.park` (For later, v1 PATCH /sessions/:id): `forLater` true or the time it was saved (Undo)
/// parks it, false unparks it; a `state` (Mark done, Reopen) or Archive takes it out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct ParkArgs {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "boolean | number")]
    pub for_later: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Parked {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub for_later: Option<ForLater>,
}

/// `later.plan`: `{kind: task, body}` or `{kind: reminder, text, from?}`; a task may have `draft` or
/// `after` (a task id, or `{id}`) instead of a time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct PlanArgs {
    pub kind: PlanKind,
    #[serde(flatten)]
    #[ts(flatten)]
    pub when: When,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string | { id: string }")]
    pub after: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub body: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "{ id: string, title?: string }")]
    pub from: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct EditPlanArgs {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub when: When,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub now: bool,
}

/// The task a plan started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Started {
    pub session: StartedRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct StartedRef {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "later/")]
pub enum PlanEdited {
    Started(Started),
    Plan(Box<Plan>),
}

/// `later.waitAtLimit` (v1 runner.waitAtLimit): at a usage limit with Settings → Wait for the reset on
/// (the caller checks the setting), the task carries on once the window resets. `agent`: the harness of
/// the run that hit it. `None` back: it asks the user (the limit card), as before.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct WaitAtLimitArgs {
    pub session_id: String,
    #[ts(type = "number")]
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct NextAt {
    #[ts(type = "number | null")]
    pub at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Ticked {
    pub fired: u32,
}

/// `later.agent.schedule`: the `resume_later` MCP tool (v1 POST /internal/later).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct ScheduleArgs {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub minutes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cancel: Option<String>,
}

/// What the agent reads back: `text`, or `error` (the route maps it to 400/403/404 as v1 did).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct ScheduleOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

command!(Add = "later.add": AddArgs => LaterEntry);
command!(Edit = "later.edit": EditArgs => Edited);
command!(Cancel = "later.cancel": CancelArgs => Cancelled);
command!(
    /// Mark done: the agent's and wisp's wake-ups go, the user's stay.
    Done = "later.done": SessionArgs => Empty
);
command!(Park = "later.park": ParkArgs => Parked);
command!(List = "later.list": SessionArgs => Vec<LaterEntry>, read_only);
command!(Plans = "later.plans": Empty => Vec<Plan>, read_only);
command!(MakePlan = "later.plan": PlanArgs => Plan);
command!(GetPlan = "later.getPlan": IdArgs => Plan, read_only);
command!(EditPlan = "later.editPlan": EditPlanArgs => PlanEdited);
command!(CancelPlan = "later.cancelPlan": IdArgs => Okay);
command!(WaitAtLimit = "later.waitAtLimit": WaitAtLimitArgs => Option<LaterEntry>);
command!(NextAtOf = "later.nextAt": Empty => NextAt, read_only);
command!(Tick = "later.tick": Empty => Ticked);
command!(AgentSchedule = "later.agent.schedule": ScheduleArgs => ScheduleOut);

/// The user's IANA time zone (the client's, sent with settings): what times are written in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct ZoneArgs {
    pub zone: String,
}

command!(Zone = "later.zone": ZoneArgs => ZoneArgs);
