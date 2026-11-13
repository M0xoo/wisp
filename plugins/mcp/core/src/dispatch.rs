//! The dispatcher: one parsed message and who sent it in, what to answer out. `initialize`, `tools/list`,
//! `ping`, refusals and unknown methods are answered here at once; a tool call comes back as a `Call` for
//! the host to run (it waits on the kernel), and `finish` turns its outcome into v1's answer.

use serde_json::value::RawValue;
use serde_json::{Map, Value};
use wisp_mcp_api::{Audience, SessionInfo};

use crate::rpc::{self, Incoming, Message};
use crate::table::{self, OwnFlags, Refusal};
use crate::{McpError, words};

const USER_INSTRUCTIONS: &str = "wisp runs coding agents in the background. Launch with wisp_launch, then wisp_wait / wisp_get for the result; wisp_reply to follow up or answer a question. wisp_crew* manage the user's crew of long-lived agents.";
/// v1's agent server always said 0.1.0; harnesses may have cached it.
const AGENT_SERVER_VERSION: &str = "0.1.0";

/// Who a message is from, as the tools see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Who {
    /// a task's agent: its session (the caller's) and that session's flags
    Agent { session: String, info: SessionInfo },
    /// the user's own editor (`wisp mcp`), and wisp's version for `serverInfo`
    User { version: String },
}

impl Who {
    /// A caller with a session is that session's agent; an `agent:capped` set is capped whatever the
    /// session's flags say. Anyone else is the user's editor.
    pub fn of(set: &str, session: Option<&str>, info: SessionInfo, version: &str) -> Self {
        match session {
            Some(s) => {
                Self::Agent { session: s.to_owned(), info: SessionInfo { capped: info.capped || set.starts_with("agent:capped"), ..info } }
            }
            None => Self::User { version: version.to_owned() },
        }
    }
}

/// A tool another plugin contributed, as the dispatcher sees it.
#[derive(Debug, Clone)]
pub struct Extra {
    pub name: String,
    /// its definition as JSON text
    pub raw: String,
    pub audience: Audience,
    pub flags: OwnFlags,
}

impl Extra {
    fn for_agent(&self) -> bool {
        matches!(self.audience, Audience::Agent | Audience::Both)
    }
    fn for_user(&self) -> bool {
        matches!(self.audience, Audience::User | Audience::Both)
    }
}

/// A tool call for the host to run.
#[derive(Debug)]
pub struct Call {
    pub id: Box<RawValue>,
    pub name: String,
    pub args: Map<String, Value>,
    /// the index in `extras` when the tool is a contributed one
    pub extra: Option<usize>,
}

#[derive(Debug)]
pub enum Step {
    /// the whole answer, as JSON text
    Reply(String),
    /// a notification: no answer
    Silent,
    Call(Call),
}

/// What one line or body asks for: its steps, and whether they answer as a batch.
#[derive(Debug)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub batch: bool,
}

pub fn plan(text: &str, who: &Who, extras: &[Extra]) -> Plan {
    match rpc::parse(text) {
        Incoming::Nothing => Plan { steps: Vec::new(), batch: false },
        Incoming::One(m) => Plan { steps: vec![step(m, who, extras)], batch: false },
        Incoming::Batch(items) if items.is_empty() => Plan { steps: vec![Step::Reply(rpc::invalid_request())], batch: false },
        Incoming::Batch(items) => Plan {
            steps: items.into_iter().map(|m| m.map_or_else(|| Step::Reply(rpc::invalid_request()), |m| step(m, who, extras))).collect(),
            batch: true,
        },
    }
}

/// The answers of a plan's steps, in order (`None` for silent ones), as one line or body.
pub fn assemble(replies: Vec<Option<String>>, batch: bool) -> Option<String> {
    let mut replies: Vec<String> = replies.into_iter().flatten().collect();
    if batch { rpc::batch(&replies) } else { replies.pop() }
}

pub fn step(mut m: Message, who: &Who, extras: &[Extra]) -> Step {
    let Some(id) = m.id.take() else { return Step::Silent };
    match m.method() {
        Some("initialize") => Step::Reply(rpc::result(&id, &initialize(&m, who))),
        Some("tools/list") => Step::Reply(rpc::result(&id, &tools_list(who, extras))),
        Some("ping") => Step::Reply(rpc::result(&id, "{}")),
        Some("tools/call") => call(id, m, who, extras),
        _ => Step::Reply(not_found(&id, &m.method_text())),
    }
}

fn not_found(id: &RawValue, method: &str) -> String {
    rpc::error(id, rpc::METHOD_NOT_FOUND, &format!("Method not found: {method}"))
}

