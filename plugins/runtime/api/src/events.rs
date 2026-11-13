//! wisp.runtime's events: facts, published after the command that caused them commits, in order.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Event;

use crate::model::{Step, Summary, TurnStatus};
use crate::{SessionId, TurnId};

/// A lifecycle fact someone would be upset to miss: kept in the event log (ADR-0044).
macro_rules! durable {
    ($name:ident = $ty:literal, |$e:ident| subject: $subject:expr, key: $key:expr) => {
        impl Event for $name {
            const TYPE: &'static str = $ty;
            const DURABLE: bool = true;
            fn subject(&self) -> Option<String> {
                let $e = self;
                Some($subject)
            }
            fn key(&self) -> Option<String> {
                let $e = self;
                Some($key)
            }
        }
    };
}

macro_rules! event {
    ($name:ident = $ty:literal) => {
        impl Event for $name {
            const TYPE: &'static str = $ty;
        }
    };
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SessionCreated {
    pub session: Summary,
}
event!(SessionCreated = "session.created");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnStarted {
    pub session_id: SessionId,
    pub turn_id: TurnId,
}
event!(TurnStarted = "turn.started");

/// Coalesced: one per commit of the activity buffer (≤ 250 ms), never one per token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnActivity {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub items: Vec<Step>,
}
event!(TurnActivity = "turn.activity");

/// A turn that landed and was not quiet (subscribers notify, record, judge).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnFinished {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub status: TurnStatus,
    pub interrupted: bool,
    pub summary: Summary,
}
durable!(TurnFinished = "turn.finished", |e| subject: e.session_id.0.clone(), key: e.turn_id.0.clone());

/// Every end, quiet ones too (telemetry, budget).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnEnded {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub status: TurnStatus,
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changed_files: Option<u32>,
    pub agent: String,
    pub model: String,
    /// the account the run used (Drain watch counts per account). Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    /// the turn's input and output tokens (cache reads and writes aside), for whoever counts work by tokens. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens: Option<u64>,
    /// the turn's tokens as its stats say, for tokens per turn by account (Settings → Usage): input (the cache aside),
    /// output, the cache (reads and writes: what the turn read besides `input`) and of that the reads alone (what came
    /// from the cache). Additive (2026-11-13).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_read_tokens: Option<u64>,
    /// a task's first turn (else a follow-up): Ask near the limit learns each apart. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub first: bool,
    /// a run inside a task you already said yes to (a subagent's, wisp's own round, a compaction)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub inner: bool,
}
durable!(TurnEnded = "turn.ended", |e| subject: e.session_id.0.clone(), key: e.turn_id.0.clone());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnHeld {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub by: String,
    pub kind: String,
}
durable!(TurnHeld = "turn.held", |e| subject: e.session_id.0.clone(), key: format!("{}:{}", e.turn_id.0, e.kind));

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnLimits {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub limits: Value,
}
event!(TurnLimits = "turn.limits");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SessionChanged {
    pub id: SessionId,
}
event!(SessionChanged = "session.changed");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SessionDeleted {
    pub id: SessionId,
}
event!(SessionDeleted = "session.deleted");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct SessionAsked {
    pub session_id: SessionId,
    pub ask_id: String,
    pub question: String,
}
durable!(SessionAsked = "session.asked", |e| subject: e.session_id.0.clone(), key: e.ask_id.clone());

/// What a `task.*` fact says (ADR-0043): the trigger sources `task.finished`, `task.failed`, `task.held`,
/// `task.asked` and `task.done`, each durable, so a trigger or a crew wake never misses one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TaskFact {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    pub title: String,
    /// its folder (a trigger's `project` matches it)
    pub cwd: String,
    pub agent: String,
    /// the crew member whose job it is
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// done | error | held | asked | marked
    pub status: String,
    /// what it said (its answer's first lines, the question, why it's held)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
}

macro_rules! task_fact {
    ($name:ident = $ty:literal) => {
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub TaskFact);
        impl Event for $name {
            const TYPE: &'static str = $ty;
            const DURABLE: bool = true;
            fn subject(&self) -> Option<String> {
                Some(self.0.session_id.0.clone())
            }
            fn key(&self) -> Option<String> {
                Some(format!(
                    "{}:{}",
                    self.0.session_id.0,
                    self.0.turn_id.as_ref().map_or_else(|| self.0.text.chars().take(40).collect(), |t| t.0.clone())
                ))
            }
        }
    };
}

task_fact!(TaskFinished = "task.finished");
task_fact!(TaskFailed = "task.failed");
task_fact!(TaskHeld = "task.held");
task_fact!(TaskAsked = "task.asked");
task_fact!(TaskDone = "task.done");
