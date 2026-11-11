//! Routes on the edge (v1 grid/server.js `/_route/<token>`, `/api/channels/route`, `/api/channels/reply`):
//!
//! - `POST <domain>/_route/<token>`: the routing bot's webhook. Its secret header checked (constant time); the
//!   update decided before the 200 (`Routes::take`), what's left done after it.
//! - `GET | PUT {token, senders} | DELETE /api/channels/route`: the account page's, from a session only (never a
//!   box, never a device: the bot is the person's own).
//! - `POST /api/channels/reply {thread, text}`: a computer's report, from that computer's device token.

use std::sync::Arc;

use http::{HeaderMap, Method};
use serde_json::{Value, json};

use super::{Grid, Who};
use crate::error::{Result, bad};
use crate::http::{Resp, header_str, json, parse_body};
use crate::trust::Credential;

/// A computer, through its tunnel, marked as a routed message.
pub struct TunnelComputers(pub Arc<crate::tunnels::Tunnels>);

#[async_trait::async_trait]
impl crate::route::Computers for TunnelComputers {
    async fn routed(&self, computer: &str, body: Value) -> std::result::Result<Option<(u16, Value)>, String> {
        if !self.0.online(computer) {
            return Ok(None);
        }
        let opts = crate::tunnels::AskOptions { method: "POST".into(), path: "/api/channels/routed".into(), headers: vec![("content-type".into(), "application/json".into()), (crate::route::ROUTE_MARK.into(), "grid".into())], body: Some(body.to_string().into()), timeout_ms: Some(30_000) };
        let a = self.0.ask(computer, opts).await.map_err(|e| e.to_string())?;
        Ok(Some((a.status, serde_json::from_slice(&a.body).unwrap_or(Value::Null))))
    }
}

impl Grid {
    /// `<domain>/_route/<token>`.
    pub(super) fn route_in(self: &Arc<Self>, h: &HeaderMap, tok: &str, bytes: &[u8]) -> Result<Resp> {
        let secret = header_str(h, "x-telegram-bot-api-secret-token");
        let (uid, b) = match self.routes.check(tok, secret)? {
            None => return Ok(json(404, &json!({ "error": "not found" }))),
            Some(Err(())) => return Ok(json(401, &json!({ "error": "bad secret" }))),
            Some(Ok(x)) => x,
        };
        let Some(user) = self.accounts.user_by_id(&uid)?.filter(|u| u.disabled == 0) else { return Ok(json(404, &json!({ "error": "not found" }))) };
        let u: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
        let computers = self.accounts.computers(&user.id)?;
        let next = self.routes.take(&user, &b, &u, &computers, &|k| self.inbox.first(&user.id, k))?;
        if let Some(n) = next {
            let name = match &n {
                crate::route::Next::Forward { computer, .. } => computers.iter().find(|c| c.id == *computer).map_or_else(String::new, |c| c.name.clone()),
                crate::route::Next::Say { .. } => String::new(),
            };
            let g = self.clone();
            tokio::spawn(async move {
                if let Err(e) = g.routes.run(&user.id, &b, n, &name).await {
                    tracing::warn!("grid: route for {}: {e}", user.handle);
                }
            });
        }
        Ok(json(200, &json!({})))
    }

    /// `/api/channels/route` and `/api/channels/reply`.
    #[allow(clippy::many_single_char_names)] // h headers, u user, d device, b body, s a field, c computer
    pub(super) async fn route_api(&self, method: &Method, which: &str, h: &HeaderMap, bytes: &[u8], who: &Who) -> Result<Resp> {
        match (method.as_str(), which, who) {
            ("GET", "route", Who::Session(u)) => Ok(json(200, &self.routes.view(&u.id)?)),
            ("PUT", "route", Who::Session(u)) => {
                let b = parse_body(h, bytes)?;
                let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                let name = self.routes.set(u, &s("token"), &s("senders")).await?;
                Ok(json(200, &json!({ "ok": true, "bot": name })))
            }
            ("DELETE", "route", Who::Session(u)) => {
                self.routes.remove(u).await?;
                Ok(json(200, &json!({ "ok": true })))
            }
            (_, "route", _) => Err(bad("Set up routing on your account page.", 403)),
            ("POST", "reply", Who::Device(u, d)) => {
                let c = self.accounts.computers(&u.id)?.into_iter().find(|c| c.device_id == d.id).ok_or_else(|| bad("No such thread.", 404))?;
                let b = parse_body(h, bytes)?;
                let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                self.routes.reply(u, &c, &s("thread"), &s("text")).await?;
                Ok(json(200, &json!({ "ok": true })))
            }
            (_, "reply", w) if w.credential() != Some(Credential::Device) => Err(bad("Only the computer the message went to reports on it.", 403)),
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }
}
