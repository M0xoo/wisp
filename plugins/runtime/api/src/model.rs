//! The rows wisp.runtime owns: sessions (tasks), turns, their activity and the follow-up queue. Shapes
//! follow v1's session JSON (server/runner.js, server/store.js) field for field on the wire (camelCase), so
//! the importer maps 1:1 and v1 clients keep reading them. Fields other plugins own (goal, auto, forLater,
//! worktree, crew, …) live in `ext`, namespaced by the owning plugin id: runtime never reads them.
//!
//! size-ok: the contract's row types, kept in one file so ts-rs exports them together

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{SessionId, TurnId};

/// A plugin's slots on a session or turn: `ext["wisp.goal"]`, `ext["wisp.worktrees"]`, …
pub type Ext = BTreeMap<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum SessionState {
    Running,
    /// the agent asked the user something and waits on the answer (v1 `waiting`)
    Waiting,
    #[default]
    Review,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum TurnStatus {
    #[default]
    Running,
    Done,
    Error,
    /// waiting before it starts (a limit, a changed harness, project trust)
    Held,
    Stopped,
}

impl TurnStatus {
    pub fn is_live(self) -> bool {
        matches!(self, Self::Running | Self::Held)
    }
}

/// plan: read-only · edits: auto-accept file edits · auto: no permission prompts (v1 names)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum Mode {
    Plan,
    Edits,
    #[default]
    Auto,
}

impl Mode {
    /// How much a mode lets the agent do: plan < edits < auto (a capped caller may not raise it).
    pub fn rank(self) -> u8 {
        match self {
            Self::Plan => 0,
            Self::Edits => 1,
            Self::Auto => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// the file on disk, set when the turn hands it to a harness
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}

/// What kind of step a tool call was (v1 adapters' `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum ToolKind {
    Read,
    Edit,
    Run,
    Search,
    Web,
    Agent,
    Plan,
    #[default]
    Tool,
    Wait,
    Ask,
    Answer,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum Tone {
    Info,
    Warn,
    Danger,
}

/// One step of a turn's activity: a row of the append-only event log (`kind` is the event kind).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "runtime/")]
pub enum Activity {
    Text {
        text: String,
    },
    Thinking {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
    },
    Tool {
        tool: ToolKind,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<String>,
        #[serde(default, rename = "callId", skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "callId")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    ToolOutput {
        #[serde(rename = "callId")]
        #[ts(rename = "callId")]
        call_id: String,
        text: String,
    },
    ToolError {
        name: String,
        text: String,
    },
    Blocked {
        tool: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rule: Option<String>,
    },
    Notice {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tone: Option<Tone>,
    },
}

impl Activity {
    /// The event-log `kind` column.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Thinking { .. } => "thinking",
            Self::Tool { .. } => "tool",
            Self::ToolOutput { .. } => "tool_output",
            Self::ToolError { .. } => "tool_error",
            Self::Blocked { .. } => "blocked",
            Self::Notice { .. } => "notice",
        }
    }
}

/// One row of a turn's event log: its per-session `seq`, when it happened, and the step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Step {
    pub seq: u64,
    pub t: i64,
    #[serde(flatten)]
    pub activity: Activity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "runtime/")]
