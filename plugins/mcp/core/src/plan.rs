//! What each tool of a task's agent does, decided without IO: which owner command it runs with which
//! arguments (v1's route bodies, mcp-ask.js), or which of the waits this server owns it is. The session
//! is always the caller's, written over whatever the arguments say (a token is one session's).

use serde_json::{Map, Value, json};
use wisp_mcp_api::{SessionInfo, owners};

use crate::rpc::truthy;
use crate::{McpError, words};

type Args = Map<String, Value>;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentAction {
    /// one owner command: its `{ text }` is the answer, its `{ error }` the refusal
    Owner { command: &'static str, args: Value },
    /// `ask_user`: a question shown to the user, waited on
    Ask { question: String, context: Option<String>, options: Vec<String> },
    /// `approve`: the owner decides at once or opens a prompt to wait on
    Approve { args: Value, input: Value },
    /// `wisp_connector_add`; `consent`: the question to ask first (a local command every task would start)
    ConnectorAdd { consent: Option<String>, args: Value },
    /// `wisp_connector_signin`: the owner answers, or opens a card to wait on
    ConnectorSignin { args: Value },
    /// `wisp_launch`, then with `wait` the first task's report
    Launch { args: Value, wait: bool, wait_ms: i64 },
    /// `wisp_task` action `wait`
    TaskWait { task: String, wait_ms: i64 },
    /// `delegate`; `wait`: collect the reports before answering
    Delegate { args: Value, wait: bool },
    /// `subagent_results`
    Results { args: Value, wait: bool },
}

fn with_session(mut a: Args, session: &str) -> Value {
    a.insert("session".into(), Value::String(session.to_owned()));
    Value::Object(a)
}

/// The fields v1 put in a query string: those given, not empty.
fn query(a: &Args, keys: &[&str], session: &str) -> Value {
    let mut out: Args = keys
        .iter()
        .filter_map(|k| a.get(*k).filter(|v| !v.is_null() && v.as_str() != Some("")).map(|v| ((*k).to_owned(), v.clone())))
        .collect();
    out.insert("session".into(), Value::String(session.to_owned()));
    Value::Object(out)
}

fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    }
}

fn owner(command: &'static str, args: Value) -> AgentAction {
    AgentAction::Owner { command, args }
}

/// The action for a built-in tool, or `None` when there is no such tool (the dispatcher already
/// refused what isn't offered).
pub fn agent_action(name: &str, a: Args, session: &str, info: &SessionInfo) -> Result<Option<AgentAction>, McpError> {
    let s = session;
    let action = match name {
        "ask_user" => ask(&a)?,
        "resume_later" => owner(owners::LATER_SCHEDULE, with_session(a, s)),
        "wisp_tag" => owner(owners::TAG, json!({ "session": s, "tags": a.get("tags") })),
        "wisp_pr" => owner(owners::PR, json!({ "session": s, "pr": a.get("pr"), "remove": a.get("remove").is_some_and(truthy) })),
        "wisp_watch" => owner(owners::WATCH, with_session(a, s)),
        "wisp_save" => owner(owners::STUFF_SAVE, with_session(a, s)),
        "wisp_stuff" => owner(owners::STUFF_LIST, query(&a, &["id", "query", "kind", "limit"], s)),
        "wisp_blocks" => owner(owners::BLOCKS, json!({ "session": s, "types": a.get("types") })),
        "wisp_stats" => owner(owners::STATS, query(&a, &["days", "agent", "project"], s)),
        "wisp_sessions" => owner(owners::SESSIONS, query(&a, &a.keys().map(String::as_str).collect::<Vec<_>>(), s)),
        "wisp_session" => session_read(&a, s)?,
        "wisp_crew" => {
            owner(owners::CREW_LIST, if a.get("member").is_some_and(truthy) { query(&a, &["member"], s) } else { json!({ "session": s }) })
        }
        "wisp_crew_add" => owner(owners::CREW_ADD, with_session(a, s)),
        "wisp_crew_edit" => owner(owners::CREW_EDIT, with_session(a, s)),
        "wisp_crew_kit" => owner(owners::CREW_KIT, with_session(a, s)),
        "wisp_crew_remove" => owner(owners::CREW_REMOVE, with_session(a, s)),
        "wisp_connectors" => owner(owners::CONNECTORS_LIST, json!({ "session": s })),
        "wisp_connector_add" => connector_add(a, s),
        "wisp_connector_signin" => AgentAction::ConnectorSignin { args: with_session(a, s) },
        "wisp_available" => owner(owners::AVAILABLE, json!({ "session": s })),
        "wisp_launch" => launch(a, s),
        "wisp_task" if a.get("action").and_then(Value::as_str) == Some("wait") => {
            AgentAction::TaskWait { task: text(a.get("task")), wait_ms: words::task_wait_ms(a.get("timeout_seconds")) }
        }
        "wisp_task" => owner(owners::TASK, with_session(a, s)),
        "approve" if info.approve => approve(&a, s),
        // v1's default parameter: only a missing `wait` waits by default; a falsy one doesn't.
        "delegate" => {
            AgentAction::Delegate { wait: a.get("wait").is_none_or(truthy), args: json!({ "session": s, "tasks": a.get("tasks") }) }
        }
        "subagent_results" => results(&a, s, info),
        "wisp_plugins" => owner(owners::PLUGINS, json!({ "session": s })),
        "wisp_plugin_schema" => owner(owners::PLUGIN_SCHEMA, json!({ "session": s })),
        "wisp_plugin_data" => owner(owners::PLUGIN_DATA, json!({ "session": s, "command": text(a.get("command")), "args": a.get("args") })),
        "wisp_plugin_check" => owner(
            owners::PLUGIN_CHECK,
            json!({ "session": s, "manifest": a.get("manifest"), "files": a.get("files").cloned().unwrap_or_else(|| json!({})) }),
        ),
        _ => return Ok(None),
    };
    Ok(Some(action))
}

