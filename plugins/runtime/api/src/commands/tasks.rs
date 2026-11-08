//! Arguments and answers of the task, queue and read commands.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::model::{Attachment, Ext, Mode, QueueItem, SessionState, Step};
use crate::{SessionId, TurnId};

/// `{}`: a command that answers nothing but success.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Ack {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct IdArgs {
    pub id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
}

/// Which harness, model and effort a run uses (each one left out keeps the task's).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct RunPick {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
}

/// `runtime.create`: creates a task and starts its first turn. `agent: "auto"` lets wisp.router pick.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct StartArgs {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub dirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Attachment>>", optional)]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
    /// start it held in the queue rather than running it now (a scheduled task)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub hold: bool,
    /// namespaced extras the caller's plugin stores on the new task (`ext[callerPluginId]`)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(as = "Option<Ext>", optional)]
    pub ext: Ext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Created {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct FollowUpArgs {
    pub id: SessionId,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Attachment>>", optional)]
    pub attachments: Vec<Attachment>,
    /// true (the default): wait in the queue if a turn is running; false: interrupt and send now
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run: Option<RunPick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
}

/// Where a follow-up went: a new turn, or a place in the queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct FollowedUp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queued: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct RenameArgs {
    pub id: SessionId,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ArchiveArgs {
    pub id: SessionId,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct MarkReadArgs {
    pub id: SessionId,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetStateArgs {
    pub id: SessionId,
    pub state: SessionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct StopArgs {
    pub id: SessionId,
    /// v1 `{ queue: 'hold' }` is the default: a Stop never discards queued follow-ups, it holds them
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub clear_queue: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct QueueEditArgs {
    pub id: SessionId,
    /// the queue in this order, with your edited texts. Items left out keep their place at the end (one
    /// queued meanwhile is never lost); unknown ids are skipped; wisp's own items keep their text.
    pub items: Vec<QueueItem>,
    /// items to take out of the queue
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub remove: Vec<String>,
    /// set or clear the queue's hold (v1 `PATCH /queue { held }`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct QueueItemArgs {
    pub id: SessionId,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct QueueTextArgs {
    pub id: SessionId,
    pub item_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct QueueMergeArgs {
    pub id: SessionId,
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum ReleaseAction {
    Start,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ReleaseArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    pub action: ReleaseAction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ListArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TurnsArgs {
    pub id: SessionId,
    /// turns with idx below this one (paging back through a long task)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ActivityArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    /// only events after this per-session seq (resume a stream)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub since_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ActivityPage {
    /// the last seq returned (pass it back as `sinceSeq`)
    pub seq: u64,
    pub items: Vec<Step>,
}

/// A plugin writes its own ext slot only: the kernel's caller says which plugin speaks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetExtArgs {
    pub id: SessionId,
    pub plugin: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnExtArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    pub plugin: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AnswerArgs {
    pub id: SessionId,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct AskArgs {
    pub id: SessionId,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Asked {
    pub ask_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct PollAnswerArgs {
    pub ask_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum PollAnswer {
    Answered { answer: String },
    Pending,
    Cancelled,
}