pub enum ChangeOp {
    Add,
    Modify,
    Delete,
    Rename,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Edit {
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct FileChange {
    pub file: String,
    pub op: ChangeOp,
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
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
    pub ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub models: Option<BTreeMap<String, Value>>,
    /// how large the conversation was after the turn (0: it compacted); the cold-cache line reads it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context_tokens: Option<u64>,
    /// how long the provider keeps the prompt cache (Claude: 5 min or 1 h); absent: the harness doesn't say
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_ttl_ms: Option<u64>,
}

/// The answer's rendered form: the fenced `wisp` block, parsed and checked. `v` is the parser version
/// that made it: a newer parser rebuilds it lazily from the turn's text (plan §4.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "runtime/")]
pub struct Presentation {
    pub blocks: Vec<Value>,
    pub v: u32,
    /// what the validator dropped, and why (shown to nobody but kept for the protocol goldens)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub dropped: Vec<String>,
    /// the answer's top-level topic (names the task when no hero does)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub topic: Option<String>,
    /// prose the agent wrote ahead of its wisp block
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    /// the agent ignored or broke the protocol: the answer is shown as markdown
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub fallback: bool,
}

/// Who holds a turn before it starts, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Held {
    pub by: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub until: Option<i64>,
    #[serde(default)]
    pub data: Value,
}

/// The harness turned the task down (v1 `turn.refusal`): the card offers the same prompt, with what the task has
/// seen, to a harness running another vendor's model. Never by itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TurnRefusal {
    pub agent: String,
    pub model: String,
    /// whose model it was (`anthropic`, `openai`…); absent when it can't be told
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vendor: Option<String>,
    /// `policy` (the API or the CLI said so) or `declined` (a short answer that opens by declining)
    pub kind: String,
    /// the line the card quotes
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub line: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Turn {
    pub id: TurnId,
    pub session_id: SessionId,
    pub idx: u32,
    pub prompt: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub mode: Mode,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// who sent it, when not the user: 'wisp' (a goal check), 'compact', 'later', 'crew', 'channel'
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
    pub status: TurnStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub held: Option<Held>,
    pub stats: Option<TurnStats>,
    pub presentation: Option<Presentation>,
    /// the harness's own conversation id, to resume
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_id: Option<String>,
    /// the final answer text (the last text activity)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub is_error: bool,
    /// how many files the turn changed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub changed_files: Option<u32>,
    /// the harness turned the task down (additive, 2026-11-11)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub refusal: Option<TurnRefusal>,
    /// how many activity events the turn has (the event log's length for this turn)
    #[serde(default)]
    pub n_events: u32,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub ext: Ext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[ts(export, export_to = "runtime/")]
pub struct QueueItem {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub by: Option<String>,
    /// how it runs when it is sent (mode, run overrides), as the follow-up carried them
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub opts: Option<Value>,
    /// it interrupted the run: it goes ahead of the rest, after earlier interrupting ones (v1 `now`)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub now: bool,
    /// wisp's own report of finished delegations to their lead (later ones merge into it)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub reports: bool,
}

impl QueueItem {
    /// wisp's own (reports back, repairs): the user may not edit or merge it.
    pub fn by_wisp(&self) -> bool {
        self.by.as_deref() == Some("wisp")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Session {
    pub id: SessionId,
    pub title: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    /// this task's own lean runs choice, 'on' | 'off' (v1 `lean`); none follows `runtime.leanRuns`. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lean: Option<String>,
    pub mode: Mode,
    pub cwd: String,
    /// extra folders the task may touch
    #[serde(default)]
    pub dirs: Vec<String>,
    pub state: SessionState,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<SessionId>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub queue: Vec<QueueItem>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub queue_held: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub tags: Vec<String>,
    /// the harness conversation the next turn resumes (the last turn's resume id)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_id: Option<String>,
    /// bumped on every write of the row (sync's per-entity revision)
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub ext: Ext,
}

impl Session {
    /// A plugin's slot, or `Null`.
    pub fn ext_of(&self, plugin: &str) -> &Value {
        self.ext.get(plugin).unwrap_or(&Value::Null)
    }
}

/// The list row: runtime's own fields plus what each plugin adds through `runtime.summary@1`, flattened
/// (v1 names kept for the wire: goal, forLater, branch, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Summary {
    pub id: SessionId,
    pub title: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub mode: Mode,
    pub cwd: String,
    pub state: SessionState,
    /// 'running' | 'held' | 'done' | 'blocked' | 'info' | a plugin's own
    pub status: String,
    pub unread: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub turn_count: u32,
    pub queued: u32,
    /// the first line of the last answer (or the last prompt)
    pub preview: String,
    /// what the task is doing right now ('' when idle)
    pub live: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub fields: BTreeMap<String, Value>,
}

/// A search hit (`runtime.search`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct SearchHit {
    pub id: SessionId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<TurnId>,
    /// the matching text, around the match
    pub snippet: String,
    pub updated_at: i64,
}
