//! wisp.runtime's events: facts, published after the command that caused them commits, in order.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Event;

use crate::model::{Step, Summary, TurnStatus};
use crate::{SessionId, TurnId};

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
event!(TurnFinished = "turn.finished");

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
}
event!(TurnEnded = "turn.ended");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnHeld {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub by: String,
    pub kind: String,
}
event!(TurnHeld = "turn.held");

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
event!(SessionAsked = "session.asked");
