//! v1's words, verbatim: what an agent reads back from a tool (server/mcp-ask.js). A live prompt may
//! match on any of them, so they change only with the goldens.

use serde_json::{Value, json};

pub const ASK_CANCELLED: &str = "The user did not answer (the question was cancelled). Use your best judgment and note the assumption.";
pub const NO_USER: &str = "wisp could not reach the user";
pub const CAPPED: &str = "Refused: this task was started from a channel with a mode cap, so it can't use this. Say so in your report; the user can do it in wisp.";
pub const READ_ONLY: &str = "Not available in a side discussion: it only reads and changes nothing.";
pub const APPROVE_CANCELLED: &str = "The user did not answer (the request was cancelled). Do not retry it; carry on without it and say what was skipped.";
pub const DENIED: &str = "The user denied this. Do not retry it; carry on without it or ask how to proceed.";

pub const ADD_IT: &str = "Add it";
pub const DONT: &str = "Don’t";
pub const CONNECTOR_UNANSWERED: &str = "The user did not answer, so nothing was added.";
pub const CARD_CANCELLED: &str = "The card was cancelled; nothing changed. Carry on without it.";
pub const SIGNIN_SKIPPED: &str = "The user skipped it for now; it stays in Settings → Connectors, where they can sign in later. Carry on without it.";
pub const STILL_RUNNING: &str = "Still running (timed out waiting; call wait again for more).";

/// The wait a `wisp_task` / `wisp_launch` call gets unless it asks for longer, and the most it gets.
pub const WAIT_S: f64 = 240.0;
pub const MAX_WAIT_S: f64 = 1800.0;

pub fn answered(answer: &str) -> String {
    format!("The user answered: {answer}")
}

pub fn ask_answer(answer: Option<&str>) -> String {
    answer.map_or_else(|| ASK_CANCELLED.to_owned(), answered)
}

/// Claude's permission-prompt contract, as the text of the tool's answer.
pub fn allow_json(input: &Value) -> String {
    json!({ "behavior": "allow", "updatedInput": input }).to_string()
}

pub fn deny_json(message: &str) -> String {
    format!("{{\"behavior\":\"deny\",\"message\":{}}}", crate::rpc::quote(message))
}

pub fn denied(message: Option<&str>) -> String {
    match message.filter(|m| !m.is_empty()) {
        Some(m) => format!("The user denied this and said: {m}"),
        None => DENIED.to_owned(),
    }
}

/// `approve`'s answer once the prompt is decided, or `None` when nobody answered.
pub fn approve_answer(input: &Value, reply: Option<&wisp_mcp_api::AskReply>) -> String {
    match reply {
        Some(r) if r.decision == Some(wisp_mcp_api::Decision::Allow) => allow_json(input),
        Some(r) => deny_json(&denied(r.message.as_deref())),
        None => deny_json(APPROVE_CANCELLED),
    }
}

pub fn connector_question(name: &str, command: &str) -> String {
    let name = if name.is_empty() { "this" } else { name };
    format!("Add {name} as a connector? Every task will start it with: {command}")
}

/// A local connector the user didn't consent to: why nothing was added.
pub fn connector_declined(answer: Option<&str>) -> String {
    match answer {
        None => CONNECTOR_UNANSWERED.to_owned(),
        Some(a) if !a.is_empty() && a != DONT => format!("The user didn’t want it added and said: {a}. Nothing was added."),
        Some(_) => "The user didn’t want it added. Nothing was added.".to_owned(),
    }
}

/// The sign-in card's end: "Done: …" from connectors, Skip, or whatever the user typed.
pub fn signin_answer(answer: Option<&str>) -> String {
    match answer {
        None => CARD_CANCELLED.to_owned(),
        Some(a) if a.starts_with("Done: ") => format!("{}. Tasks get its tools from their next turn: harnesses load MCP servers when a turn starts, so this turn can't call them yet.", &a["Done: ".len()..]),
        Some("Skip") => SIGNIN_SKIPPED.to_owned(),
        Some(a) => format!("The user answered instead: {a}"),
    }
}

/// A task that settled (finished or asks), or one still running when the wait ran out.
pub fn task_report(settled: bool, question: Option<&str>, text: &str) -> String {
    if !settled {
        return format!("{STILL_RUNNING}\n\n{text}");
    }
    match question.filter(|q| !q.is_empty()) {
        Some(q) => format!("It is asking: {q} (answer with wisp_task action \"reply\").\n\n{text}"),
        None => text.to_owned(),
    }
}

pub fn launched_and_waited(launch: &str, wait: &str) -> String {
    format!("{launch}\n\n---\n\n{wait}")
}

/// One delegation as the runtime answers it.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
pub struct Delegation {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub subagent: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `delegate`'s words before any report: what was refused, and with wait=false what went out.
#[derive(Debug)]
pub enum Delegated {
    /// nothing went out: the whole answer
    Nothing(String),
    /// the head (refusals, maybe empty) and the ids to wait for
    Some { head: String, ids: Vec<String> },
}

pub fn delegated(all: &[Delegation]) -> Delegated {
    let s = |v: &Option<String>| v.clone().unwrap_or_default();
    let errors = all.iter().filter(|d| d.error.is_some()).map(|d| format!("- {}: {}", s(&d.subagent), s(&d.error))).collect::<Vec<_>>().join("\n");
    let ok: Vec<&Delegation> = all.iter().filter(|d| d.error.is_none()).collect();
    if ok.is_empty() {
        return Delegated::Nothing(format!("Nothing was delegated.\n{errors}"));
    }
    let head = if errors.is_empty() { String::new() } else { format!("Some tasks were not delegated:\n{errors}\n\n") };
    Delegated::Some { head, ids: ok.iter().map(|d| s(&d.id)).collect() }
}

pub fn delegated_no_wait(head: &str, all: &[Delegation]) -> String {
    let s = |v: &Option<String>| v.clone().unwrap_or_default();
    let list = all.iter().filter(|d| d.error.is_none()).map(|d| format!("{} (id {})", s(&d.name), s(&d.id))).collect::<Vec<_>>().join(", ");
    format!("{head}Delegated: {list}. Collect the reports with subagent_results.")
}

/// JavaScript's `Number(v)`, for v1's lenient numeric arguments ("30" counts).
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// `Number(v) || fallback`: zero and NaN fall back.
pub fn number_or(v: Option<&Value>, fallback: f64) -> f64 {
    let n = js_number(v);
    if n == 0.0 || n.is_nan() { fallback } else { n }
}

/// How long an agent's task wait lasts, in ms: 1 s to 30 min, 240 s by default.
#[allow(clippy::cast_possible_truncation)] // clamped to 1_800_000 first
pub fn task_wait_ms(seconds: Option<&Value>) -> i64 {
    (number_or(seconds, WAIT_S).clamp(1.0, MAX_WAIT_S) * 1000.0) as i64
}
