//! The agent's tools (`wisp_connectors`, `wisp_connector_add`, `wisp_connector_signin`) as v1's
//! /internal/connectors routes answered them. Only the user's own tasks change connectors: not a
//! subagent, nor a crew member's job. Secret values never pass through the agent: it names the keys,
//! the user fills them in on a card.

use serde_json::Value;
use wisp_connectors_api::{AgentAddArgs, AskConnector, AskKey, AskKind, ConnectorBody, KeyField, SecretField, SecretInput, SigninAsk, Transport};

use crate::error::{ConnectorError, Result};
use crate::model::missing;
use crate::text::plural;
use wisp_connectors_api::Connector;

pub const READY: &str = "Tasks get it from their next turn: harnesses load MCP servers when a turn starts, so this turn can’t call it yet.";
pub const NONE_YET: &str = "The user has no connectors yet. Add one with wisp_connector_add.";
pub const ONLY_THE_USER: &str = "Only a task the user started can change their connectors; a subagent or a crew member’s job can’t. Tell the user what to add instead.";

/// v1 capped.js `cappedRefusal('read or change the user\'s connectors')`.
pub fn capped_refusal() -> String {
    "Refused: this task was started from a channel with a mode cap, so it can't read or change the user's connectors. Say so in your report; the user can do it in wisp.".to_owned()
}

/// Who is asking, from the session its token speaks for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Asker {
    pub agent: String,
    /// a subagent or a crew member's job
    pub delegated: bool,
    /// started from a channel below Full auto
    pub capped: bool,
}

/// One connector's state, as the agent reads it. `has("env:KEY")`: is that secret set.
pub fn state(x: &Connector, has: &dyn Fn(&str) -> bool) -> String {
    if !x.enabled {
        return "off".into();
    }
    let need = missing(x, has);
    if !need.is_empty() {
        let names: Vec<&str> = need.iter().map(|k| k.split_once(':').map_or(k.as_str(), |(_, n)| n)).collect();
        return format!("needs {} from the user (wisp_connector_signin)", names.join(", "));
    }
    match &x.test {
        Some(t) if t.ok => {
            let n = t.count.unwrap_or(0);
            let tools = t.tools.as_deref().unwrap_or_default();
            let shown = if tools.is_empty() { String::new() } else { format!(" ({}{})", tools.iter().take(8).cloned().collect::<Vec<_>>().join(", "), if n > 8 { ", …" } else { "" }) };
            format!("works: {n} tool{}{shown}", plural(n))
        }
        Some(t) if t.auth => "needs the user to sign in (wisp_connector_signin)".into(),
        Some(t) => format!("fails: {}", t.error.as_deref().unwrap_or("")),
        None if x.oauth.is_some() && has("oauth:access") => "signed in, not checked yet".into(),
        None => "not checked yet".into(),
    }
}

pub fn line(x: &Connector, has: &dyn Fn(&str) -> bool) -> String {
    let what = match x.transport {
        Transport::Local => {
            let mut parts = vec![x.command.clone().unwrap_or_default()];
            parts.extend(x.args.iter().flatten().cloned());
            format!("local: `{}`", parts.join(" "))
        }
        Transport::Remote => format!("remote: {}", x.url.as_deref().unwrap_or("")),
    };
    let signed = if x.oauth.is_some() { " · signed in" } else { "" };
    format!("- **{}** · {what}{signed} · {}", x.name, state(x, has))
}

/// `wisp_connectors`
pub fn list_text(all: &[Connector], has: &dyn Fn(&str, &str) -> bool) -> String {
    if all.is_empty() {
        return NONE_YET.into();
    }
    let lines: Vec<String> = all.iter().map(|x| line(x, &|k| has(&x.id, k))).collect();
    format!("The user's connectors (MCP servers every task gets; not in Plan mode, not Cursor or Antigravity):\n\n{}", lines.join("\n"))
}

