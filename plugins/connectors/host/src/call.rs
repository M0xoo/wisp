//! `connectors.call` (v1 connectors.js `mcpCall`): one tool of a remote connector, called by wisp itself over
//! streamable HTTP (`initialize`, `notifications/initialized`, `tools/call`, with the server's session), with
//! the connector's headers and its sign-in. Its token never leaves wisp. A JSON-RPC error or a tool's `isError`
//! comes back as the server's own words. A connector wisp starts itself (stdio) isn't called here yet.
//!
//! Also `issues.connectors@1`: the connectors with their secrets revealed and whether each is signed in, for
//! the issue picker (Linear's API key, Jira's site and token, or a signed-in server's tools).

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_connectors_api::{CallArgs, CallOut, secrets_ns};
use wisp_connectors_core::rpc::{Sse, initialize};
use wisp_kernel::services::{NetRequest, NetResponse, net, secrets};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup, WireError};
use wisp_resources_api::StoredKind;

use crate::kinds::ConnectorSpec;

async fn specs(kind: &StoredKind) -> Vec<(String, ConnectorSpec)> {
    kind.specs().await.unwrap_or_default().into_iter().filter_map(|(n, v)| Some((n, serde_json::from_value(v).ok()?))).collect()
}

/// The stored OAuth token, when it signed in with the browser.
async fn token(ctx: &Ctx, id: &str) -> Option<String> {
    secrets(ctx).ok()?.get(&format!("{}:token", secrets_ns(id))).await.ok().flatten().filter(|t| !t.is_empty())
}

/// The JSON-RPC answer in a reply: the body, or the event of an SSE stream that carries an id.
fn answer(r: &NetResponse) -> Option<Value> {
    let text = if r.header("content-type").is_some_and(|t| t.contains("text/event-stream")) {
        Sse::default().push(&r.body).into_iter().map(|e| e.data).find(|d| d.contains("\"id\""))?
    } else {
        String::from_utf8_lossy(&r.body).into_owned()
    };
    serde_json::from_str(&text).ok()
}

/// What a JSON-RPC answer or a tool result says went wrong, in the server's words.
pub fn refusal_of(v: &Value) -> Option<String> {
    if let Some(e) = v.get("error") {
        return Some(e.get("message").and_then(Value::as_str).unwrap_or("It refused").chars().take(300).collect());
    }
    let r = v.get("result")?;
    if r.get("isError") == Some(&Value::Bool(true)) {
        let text: Vec<&str> = r
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect();
        let t = text.join(" ");
        return Some(if t.trim().is_empty() { "The tool failed".to_owned() } else { t.trim().chars().take(300).collect() });
    }
    None
}

async fn post(ctx: &Ctx, url: &str, headers: &[(String, String)], session: Option<&str>, body: &Value) -> Result<NetResponse> {
    let n = net(ctx)?;
    let mut h = headers.to_vec();
    if let Some(s) = session {
        h.push(("mcp-session-id".into(), s.to_owned()));
    }
    let r = n
        .fetch(NetRequest {
            method: "POST".into(),
            url: url.to_owned(),
            headers: h,
            body: body.to_string().into_bytes(),
            timeout_ms: 60_000,
        })
        .await?;
    match r.status {
        401 | 403 => Err(WireError::forbidden(format!("needs sign-in (HTTP {})", r.status))),
        s if s >= 400 => Err(WireError::unavailable(format!("HTTP {s}"))),
        _ => Ok(r),
    }
}

pub async fn call(ctx: &Ctx, kind: &StoredKind, a: &CallArgs) -> Result<CallOut> {
    let Some((_, mut c)) = specs(kind).await.into_iter().find(|(n, _)| *n == a.id) else {
        return Err(WireError::not_found(format!("No connector called {}", a.id)));
    };
    if c.url.is_empty() {
        return Err(WireError::invalid(format!("{} runs on this computer: wisp calls only remote connectors' tools", a.id)));
    }
    for v in c.headers.values_mut() {
        *v = crate::kinds::reveal(ctx, v).await;
    }
    let mut headers: Vec<(String, String)> = c.headers.into_iter().collect();
    if c.oauth == Some(true)
        && let Some(t) = token(ctx, &a.id).await
    {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        headers.push(("Authorization".into(), format!("Bearer {t}")));
    }
    headers.push(("content-type".into(), "application/json".into()));
    headers.push(("accept".into(), "application/json, text/event-stream".into()));
    let init: Value = serde_json::from_str(&initialize(env!("CARGO_PKG_VERSION"))).unwrap_or_default();
    let r = post(ctx, &c.url, &headers, None, &init).await?;
    let session = r.header("mcp-session-id").map(str::to_owned);
    if let Some(why) = answer(&r).as_ref().and_then(refusal_of) {
        return Err(WireError::unavailable(why));
    }
    let _ = post(ctx, &c.url, &headers, session.as_deref(), &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    let args = if a.args.is_null() { json!({}) } else { a.args.clone() };
    let r = post(
        ctx,
        &c.url,
        &headers,
        session.as_deref(),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": a.tool, "arguments": args } }),
    )
    .await?;
    let v = answer(&r).ok_or_else(|| WireError::unavailable(format!("{} didn't answer {}", a.id, a.tool)))?;
    if let Some(why) = refusal_of(&v) {
        return Err(WireError::unavailable(why));
    }
    Ok(CallOut { result: v.get("result").cloned().unwrap_or(Value::Null) })
}

/// The connectors as the issue picker reads them.
struct ForIssues {
    kind: Arc<StoredKind>,
    ctx: Ctx,
}

impl wisp_issues_api::Connectors for ForIssues {
    fn connectors(&self, _call: &Call) -> BoxFuture<'static, Result<Vec<wisp_issues_api::Connector>>> {
        let (kind, ctx) = (self.kind.clone(), self.ctx.clone());
        Box::pin(async move {
            let mut out = Vec::new();
            for (id, c) in specs(&kind).await {
                let mut env = Vec::new();
                for (k, v) in &c.env {
                    env.push((k.clone(), crate::kinds::reveal(&ctx, v).await));
                }
                let mut headers = Vec::new();
                for (k, v) in &c.headers {
                    headers.push((k.clone(), crate::kinds::reveal(&ctx, v).await));
                }
                let signed_in = c.oauth == Some(true) && token(&ctx, &id).await.is_some();
                out.push(wisp_issues_api::Connector {
                    name: id.clone(),
                    id,
                    url: c.url,
                    command: c.command,
                    args: c.args,
                    enabled: c.enabled != Some(false),
                    env,
                    headers,
                    signed_in,
                });
            }
            Ok(out)
        })
    }
}

pub(crate) fn register(s: &mut Setup, kind: Arc<StoredKind>) {
    let k = kind.clone();
    s.command::<wisp_connectors_api::Call, _, _>(move |ctx, _call, a| {
        let kind = k.clone();
        async move { call(&ctx, &kind, &a).await }
    });
    let issues: Arc<dyn wisp_issues_api::Connectors> = Arc::new(ForIssues { kind, ctx: s.ctx() });
    s.contribute(&wisp_issues_api::CONNECTORS, issues);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_servers_refusal_is_said_in_its_own_words() {
        assert_eq!(refusal_of(&json!({ "error": { "message": "Unknown tool" } })).as_deref(), Some("Unknown tool"));
        let failed = json!({ "result": { "isError": true, "content": [{ "type": "text", "text": "Not authorized" }] } });
        assert_eq!(refusal_of(&failed).as_deref(), Some("Not authorized"));
        assert_eq!(refusal_of(&json!({ "result": { "content": [] } })), None);
    }
}
