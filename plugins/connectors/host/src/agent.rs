//! The agent's tools over the user's connectors (v1 routes/connectors.js `/internal/connectors/:sid`, run by
//! wisp.mcp's `wisp_connectors`, `wisp_connector_add`, `wisp_connector_signin`): the words are core's
//! (`wisp_connectors_core::agent`), the connectors the pane's. An agent speaks only for its own task; only a task
//! the user started changes connectors (not a subagent, not a crew member's job); a capped task is refused by its
//! capability set before it gets here, and again here in v1's words.
//!
//! `wisp_connector_signin` can't open v1's card yet (no task view renders a connector's Sign in button or key
//! boxes, and the MCP tool doesn't wait on a card): it answers what the card would have asked, and sends the user
//! to Settings → Connectors.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value;
use wisp_connectors_api::{
    self as api, AgentAddArgs, AgentSigninArgs, AgentSigninOut, AgentText, AskKind, Connector, SecretInput, SigninAsk, Transport,
};
use wisp_connectors_core::agent::{self as words, Asker, Signin};
use wisp_connectors_core::error::ConnectorError;
use wisp_connectors_core::text::slug;
use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_runtime_api::commands as rt;

use crate::pane::{Pane, lock};

/// A connector as the words read it, and which of its slots have a value (`env:K`, `header:K`, `oauth:access`).
type Seen = Vec<(Connector, BTreeSet<String>)>;

pub(crate) fn register(s: &mut Setup, pane: &Arc<Pane>) {
    let p = pane.clone();
    s.command::<api::AgentList, _, _>(move |ctx, call, a| {
        let p = p.clone();
        async move { list(&p, &ctx, &call, a.sid.as_deref()).await }
    });
    let p = pane.clone();
    s.command::<api::AgentAdd, _, _>(move |ctx, call, a| {
        let p = p.clone();
        async move { add(&p, &ctx, &call, a).await }
    });
    let p = pane.clone();
    s.command::<api::AgentSignin, _, _>(move |ctx, call, a| {
        let p = p.clone();
        async move { signin(&p, &ctx, &call, &a).await }
    });
}

/// The task the agent speaks for: its token's own (naming another is refused), or `sid` for the user and kernel.
fn session_of(call: &Call, sid: Option<&str>) -> Result<String> {
    match (call.caller().session.as_deref(), sid.filter(|s| !s.is_empty())) {
        (Some(own), Some(s)) if own != s => Err(WireError::forbidden("An agent speaks only for its own task")),
        (Some(own), _) => Ok(own.to_owned()),
        (None, Some(s)) => Ok(s.to_owned()),
        (None, None) => Err(WireError::invalid("Which task? Give its session")),
    }
}

/// Who asks: the task's harness, whether it was delegated (a subagent or a crew member's job), whether capped.
async fn asker(ctx: &Ctx, call: &Call, sid: Option<&str>) -> Result<Asker> {
    let id = session_of(call, sid)?;
    let s = ctx.run::<rt::Get>(call, rt::IdArgs { id: id.as_str().into() }).await?;
    let crew = s.ext_of("wisp.crew").get("id").and_then(Value::as_str).is_some();
    Ok(Asker { agent: s.agent.clone(), delegated: s.parent_id.is_some() || crew, capped: call.caller().set.starts_with("agent:capped") })
}

async fn seen(p: &Pane, ctx: &Ctx) -> Seen {
    let tests = lock(&p.tests).clone();
    let mut out = Vec::new();
    for (n, c) in p.specs().await {
        let oauth = Pane::oauth_of(ctx, &n).await.filter(|o| o.signed_in_at.is_some());
        let set = |m: &std::collections::BTreeMap<String, String>, prefix: &str| -> Vec<String> {
            m.iter().filter(|(_, v)| !v.is_empty()).map(|(k, _)| format!("{prefix}:{k}")).collect()
        };
        let mut has: BTreeSet<String> = set(&c.env, "env").into_iter().chain(set(&c.headers, "header")).collect();
        if oauth.is_some() {
            has.insert("oauth:access".into());
        }
        let x = Connector {
            id: n.clone(),
            name: n.clone(),
            transport: if c.url.is_empty() { Transport::Local } else { Transport::Remote },
            command: (!c.command.is_empty()).then(|| c.command.clone()),
            args: Some(c.args.clone()),
            url: (!c.url.is_empty()).then(|| c.url.clone()),
            env: c.env.keys().cloned().collect(),
            headers: c.headers.keys().cloned().collect(),
            enabled: c.enabled != Some(false),
            added_at: 0,
            test: tests.get(&n).cloned(),
            oauth,
        };
        out.push((x, has));
    }
    out
}

fn has_in<'a>(all: &'a Seen, id: &'a str) -> impl Fn(&str) -> bool + 'a {
    move |k| all.iter().any(|(x, h)| x.id == id && h.contains(k))
}

