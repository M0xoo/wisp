//! Sandboxes on the edge (v1 grid/server.js `/api/sandboxes…` and the `sb-<id>--<handle>` address):
//!
//! - `GET /api/sandboxes`: whether this grid makes them, the sign-ins and env names they start with, and the list;
//! - `POST /api/sandboxes {name}` → 201 `{id, name, url, token}` (the token is said once; wisp keeps it as the peer's);
//! - `DELETE /api/sandboxes/<id>`: its box and home (hostd → boxd), then its row and token;
//! - `PUT|DELETE /api/sandboxes/logins/<agent>`, `PUT /api/sandboxes/env {key, value}`, `DELETE /api/sandboxes/env/<key>`.
//!
//! From wisp on a computer (its device token) or the grid's pages (a session); never from a sandbox.

use http::{HeaderMap, Method};
use hyper::body::Incoming;
use serde_json::{Value, json};

use super::{Grid, Who, no};
use crate::boxhost::BoxHost as _;
use crate::error::{Result, bad};
use crate::http::{Resp, header_str, json, parse_body};
use crate::rows::SandboxRow;
use crate::sandboxes::Sandboxes;
use crate::trust::{Credential, Reach, may};

impl Grid {
    /// `sb-<id>--<handle>.<domain>`: the sandbox's own token, or its owner (their session or device).
    pub(super) async fn sandbox_reach(&self, req: http::Request<Incoming>, sb: &SandboxRow) -> Result<Resp> {
        let auth = header_str(req.headers(), "authorization").to_owned();
        let own = self.sandboxes.by_bearer(&auth).is_some_and(|r| r.id == sb.id);
        if !own {
            let who = self.who(req.headers());
            let cred = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
            if let Some(r) = no(&may(cred, Reach::Sandbox)).filter(|_| cred != Credential::Session) {
                return Ok(r);
            }
            if who.user().is_none_or(|u| u.id != sb.user_id) {
                return Err(bad("That sandbox isn't yours.", 403));
            }
        }
        self.proxy(req, &Sandboxes::box_user(sb), &sb.label).await
    }

    fn sandbox_view(&self, row: &SandboxRow) -> Value {
        Sandboxes::view(row, &self.cfg.instance_url(&row.label))
    }

    /// `/api/sandboxes…`
    pub(super) async fn sandboxes_route(&self, method: &Method, parts: &[&str], h: &HeaderMap, bytes: &[u8], who: &Who) -> Result<Resp> {
        let user = match who {
            Who::Device(u, _) | Who::Session(u) => u.clone(),
            Who::Box => return Err(bad("A box asks for sandboxes through its owner's wisp.", 403)),
            Who::Nobody => return Err(bad("Sign in first.", 401)),
        };
        let body = || parse_body(h, bytes);
        let s = &self.sandboxes;
        match (method.as_str(), parts) {
            ("GET", ["api", "sandboxes"]) => {
                let list: Vec<Value> = s.list(&user.id)?.iter().map(|r| self.sandbox_view(r)).collect();
                Ok(json(200, &json!({ "enabled": s.enabled && s.secrets.is_some(), "logins": s.logins(&user.id), "env": s.env_keys(&user.id), "sandboxes": list })))
            }
            ("POST", ["api", "sandboxes"]) => {
                let b = body()?;
                let taken = |label: &str| self.accounts.computer_by_label(label).ok().flatten().is_some() || self.accounts.user_by_handle(label).ok().flatten().is_some();
                let (row, token) = s.create(&user, b.get("name").and_then(Value::as_str).unwrap_or_default(), &taken)?;
                tracing::info!("grid: {} made sandbox {}", user.handle, row.id);
                let mut v = self.sandbox_view(&row);
                v["token"] = json!(token);
                Ok(json(201, &v))
            }
            ("DELETE", ["api", "sandboxes", id]) => {
                let row = s.get(id)?.filter(|r| r.user_id == user.id).ok_or_else(|| bad("There's no such sandbox of yours.", 404))?;
                self.boxes.remove(&Sandboxes::box_user(&row)).await?;
                s.remove(&row)?;
                Ok(json(200, &json!({ "ok": true })))
            }
            ("PUT", ["api", "sandboxes", "logins", agent]) => {
                let b = body()?;
                s.set_login(&user.id, agent, b.get("token").and_then(Value::as_str).unwrap_or_default())?;
                Ok(json(200, &json!({ "logins": s.logins(&user.id) })))
            }
            ("DELETE", ["api", "sandboxes", "logins", agent]) => {
                s.drop_login(&user.id, agent)?;
                Ok(json(200, &json!({ "logins": s.logins(&user.id) })))
            }
            ("PUT" | "POST", ["api", "sandboxes", "env"]) => {
                let b = body()?;
                let f = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                s.set_env(&user.id, &f("key"), &f("value"))?;
                Ok(json(200, &json!({ "env": s.env_keys(&user.id) })))
            }
            ("DELETE", ["api", "sandboxes", "env", key]) => {
                s.drop_env(&user.id, key)?;
                Ok(json(200, &json!({ "env": s.env_keys(&user.id) })))
            }
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }
}
