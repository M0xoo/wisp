//! What differs per channel in a conversation (v1 `conversation.js`'s `c`): a transport implements
//! [`Conversation`] and hands it to [`crate::ChannelHub::converse`]; the flow itself (the grammar, what each
//! command does) is wisp.channels' own. In the api so a transport reaches it, as the layers require.
use async_trait::async_trait;
use serde_json::Value;
use wisp_kernel::{Result, WireError};

use crate::hub::{Later, Phone};
use crate::scrub::truncate;
use crate::views::{ChannelCtx, Mode, Parsed, Problem, Thread};

/// Why a message didn't start, and what would have worked (v1 lists.js `refusal`).
pub fn refusal(problems: &[Problem]) -> String {
    let mut parts: Vec<String> = problems
        .iter()
        .map(|p| if p.choices.is_empty() { p.text.clone() } else { format!("{}\nChoices: {}", p.text, p.choices.iter().take(30).cloned().collect::<Vec<_>>().join(", ")) })
        .collect();
    parts.push("Nothing started. Start with “:” to send it as written.".into());
    truncate(&parts.join("\n\n"), 4000)
}

pub const NO_PROMPT: &str = "What should it do? Say it after the options.";
pub const NO_PROJECTS: &str = "No projects yet. Open a folder in wisp first.";
pub const BTW_HELP: &str = "Type your question after /btw.";

pub fn failed_line(what: &str, err: &WireError) -> String {
    format!("Couldn’t {what}: {}", truncate(&err.message, 300))
}

/// The part of a line before its first `:`, ending in one full stop.
pub fn first_part(line: &str) -> String {
    let head = line.split(':').next().unwrap_or_default();
    format!("{}.", head.strip_suffix('.').unwrap_or(head))
}

/// What differs per channel in a conversation (v1 `conversation.js`'s `c`).
#[async_trait]
pub trait Conversation: Send + Sync {
    fn phone(&self) -> &dyn Phone;
    fn ctx(&self) -> &ChannelCtx;
    fn channel(&self) -> &str;
    /// the sender's display name
    fn name(&self) -> &str;
    /// the sender's stable id
    fn sender(&self) -> &str;
    /// the most this chat may ask for
    fn cap(&self) -> Mode;
    fn fallback(&self) -> Option<Mode> {
        None
    }
    fn about(&self) -> Option<&str> {
        None
    }
    /// files the message brought (uploads: `{id, name, mime, size}`), for the task or the turn it starts. Additive
    /// (2026-11-11): an email's attachments.
    fn attachments(&self) -> Vec<serde_json::Value> {
        Vec::new()
    }
    /// false: a channel that can't answer a tool approval
    fn approvals(&self) -> bool;
    /// the line for `stop`, `done` or `/btw` out of a thread
    fn no_thread(&self) -> &str;

    /// Posts a line here. Its value is what the channel sent (a message id), for `acked`.
    async fn say(&self, text: String) -> Result<Value>;
    /// A list command (`p.command`), with its text as wisp.channels rendered it; posted as said by default.
    async fn list(&self, _p: &Parsed, text: String) -> Result<Value> {
        self.say(text).await
    }
    async fn refuse(&self, problems: &[Problem]) -> Result<Value> {
        self.say(refusal(problems)).await
    }
    /// where a task started here answers
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        None
    }
    /// a line when the message points at something gone
    fn stale(&self, _p: &Parsed) -> Option<String> {
        None
    }
    fn acked(&self, _thread: Option<&Thread>, _sent: &Value) {}
    /// keeps a first reply that couldn't go, for the next thing said in that thread. true: kept.
    fn owe(&self, _ack: &str) -> bool {
        false
    }
    /// status with less in it
    fn quiet(&self, line: String) -> String {
        line
    }
    /// a follow-up's answer, as this channel says it
    fn run_line(&self, line: String) -> String {
        line
    }
    /// where a later answer goes; None: said in this thread when it comes
    fn later(&self) -> Option<Later> {
        None
    }
    /// before a follow-up runs (a reaction, a typing mark); the returned undo runs if no turn comes
    fn before_run(&self, _session_id: &str) -> Option<Box<dyn FnOnce() + Send>> {
        None
    }
    fn failed(&self, what: &str, err: &WireError) -> String {
        failed_line(what, err)
    }
    fn btw_help(&self) -> &str {
        BTW_HELP
    }
}
