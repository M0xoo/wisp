//! Asks: a question, a permission prompt or a connector's sign-in card that a task's agent waits on.
//! wisp.mcp holds the open ones (one at a time per session, the rest queued, as v1's `askUser` chain did)
//! and the wait behind each; whoever answers (the UI, a channel, the connectors plugin) runs
//! `mcp.ask.answer`. A restart ends every wait (v1: a new token, so the harness's child gave up too).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{Command, Event};

/// An open ask, as the UI and channels show it (channels' `AskView`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub id: String,
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// a permission prompt: `{ tool, input, toolUseId }`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clash: Option<Value>,
    /// a connector's sign-in or keys card
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

/// An answer: text for a question or card, a decision for a permission prompt.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    /// what the user said with a denial
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Opens an ask for a session (connectors' sign-in card, the approval owner's prompt). Permission
/// `mcp:ask.open` is for plugins only: an agent asks through `ask_user`, whose session is its caller's.
#[derive(Debug)]
pub struct AskOpen;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOpenArgs {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clash: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector: Option<Value>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOpened {
    pub ask_id: String,
}
impl Command for AskOpen {
    const ID: &'static str = "mcp.ask.open";
    type Args = AskOpenArgs;
    type Out = AskOpened;
}

/// Answers an ask by id, or the session's front one (a channel knows the task, not the ask).
#[derive(Debug)]
pub struct AskAnswer;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AskAnswerArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(flatten)]
    pub reply: AskReply,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answered {
    /// false: no such ask open (already answered, cancelled, or wisp restarted)
    pub answered: bool,
}
impl Command for AskAnswer {
    const ID: &'static str = "mcp.ask.answer";
    type Args = AskAnswerArgs;
    type Out = Answered;
}

/// Cancels one ask, or every ask of a session (its turn ended, it was stopped).
#[derive(Debug)]
pub struct AskCancel;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AskCancelArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cancelled {
    pub cancelled: u32,
}
impl Command for AskCancel {
    const ID: &'static str = "mcp.ask.cancel";
    type Args = AskCancelArgs;
    type Out = Cancelled;
}

/// The asks shown now (each session's front one), for a client that (re)connects.
#[derive(Debug)]
pub struct AskPending;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AskPendingArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}
impl Command for AskPending {
    const ID: &'static str = "mcp.ask.pending";
    const READ_ONLY: bool = true;
    type Args = AskPendingArgs;
    type Out = Vec<Ask>;
}

// ---------- events ----------

/// An ask is shown now: opened at the front of its session, or moved up when the one before closed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskShown {
    pub ask: Ask,
}
impl Event for AskShown {
    const TYPE: &'static str = "mcp.ask.shown";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Answered,
    Cancelled,
}

/// An ask is gone: answered, cancelled, or its waiter left (the harness went).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskClosed {
    pub id: String,
    pub session: String,
    pub outcome: Outcome,
}
impl Event for AskClosed {
    const TYPE: &'static str = "mcp.ask.closed";
}