/// A question stays a question: only its words go to the user, never a card or a prompt of its own.
fn ask(a: &Args) -> Result<AgentAction, McpError> {
    let question = text(a.get("question"));
    if question.trim().is_empty() {
        return Err(McpError::Required("question"));
    }
    let context = a.get("context").map(|v| text(Some(v))).filter(|c| !c.is_empty());
    let options = a
        .get("options")
        .and_then(Value::as_array)
        .map(|o| o.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    Ok(AgentAction::Ask { question, context, options })
}

fn session_read(a: &Args, s: &str) -> Result<AgentAction, McpError> {
    let id = a.get("id").filter(|v| truthy(v)).ok_or(McpError::Required("id"))?;
    let mut args = json!({ "session": s, "of": text(Some(id)) });
    if let (Some(turn), Some(o)) = (a.get("turn"), args.as_object_mut()) {
        o.insert("turn".into(), turn.clone());
    }
    Ok(owner(owners::SESSION, args))
}

fn connector_add(mut a: Args, s: &str) -> AgentAction {
    let remote = a.get("url").is_some_and(truthy);
    let consent =
        (a.get("command").is_some_and(truthy) && !remote).then(|| words::connector_question(&text(a.get("name")), &text(a.get("command"))));
    a.insert("transport".into(), Value::String(if remote { "remote" } else { "local" }.into()));
    AgentAction::ConnectorAdd { consent, args: with_session(a, s) }
}

fn launch(mut a: Args, s: &str) -> AgentAction {
    let wait = a.remove("wait").is_some_and(|v| truthy(&v));
    let wait_ms = words::task_wait_ms(a.remove("timeout_seconds").as_ref());
    AgentAction::Launch { args: with_session(a, s), wait, wait_ms }
}

fn approve(a: &Args, s: &str) -> AgentAction {
    let input = a.get("input").cloned().unwrap_or_else(|| json!({}));
    let mut args = json!({ "session": s, "tool": a.get("tool_name"), "input": input });
    if let (Some(id), Some(o)) = (a.get("tool_use_id"), args.as_object_mut()) {
        o.insert("tool_use_id".into(), id.clone());
    }
    AgentAction::Approve { args, input }
}

fn results(a: &Args, s: &str, info: &SessionInfo) -> AgentAction {
    let ids: Vec<String> = a.get("ids").and_then(Value::as_array).map(|v| v.iter().map(|x| text(Some(x))).collect()).unwrap_or_default();
    AgentAction::Results { wait: a.get("wait") != Some(&Value::Bool(false)), args: results_args(s, &ids, info) }
}

/// `subagent_results`' read: these ids (none: every task delegated this turn), of this turn.
pub fn results_args(s: &str, ids: &[String], info: &SessionInfo) -> Value {
    json!({ "session": s, "ids": ids, "turn": info.turn_id.clone().unwrap_or_default() })
}

/// The owner's answer: its text, or its refusal.
pub fn owner_text(out: &Value) -> Result<String, McpError> {
    if let Some(e) = out.get("error").filter(|e| truthy(e)) {
        return Err(McpError::Refused(text(Some(e))));
    }
    Ok(text(out.get("text")))
}