/// `wisp_connectors`
async fn list(p: &Pane, ctx: &Ctx, call: &Call, sid: Option<&str>) -> Result<AgentText> {
    if asker(ctx, call, sid).await?.capped {
        return Err(ConnectorError::Forbidden(words::capped_refusal()).into());
    }
    let all = seen(p, ctx).await;
    let xs: Vec<Connector> = all.iter().map(|(x, _)| x.clone()).collect();
    Ok(AgentText { text: words::list_text(&xs, &|id, k| has_in(&all, id)(k)) })
}

fn key_names(i: Option<&SecretInput>) -> Vec<String> {
    match i {
        Some(SecretInput::List(l)) => l.iter().map(|f| f.key.trim().to_owned()).filter(|k| !k.is_empty()).collect(),
        Some(SecretInput::Map(m)) => m.keys().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()).collect(),
        None => Vec::new(),
    }
}

/// `wisp_connector_add`: key names only, the values left for the user; checked at once when nothing is missing.
async fn add(p: &Arc<Pane>, ctx: &Ctx, call: &Call, a: AgentAddArgs) -> Result<AgentText> {
    let who = asker(ctx, call, a.sid.as_deref()).await?;
    words::may_change(&who)?;
    let mut body = words::add_body(&a)?;
    let name = slug(body.name.as_deref().unwrap_or_default());
    if name.is_empty() {
        return Err(WireError::invalid("Give it a name"));
    }
    body.name = Some(name);
    let remote = body.transport.as_deref().map_or_else(|| a.url.as_deref().is_some_and(|u| !u.is_empty()), |t| t == "remote");
    body.transport = Some(if remote { "remote" } else { "local" }.into());
    let (env, headers) = (key_names(body.env.as_ref()), key_names(body.headers.as_ref()));
    // a declared key without a value: the pane shows it unset, the card (or Settings) asks for it
    let name = p
        .create(ctx, &body, |spec| {
            let (keys, into) = if remote { (headers, &mut spec.headers) } else { (env, &mut spec.env) };
            for k in keys {
                into.entry(k).or_default();
            }
        })
        .await?;
    let transport = if remote { Transport::Remote } else { Transport::Local };
    ctx.emit(call, &api::AgentAdded { agent: who.agent, transport });
    let all = seen(p, ctx).await;
    let missing = all.iter().find(|(x, _)| x.id == name).is_some_and(|(x, h)| x.env.len() + x.headers.len() > h.len());
    // with keys still to fill in, a check would only fail
    if missing {
        p.publish(ctx).await;
    } else if let Err(e) = p.test(ctx, &name).await {
        tracing::debug!(connector = %name, error = %e.message, "connectors: the first check");
    }
    let all = seen(p, ctx).await;
    let (x, _) = all.iter().find(|(x, _)| x.id == name).ok_or_else(|| WireError::internal(format!("{name} isn't stored")))?;
    Ok(AgentText { text: words::added_text(x, &has_in(&all, &name)) })
}

/// `wisp_connector_signin`
async fn signin(p: &Pane, ctx: &Ctx, call: &Call, a: &AgentSigninArgs) -> Result<AgentSigninOut> {
    words::may_change(&asker(ctx, call, a.sid.as_deref()).await?)?;
    let all = seen(p, ctx).await;
    let xs: Vec<Connector> = all.iter().map(|(x, _)| x.clone()).collect();
    let x = words::named(&xs, &a.name)?;
    let text = match words::signin(x, &a.why, &has_in(&all, &x.id)) {
        Signin::Text(text) => text,
        Signin::Ask(ask) => no_card(&ask),
    };
    Ok(AgentSigninOut::Text { text })
}

/// What v1's card asked, sent to Settings → Connectors (the task view has no connector card yet).
pub(crate) fn no_card(ask: &SigninAsk) -> String {
    let c = &ask.connector;
    let what = match c.kind {
        AskKind::Signin => format!("press Sign in on {}", c.name),
        AskKind::Keys => {
            let keys: Vec<&str> = c.keys.iter().filter(|k| !k.set).map(|k| k.key.as_str()).collect();
            format!("type {} on {}", keys.join(" and "), c.name)
        }
    };
    format!(
        "{}. Ask the user to open Settings → Connectors and {what}: the values go straight to wisp, never through you. Then check it with wisp_connectors. {}",
        ask.question,
        words::READY
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use wisp_connectors_api::{AskConnector, AskKey, KeyField};

    /// No card in the task yet: the answer names what it would have asked, and where the user does it.
    #[test]
    fn a_signin_without_a_card_sends_the_user_to_settings() {
        let ask = SigninAsk {
            question: "linear needs Authorization".into(),
            context: String::new(),
            options: vec!["Skip".into()],
            connector: AskConnector {
                id: "linear".into(),
                name: "linear".into(),
                kind: AskKind::Keys,
                keys: vec![
                    AskKey { key: "Authorization".into(), field: KeyField::Headers, set: false },
                    AskKey { key: "X-Org".into(), field: KeyField::Headers, set: true },
                ],
            },
        };
        let t = no_card(&ask);
        assert!(
            t.starts_with("linear needs Authorization. Ask the user to open Settings → Connectors and type Authorization on linear"),
            "{t}"
        );
        assert!(!t.contains("X-Org"), "a key already set isn't asked for: {t}");
    }
}
