//! v1's HTTP routes for harness accounts, sign-in and keys (server/routes/meta.js), each the command
//! the UI calls with the body plus the ids the path names. `:id` is a harness here, never a task.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Setup, WireError};

/// How a route's request becomes its command's args.
type Shape = fn(&Request) -> Result<Value, WireError>;

fn agent(req: &Request) -> String {
    req.param("id").unwrap_or_default().to_owned()
}

fn body(req: &Request) -> Result<Value, WireError> {
    if req.body.is_empty() { Ok(json!({})) } else { req.json::<Value>() }
}

/// The body with the path's ids over it.
fn with(req: &Request, extra: &[(&str, Value)]) -> Result<Value, WireError> {
    let mut v = body(req)?;
    if let Some(o) = v.as_object_mut() {
        o.insert("agent".into(), json!(agent(req)));
        for (k, x) in extra {
            o.insert((*k).into(), x.clone());
        }
    }
    Ok(v)
}

fn acc(req: &Request) -> Value {
    json!(req.param("acc").or_else(|| req.query("account")).unwrap_or_default())
}

fn add(s: &mut Setup, method: &'static str, pattern: &'static str, permission: &'static str, summary: &'static str, cmd: &'static str, shape: Shape) {
    s.route(Route {
        method,
        pattern,
        permission,
        doc: true,
        summary,
        raw: false,
        max_body: None,
        handler: Arc::new(move |ctx, call, req| {
            Box::pin(async move {
                let args = shape(&req)?;
                Response::ok(ctx.run_json(&call, cmd, args).await?)
            })
        }),
    });
}

pub(crate) fn register(s: &mut Setup) {
    add(s, "GET", "/agents/:id/accounts", "accounts:read", "A harness's accounts", "accounts.list", |r| with(r, &[]));
    add(s, "POST", "/agents/:id/accounts", "accounts:write", "Add another account (its sign-in starts at once)", "accounts.add", |r| with(r, &[]));
    add(s, "PATCH", "/agents/:id/accounts/:acc", "accounts:write", "Rename an account, set its kind or move it", "accounts.update", |r| with(r, &[("account", acc(r))]));
    add(s, "DELETE", "/agents/:id/accounts/:acc", "accounts:write", "Sign an account out and forget it", "accounts.remove", |r| with(r, &[("account", acc(r))]));
    add(s, "POST", "/agents/:id/trust", "accounts:write", "Trust this version of a harness's program", "accounts.watch.trust", |r| with(r, &[]));
    add(s, "GET", "/agents/:id/login", "accounts:read", "A sign-in as it stands", "accounts.login", |r| with(r, &[("account", acc(r))]));
    add(s, "POST", "/agents/:id/login", "accounts:login", "Sign in with the CLI's own login", "accounts.login.start", |r| with(r, &[("account", acc(r))]));
    add(s, "POST", "/agents/:id/login/input", "accounts:login", "Paste back the code the sign-in page showed", "accounts.login.input", |r| with(r, &[("account", acc(r))]));
    add(s, "DELETE", "/agents/:id/login", "accounts:login", "Stop a sign-in", "accounts.login.cancel", |r| with(r, &[("account", acc(r))]));
    add(s, "POST", "/agents/:id/logout", "accounts:login", "Sign the harness out (its own sign-out)", "accounts.logout", |r| with(r, &[("account", acc(r))]));
    add(s, "GET", "/agents/:id/keys", "accounts:read", "Which providers have an API key (never the key)", "accounts.keys", |r| with(r, &[]));
    add(s, "POST", "/agents/:id/keys", "accounts:keys", "Save a provider's API key where the CLI keeps it", "accounts.keys.set", |r| with(r, &[]));
    add(s, "DELETE", "/agents/:id/keys/:provider", "accounts:keys", "Remove a provider's API key", "accounts.keys.remove", |r| with(r, &[("provider", json!(r.param("provider").unwrap_or_default()))]));
    add(s, "POST", "/agents/install", "accounts:write", "Install a harness wisp can install itself (opencode)", "accounts.install", |r| {
        let b = body(r)?;
        Ok(json!({ "agent": b.get("id").or_else(|| b.get("agent")).cloned().unwrap_or(Value::Null) }))
    });
    add(s, "POST", "/agents/recheck", "accounts:read", "Detect every harness and its models again", "accounts.recheck", |_| Ok(Value::Null));
}
