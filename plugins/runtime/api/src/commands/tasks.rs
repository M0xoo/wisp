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

/// `runtime.setMode`: the mode the task's next turns run in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetModeArgs {
    pub id: SessionId,
    pub mode: Mode,
}

/// `runtime.setLean`: this task's runs lean or not ('on' | 'off'), or none to follow `runtime.leanRuns` (v1 PATCH
/// /sessions/:id `lean`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetLeanArgs {
    pub id: SessionId,
    #[serde(default)]
    #[ts(optional)]
    pub lean: Option<String>,
}

/// `runtime.setAgent`: the harness the task's next turns run on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SetAgentArgs {
    pub id: SessionId,
    pub agent: String,
}

/// `runtime.forLater`: saved for later (the list's For later), or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ForLaterArgs {
    pub id: SessionId,
    pub for_later: bool,
    /// when it was saved (Undo puts the old time back); now when unset
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub at: Option<i64>,
}

/// `runtime.queue.order`: the queued follow-ups in this order (ids the queue doesn't have are skipped).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct QueueOrderArgs {
    pub id: SessionId,
    pub order: Vec<String>,
}

/// `runtime.terminal`: open (or resume) a terminal task's CLI in its terminal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TerminalArgs {
    pub id: SessionId,
    /// a follow-up to start it on, once the last terminal ended
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<f64>,
}

/// `runtime.held`: the task's held turn started anyway, or skipped (the held turn found here).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct HeldArgs {
    pub id: SessionId,
    pub action: ReleaseAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct IdArgs {
    pub id: SessionId,
}

/// `runtime.resumeCommand` (v1 GET /sessions/:id/takeover, More → Copy resume command): the line that resumes the
/// task's conversation in its harness's own CLI, from its folder, to paste in a terminal of your own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ResumeLine {
    pub command: String,
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
    /// the most this task's turns may ever run at (a channel starts its tasks at Edits; v1 `session.capped`): kept
    /// on the task as `ext["wisp.runtime"].capped = { mode }`, the shape a crew job's cap has; a follow-up or a
    /// mode switch above it is refused unless the user asks in wisp, which lifts it. Full auto is no cap.
    /// Additive (2026-11-14).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cap: Option<Mode>,
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
    /// you said yes to going past Ask near the limit's line (v1 `confirmLimit`; the CLI's --yes). Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub confirm_limit: bool,
    /// start it held in the queue rather than running it now (a scheduled task)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub hold: bool,
    /// a terminal task (v1 services/tui.js, Settings → General → Terminal sessions): the harness's own CLI in a
    /// terminal in wisp, started on the prompt, instead of wisp's headless run; follow-ups are typed into it and
    /// its turns are read back from the CLI's own session. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub terminal: bool,
    /// namespaced extras the caller's plugin stores on the new task (`ext[callerPluginId]`)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(as = "Option<Ext>", optional)]
    pub ext: Ext,
    // ---- the task spec (ADR-0027); all additive ----
    /// prompts after the first, sent in order as each turn ends
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub steps: Vec<String>,
    /// an agent profile given inline (else `agent` may name a stored one)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile: Option<crate::spec::AgentSpec>,
    /// start from this commit (a rerun from the same code): a detached worktree when it isn't HEAD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base: Option<crate::spec::Base>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub goal: Option<Value>,
    /// the crew member it works for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub team: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub connectors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schedule: Option<String>,
    /// the formula overlay it runs under: formula sections (`agents`, …) recorded in its snapshot
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub formula: Option<Value>,
    #[serde(default, skip_serializing_if = "crate::spec::Lineage::is_empty")]
    #[ts(as = "Option<crate::spec::Lineage>", optional)]
    pub lineage: crate::spec::Lineage,
    /// a harness you picked after Auto's preview showed another (v1 `autoOverride`): Auto learns from it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auto_override: Option<AutoOverride>,
}

/// The pick Auto's preview showed before you chose your own (`key`: its arm, `type`: the kind of task).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AutoOverride {
    pub key: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "type")]
    pub kind: Option<String>,
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
    /// true: wait in the queue if a turn is running; false (the default, v1 `reply`): interrupt the
    /// running turn once its harness session is known, and send now
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
    /// you said yes to going past Ask near the limit's line (v1 `confirmLimit`; the CLI's --yes). Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub confirm_limit: bool,
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
    /// true: .env values masked even with Hide .env values off (a share). Additive (2026-11-13).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub masked: Option<bool>,
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
    /// true: .env values masked even with Hide .env values off (a share). Additive (2026-11-13).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub masked: Option<bool>,
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
    /// written only if the slot still holds this (compared in the write's own transaction; refused with
    /// `conflict` otherwise): a read-then-write that a later write must win over. Additive (2026-11-14).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expect: Option<ExtExpect>,
}

/// What `runtime.setExt`'s slot must hold for the write to go (`value: null`: the slot is empty).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ExtExpect {
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

/// `runtime.exec`: a one-click command from an `actions` block, run in the task's folder (v1 /exec). The
/// user's click only: no agent capability set names it. Additive (2026-11-10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ExecArgs {
    pub id: SessionId,
    pub command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ExecOut {
    pub code: i32,
    /// stdout then stderr, cut to the last 64 KB
    pub output: String,
}

/// `runtime.appState`: an `app` block's state, kept on its turn (`ext["wisp.apps"][block]`, v1 /app-state).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct AppStateArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    pub block: String,
    pub state: Value,
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
