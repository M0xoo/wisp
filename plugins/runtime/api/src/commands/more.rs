//! Arguments and answers of asks, approvals, /btw, delegation, sign-in, side runs and import.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::RunPick;
use crate::model::{Activity, Attachment, Ext, SessionState};
use crate::{SessionId, TurnId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ApprovalArgs {
    pub id: SessionId,
    pub tool: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ApproveBlockedArgs {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    pub allow: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct BtwArgs {
    pub id: SessionId,
    pub question: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Attachment>>", optional)]
    pub attachments: Vec<Attachment>,
}

/// A /btw side question and its answer (v1 btw.js), kept on the task, never in its conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct BtwEntry {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub answer: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct BtwDropArgs {
    pub id: SessionId,
    pub btw_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct DelegateTask {
    pub subagent: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct DelegateArgs {
    pub id: SessionId,
    pub tasks: Vec<DelegateTask>,
}

/// One subagent a lead started (v1 subagents.js).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Delegation {
    pub id: SessionId,
    pub subagent: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub turn_id: TurnId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub place: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ResultsArgs {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SessionId>>", optional)]
    pub ids: Vec<SessionId>,
    /// wait (up to this many seconds) for them to finish
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub wait: Option<u32>,
}

/// A subagent's report to its lead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Report {
    pub id: SessionId,
    pub subagent: String,
    pub state: SessionState,
    pub done: bool,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Reports {
    pub reports: Vec<Report>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct RerunArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SignInDoneArgs {
    pub agent: String,
    pub account: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct OverageArgs {
    pub id: SessionId,
    pub turn_id: TurnId,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct NoteArgs {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tone: Option<crate::model::Tone>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SettleArgs {
    pub id: SessionId,
    /// the after-turn step found nothing to say: land without marking the task unread
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub quiet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct SearchArgs {
    pub q: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct QuickArgs {
    pub prompt: String,
    pub cwd: String,
    /// this harness and model; default: the cheapest one available (v1 quick.js)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pick: Option<RunPick>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timeout_ms: Option<u64>,
    /// the answer is a JSON object: parsed into `json`, null when it isn't one
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub json: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct QuickResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub json: Option<Value>,
    pub agent: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Activity>>", optional)]
    pub activity: Vec<Activity>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AgentsArgs {
    /// detect again (Settings → Agents → Re-check); a harness id detects only that one again
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fresh: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct AgentStatus {
    pub id: String,
    pub name: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    pub models: Vec<crate::harness::HarnessModel>,
    pub efforts: Vec<String>,
    /// can lead a team of subagents (takes wisp's MCP server)
    pub delegates: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub setup: Option<crate::harness::SetupTip>,
}

/// `runtime.card`: a task that is only a message (v1 `kind: 'reminder'`): review, unread, one done turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct CardArgs {
    pub title: String,
    pub prompt: String,
    pub blocks: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(as = "Option<Ext>", optional)]
    pub ext: Ext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ForkArgs {
    pub id: SessionId,
    /// fork after this turn (default: the last)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
}

/// `runtime.import`: bring v1's `~/.wisp/sessions/*.json` in (resumable by file, mtime and size).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ImportArgs {
    /// the sessions folder (default `~/.wisp/sessions`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct ImportReport {
    pub imported: u32,
    /// already imported, unchanged since
    pub skipped: u32,
    /// unreadable files, with why
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct PresentationArgs {
    pub id: SessionId,
    /// a turn index; default the last
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn: Option<u32>,
}

/// `wisp_sessions` (v1 GET /internal/sessions/:id): the user's other tasks, newest first. `session` is the
/// asking agent's task (wisp.mcp sets it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AgentSessionsArgs {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub query: Option<String>,
    /// comma-separated states
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// `wisp_session` (v1 GET /internal/session/:id?of&turn): one task in words.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AgentSessionArgs {
    pub session: String,
    pub of: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn: Option<u32>,
}

/// What an agent tool reads back: `text`, or `error`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct AgentText {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// `runtime.projectRun`: the run scripts of the project a folder is in (its `run:`, a dev server), in a
/// terminal of their own (`run:<project>`). Additive (2026-11-09).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct ProjectRunArgs {
    /// a folder in the project
    pub cwd: String,
}

/// `runtime.sessions`: this folder's sessions run outside wisp, across harnesses (ADR-0035). Additive.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct SessionsArgs {
    pub cwd: String,
}

/// `runtime.adoptSession`: one of them as a wisp task; its follow-ups continue it in its CLI. Additive.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct AdoptSessionArgs {
    pub harness: String,
    pub id: String,
}