/// The refusals before anything changes: a capped task, then a delegated one.
pub fn may_change(s: &Asker) -> Result<()> {
    if s.capped {
        return Err(ConnectorError::Forbidden(capped_refusal()));
    }
    if s.delegated {
        return Err(ConnectorError::Forbidden(ONLY_THE_USER.into()));
    }
    Ok(())
}

fn names(field: &str, v: Option<&Value>) -> Result<Option<SecretInput>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        // Names only: a value here would sit in this task's transcript.
        Some(Value::Array(a)) => Ok(Some(SecretInput::List(a.iter().map(|k| SecretField { key: k.as_str().map_or_else(|| k.to_string(), str::to_owned), value: Value::Null }).collect()))),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(_) => Err(ConnectorError::invalid(format!(
            "{field}: give the names only, like [\"API_KEY\"]. The user types the values on the card wisp_connector_signin shows, so they never pass through you."
        ))),
    }
}

/// `wisp_connector_add`'s args as a body with key names and no values.
pub fn add_body(a: &AgentAddArgs) -> Result<ConnectorBody> {
    Ok(ConnectorBody {
        name: a.name.clone(),
        transport: a.transport.clone(),
        command: a.command.clone(),
        args: a.args.clone(),
        url: a.url.clone(),
        env: Some(names("env", a.env.as_ref())?.unwrap_or(SecretInput::List(Vec::new()))),
        headers: Some(names("headers", a.headers.as_ref())?.unwrap_or(SecretInput::List(Vec::new()))),
        enabled: None,
    })
}

pub fn added_text(x: &Connector, has: &dyn Fn(&str) -> bool) -> String {
    let next = if state(x, has).contains("needs") { "Next: call wisp_connector_signin so the user can sign in or give the keys." } else { READY };
    format!("Added {} to the user's connectors (Settings → Connectors).\n\n{}\n\n{next}", x.name, line(x, has))
}

/// The connector an agent names, by name or id.
pub fn named<'a>(all: &'a [Connector], name: &str) -> Result<&'a Connector> {
    let want = name.trim().to_lowercase();
    all.iter().find(|y| y.name == want || y.id == want).ok_or_else(|| ConnectorError::invalid(format!("No connector called “{name}”. List them with wisp_connectors.")))
}

/// What `wisp_connector_signin` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signin {
    Text(String),
    Ask(SigninAsk),
}

/// A card in the task: Sign in (OAuth) or a box per key; the MCP server waits on it like `ask_user`.
pub fn signin(x: &Connector, why: &str, has: &dyn Fn(&str) -> bool) -> Signin {
    let keys = missing(x, has);
    let works = x.test.as_ref().is_some_and(|t| t.ok);
    if keys.is_empty() && works {
        return Signin::Text(format!("{} already works: {}. {READY}", x.name, state(x, has)));
    }
    if keys.is_empty() && x.transport == Transport::Local {
        return Signin::Text(format!("{} has no keys to ask for, and {}. Check its command with the user.", x.name, state(x, has)));
    }
    let kind = if keys.is_empty() { AskKind::Signin } else { AskKind::Keys };
    let names: Vec<&str> = keys.iter().map(|k| k.split_once(':').map_or(k.as_str(), |(_, n)| n)).collect();
    let all = x.env.iter().map(|k| (k, KeyField::Env, "env")).chain(x.headers.iter().map(|k| (k, KeyField::Headers, "header")));
    let ask_keys = all.map(|(key, field, prefix)| AskKey { key: key.clone(), field, set: !keys.contains(&format!("{prefix}:{key}")) }).collect();
    Signin::Ask(SigninAsk {
        question: if kind == AskKind::Signin { format!("Sign in to {}", x.name) } else { format!("{} needs {}", x.name, names.join(" and ")) },
        context: why.chars().take(400).collect(),
        options: vec!["Skip".into()],
        connector: AskConnector { id: x.id.clone(), name: x.name.clone(), kind, keys: ask_keys },
    })
}

/// The text that answers a waiting card once the connector works.
pub fn works_text(name: &str, count: u32) -> String {
    format!("Done: {name} works ({count} tool{})", plural(count))
}
