//! wisp.later's rows and the slices of them other machines read (v1 later.js laterView, session.reminder,
//! session.forLater, turn.later, config.later).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

fn is_false(b: &bool) -> bool {
    !*b
}

/// Automations stop at moved it to the reset (the page says Waits for your plan).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct LaterHeld {
    pub why: String,
    #[ts(type = "number")]
    pub until: i64,
    /// the machine is short, not the plan
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub load: bool,
}

/// The plan a follow-up waits on at a usage limit, so an early reset of that one sends it sooner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct LimitRef {
    pub agent: String,
    pub account: String,
}

/// A follow-up or reminder scheduled on a task. `by`: 'user', 'agent', a crew member's name, or 'wisp'.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct LaterEntry {
    pub id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub at: i64,
    pub text: String,
    pub by: String,
    #[ts(type = "number")]
    pub set_at: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub remind: bool,
    /// the goal round it starts (by 'wisp': a round that waits for the plan)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<LaterHeld>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<LimitRef>,
    /// the runtime's attachments, passed through whole when it goes
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(optional, type = "Array<unknown>")]
    pub attachments: Vec<Value>,
}

impl LaterEntry {
    /// Not the user's own: the plan can hold it back, and Mark done drops it.
    pub fn unattended(&self) -> bool {
        self.by != crate::BY_USER
    }
}

/// What the page and other machines see of a task's follow-ups (v1 laterView).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct LaterView {
    pub id: String,
    #[ts(type = "number")]
    pub at: i64,
    pub text: String,
    pub by: String,
    #[ts(type = "number")]
    pub set_at: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub remind: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub files: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<LaterHeld>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub goal: Option<u32>,
}

impl From<&LaterEntry> for LaterView {
    fn from(l: &LaterEntry) -> Self {
        let files = u32::try_from(l.attachments.len()).ok().filter(|n| *n > 0);
        Self {
            id: l.id.clone(),
            at: l.at,
            text: l.text.clone(),
            by: l.by.clone(),
            set_at: l.set_at,
            remind: l.remind,
            files,
            held: l.held.clone(),
            goal: l.goal,
        }
    }
}

/// A task, named where it is shown: what a plan waits for, where a reminder was set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct TaskRef {
    pub id: String,
    pub title: String,
}

/// A reminder that came due on a task (v1 `session.reminder`). `was`: the state it goes back to on snooze.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Reminder {
    pub text: String,
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number")]
    pub set_at: i64,
    pub by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub was: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub missed: bool,
}

/// Parked to look at again (design/for-later.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct ForLater {
    #[ts(type = "number")]
    pub at: i64,
    pub by: String,
}

/// Who scheduled the follow-up a turn carries and when (v1 `turn.later`): the note the agent reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct SentMeta {
    pub by: String,
    #[ts(type = "number")]
    pub set_at: i64,
    #[ts(type = "number")]
    pub at: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub late: bool,
}

/// The task a plan started (v1 `session.origin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Origin {
    /// always "later"
    pub kind: String,
    pub id: String,
    /// "Scheduled", "Draft" or "After <title>"
    pub name: String,
}

/// `session.ext["wisp.later"]`, written only by wisp.later.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct LaterExt {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<LaterView>>", optional)]
    pub later: Vec<LaterView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub for_later: Option<ForLater>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reminder: Option<Reminder>,
    /// "reminder": a reminder of its own, a finished task with no agent to talk to
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<Origin>,
    /// the follow-up being sent now; moved onto the turn it starts (`turn.ext["wisp.later"]`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sent: Option<SentMeta>,
}

impl LaterExt {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "later/")]
pub enum PlanKind {
    Task,
    Reminder,
}

/// Why a plan that waited for a task waits in Drafts now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "later/")]
pub struct Lost {
    pub id: String,
    pub title: String,
    /// "deleted" or "archived"
    pub why: String,
}

/// A task or a reminder that doesn't exist yet (v1 `config.later`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "later/")]
pub struct Plan {
    pub id: String,
    pub kind: PlanKind,
    #[ts(type = "number")]
    pub set_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub at: Option<i64>,
    /// `/draft`: no time, waits in Drafts until you start it
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub draft: bool,
    /// `/after`: starts once that task is done
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lost: Option<Lost>,
    /// the launch body (runtime `StartArgs`, v1's launch body) a task plan keeps
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub body: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<TaskRef>,
}

impl Plan {
    /// Plans with no time (drafts, /after) sort after the timed ones, oldest first.
    pub fn sort_key(&self) -> (i64, i64) {
        (self.at.unwrap_or(i64::MAX), self.set_at)
    }
}