fn initialize(m: &Message, who: &Who) -> String {
    let pv = m.protocol_version();
    match who {
        Who::Agent { .. } => format!(
            "{{\"protocolVersion\":{pv},\"capabilities\":{{\"tools\":{{}}}},\"serverInfo\":{{\"name\":\"wisp\",\"version\":\"{AGENT_SERVER_VERSION}\"}}}}"
        ),
        Who::User { version } => format!(
            "{{\"protocolVersion\":{pv},\"capabilities\":{{\"tools\":{{}}}},\"serverInfo\":{{\"name\":\"wisp\",\"version\":{}}},\"instructions\":{}}}",
            rpc::quote(version),
            rpc::quote(USER_INSTRUCTIONS)
        ),
    }
}

/// `{"tools":[…]}`: the built-ins first, in v1's order, then what plugins contributed.
pub fn tools_list(who: &Who, extras: &[Extra]) -> String {
    let Ok(t) = table::table() else { return "{\"tools\":[]}".into() };
    let (base, own): (std::borrow::Cow<'_, str>, Vec<&str>) = match who {
        Who::User { .. } => (t.user_list().into(), extras.iter().filter(|e| e.for_user()).map(|e| e.raw.as_str()).collect()),
        Who::Agent { info, .. } => (
            table::agent_list(t, info),
            extras
                .iter()
                .filter(|e| e.for_agent() && table::not_offered(&e.name, info, Some(e.flags)).is_none())
                .map(|e| e.raw.as_str())
                .collect(),
        ),
    };
    let mut s = String::with_capacity(base.len() + own.iter().map(|r| r.len() + 1).sum::<usize>() + 12);
    s.push_str("{\"tools\":[");
    s.push_str(&base);
    for r in own {
        if s.len() > "{\"tools\":[".len() {
            s.push(',');
        }
        s.push_str(r);
    }
    s.push_str("]}");
    s
}

fn call(id: Box<RawValue>, mut m: Message, who: &Who, extras: &[Extra]) -> Step {
    let name = m.tool().unwrap_or_default().to_owned();
    match who {
        Who::Agent { info, .. } => {
            let extra = extras.iter().position(|e| e.name == name && e.for_agent());
            let own = extra.and_then(|i| extras.get(i)).map(|e| e.flags);
            match table::not_offered(&name, info, own) {
                Some(Refusal::Capped) => return Step::Reply(rpc::result(&id, &rpc::tool_text(words::CAPPED, true))),
                Some(Refusal::ReadOnly) => return Step::Reply(rpc::result(&id, &rpc::tool_text(words::READ_ONLY, true))),
                None => {}
            }
            let builtin =
                table::table().is_ok_and(|t| name == "delegate" || t.agent_def(&name).is_some()) && table::exists_for(&name, info);
            if !builtin && extra.is_none() {
                // v1 fell through every branch to its last line, which names the method, not the tool.
                return Step::Reply(not_found(&id, "tools/call"));
            }
            Step::Call(Call { id, name, args: m.take_arguments(), extra: if builtin { None } else { extra } })
        }
        Who::User { .. } => {
            let builtin = table::table().is_ok_and(|t| t.user.iter().any(|d| d.name == name)) || table::USER_CREW.contains(&name.as_str());
            let extra = extras.iter().position(|e| e.name == name && e.for_user());
            if !builtin && extra.is_none() {
                return Step::Reply(rpc::error(&id, rpc::INVALID_PARAMS, &McpError::UnknownTool(name).to_string()));
            }
            Step::Call(Call { id, name, args: m.take_arguments(), extra: if builtin { None } else { extra } })
        }
    }
}

/// How a tool call ended, as the host saw it.
#[derive(Debug)]
pub enum Outcome {
    /// the text the tool answers
    Text(String),
    /// it failed: the owner's refusal or the kernel's error, in words
    Failed(String),
    /// a JSON-RPC error rather than a tool result (`wisp mcp`'s unknown tool)
    Rpc(i64, String),
}

/// The answer to a call, in v1's words for a failure: an `approve` that fails denies (the gate fails
/// closed), `ask_user` says the user couldn't be reached, anything else is `wisp: …`.
pub fn finish(id: &RawValue, name: &str, who: &Who, outcome: Outcome) -> String {
    match outcome {
        Outcome::Text(t) => rpc::result(id, &rpc::tool_text(&t, false)),
        Outcome::Rpc(code, message) => rpc::error(id, code, &message),
        Outcome::Failed(why) => {
            let agent = matches!(who, Who::Agent { .. });
            let body = match name {
                "approve" if agent => rpc::tool_text(&words::deny_json(&format!("{}: {why}", words::NO_USER)), false),
                "ask_user" if agent => rpc::tool_text(&format!("{}: {why}", words::NO_USER), true),
                _ => rpc::tool_text(&format!("wisp: {why}"), true),
            };
            rpc::result(id, &body)
        }
    }
}
