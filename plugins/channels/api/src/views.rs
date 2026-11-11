//! A task, the context and a message as a channel sees them: the parts of v1's session JSON and
//! `services/phone.js` that the hub and every transport read. Field names stay v1's (camelCase on the
//! wire) so v1 clients and the grid keep reading them.
//!
//! size-ok: the contract's wire types, kept in one file so ts-rs exports them together
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How far a task may go on its own. Ordered: `Plan < Edits < Auto`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ts_rs::TS,
)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Plan,
    Edits,
    Auto,
}

impl Mode {
    /// What wisp's UI calls it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "Plan",
            Self::Edits => "Edits",
            Self::Auto => "Full auto",
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Edits => "edits",
            Self::Auto => "auto",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plan" => Some(Self::Plan),
            "edits" => Some(Self::Edits),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

// ---------- messages ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    Answer,
    Reply,
    Done,
}

impl ActionKind {
    /// The one-letter code a signed tap carries (`a`, `r`, `d`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Answer => "a",
            Self::Reply => "r",
            Self::Done => "d",
        }
    }
    pub fn from_code(c: &str) -> Option<Self> {
        match c {
            "a" => Some(Self::Answer),
            "r" => Some(Self::Reply),
            "d" => Some(Self::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Action {
    pub label: String,
    pub kind: ActionKind,
    /// the ask id (answer) or the turn id (reply, done)
    #[serde(rename = "ref")]
    pub reference: String,
    pub index: u32,
}

/// What the hub sends: v1 `Remote.message()`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct Msg {
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub actions: Vec<Action>,
}

/// A signed tap (ntfy's buttons, Telegram's callback data): `{ s, k, r, i, sig }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signed {
    pub s: String,
    pub k: String,
    pub r: String,
    pub i: u32,
    pub sig: String,
}

// ---------- the task as a channel sees it ----------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Permission {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// An ask a task waits on (wisp.mcp's `ask_user`, an approval, a clash card, a connector's sign-in).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AskView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clash: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<Value>,
}

impl AskView {
    /// An ask only wisp can answer: a tool approval, a clash card, a connector's sign-in or keys.
    pub fn needs_wisp(&self) -> bool {
        self.permission.is_some() || self.clash.is_some() || self.connector.is_some()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Btw {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TurnView {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Value>,
    /// `{ blocks: [...] }`: the wisp block the turn ended with
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub btw: Vec<Btw>,
}

/// What a channel keeps about a task (v1 `s.remote`): where it started, its thread there
/// (`slack: { channel, ts }`, `github: { repo, issue }`, `tg: [message ids]`, `routed: "<thread>"`).
pub type Remote = serde_json::Map<String, Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// v1's states: `running`, `waiting` (an ask is open), `review`, `done`, `error`
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_of: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crew: Option<Value>,
    /// a task started from a channel below Full auto: `{ mode }`. It stays for every follow-up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capped: Option<Capped>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<AskView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue: Vec<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queue_held: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delegated: bool,
    #[serde(default)]
    pub turns: Vec<TurnView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<Remote>,
    /// the branch its worktree is on (`ext["wisp.worktrees"].branch`), when it has one. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// when it was made (ms), for "the newest". Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capped {
    pub mode: Mode,
}

/// The list row the phone's message reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Where a task started from a channel answers (kept with a crew job that has to wait).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub channel: String,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(flatten)]
    pub more: BTreeMap<String, Value>,
}

// ---------- what a message may pick from ----------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default = "yes")]
    pub available: bool,
    #[serde(default = "yes")]
    pub signed_in: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineView {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub computer: bool,
    #[serde(default = "yes")]
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<AgentView>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MemberView {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    #[serde(default)]
    pub sandbox: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub running: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queue: Vec<Value>,
}

/// A harness as the lists read it, with what it really runs a model as in a mode.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterView {
    #[serde(flatten)]
    pub agent: AgentView,
    /// (model, mode) → (label, note): a model this harness swaps in a mode (`opus` → `sonnet` in plan)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<ModelOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOverride {
    pub model: String,
    pub mode: Mode,
    pub label: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadCtx {
    pub agent: String,
    pub machine: String,
}

/// Everything a message may pick from (the grammar, the lists).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCtx {
    pub projects: Vec<ProjectView>,
    pub machines: Vec<MachineView>,
    pub agents: Vec<AgentView>,
    pub adapters: Vec<AdapterView>,
    pub crew: Vec<MemberView>,
    pub goals: Vec<String>,
    pub default_project: Option<ProjectView>,
    pub default_agent: String,
    pub sandbox: bool,
    pub tasks: Vec<TaskRow>,
    /// in a task's thread: where its follow-up runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<ThreadCtx>,
    /// a router's grammar: whole names only
    #[serde(default)]
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub kind: String,
    pub text: String,
    pub choices: Vec<String>,
}

/// The grammar's answer for one message.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Parsed {
    pub command: Option<String>,
    pub arg: String,
    pub crew: Option<MemberView>,
    pub tagged: Vec<MemberView>,
    pub project: Option<ProjectView>,
    pub machine: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<Mode>,
    pub prompt: String,
    pub problems: Vec<Problem>,
    pub notes: Vec<String>,
}

/// How a channel starts a task (`Phone::start_parsed`, `Phone::mention`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StartOpts {
    pub channel: String,
    /// the sender's display name, sanitised by the hub
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// the most this chat may ask for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<Mode>,
    /// the mode when none was asked for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Mode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<Thread>,
    /// files the message brought (uploads), for the task. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunOpts {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<Mode>,
    #[serde(default)]
    pub btw: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// false: a channel that can't answer a tool approval
    #[serde(default = "yes")]
    pub approvals: bool,
    /// files the message brought (uploads), for the turn. Additive (2026-11-11).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActKind {
    Answer,
    Reply,
    Done,
    Text,
}

impl From<ActionKind> for ActKind {
    fn from(k: ActionKind) -> Self {
        match k {
            ActionKind::Answer => Self::Answer,
            ActionKind::Reply => Self::Reply,
            ActionKind::Done => Self::Done,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActArgs {
    pub session_id: String,
    pub kind: ActKind,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default = "yes")]
    pub approvals: bool,
}

/// `Phone::start_parsed`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Started {
    pub ack: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<u32>,
}
