//! The inbox on the edge (v1 grid/server.js `/_in/<token>`, `/api/channels/url`, `/api/channels/rotate`):
//!
//! - `POST <handle>.<domain>/_in/<token>`: a channel's webhook. 200 at once (held; the box is woken and it's
//!   delivered behind the answer), or the box's own answer to a live request. A token for another user's address,
//!   or none, is 404; the inbox switched off is 404 too.
//! - `GET /api/channels/url?channel=` and `POST /api/channels/rotate {channel}`: the box's own URL, from the box
//!   (`Box <handle> <secret>`) or its owner.

use std::sync::Arc;

use http::Method;
use hyper::body::Incoming;
use serde_json::{Value, json};

use super::{Grid, Who, no, query};
use crate::error::{Result, bad};
use crate::http::{Resp, json, parse_body, read_bytes};
use crate::rows::UserRow;
use crate::trust::{Reach, may};

impl Grid {
    /// Deliver what's held for `user`, behind the answer: tried again when the inbox says, until it's all in.
    pub(super) fn drain_later(self: &Arc<Self>, user: UserRow) {
        let g = self.clone();
        tokio::spawn(async move {
            while let Ok(Some(ms)) = g.inbox.drain(&user).await {
                tokio::time::sleep(std::time::Duration::from_millis(u64::try_from(ms.max(50)).unwrap_or(50))).await;
            }
        });
    }

    /// `<handle>.<domain>/_in/<token>`.
    pub(super) async fn inbox_in(self: &Arc<Self>, req: http::Request<Incoming>, handle: &str, tok: &str) -> Result<Resp> {
        if !self.inbox.opts.enabled || req.method() != Method::POST {
            return Ok(json(404, &json!({ "error": "not found" })));
        }
        let Some((uid, ch)) = self.inbox.by_token(tok)? else { return Ok(json(404, &json!({ "error": "not found" }))) };
        let Some(user) = self.accounts.user_by_id(&uid)?.filter(|u| u.handle == handle && u.disabled == 0) else { return Ok(json(404, &json!({ "error": "not found" }))) };
        let headers: Vec<(String, String)> = req.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))).collect();
        // over the cap: dropped and counted, still a 200 (a retry storm from the sender helps nobody)
        let body = read_bytes(req.into_body(), crate::inbox::BODY_MAX).await.ok();
        let answer = self.inbox.accept(&user, &ch, &headers, body.as_deref()).await?;
        self.drain_later(user);
        Ok(match answer {
            Some((status, v)) => json(status, &v),
            None => json(200, &json!({})),
        })
    }

    /// `/api/channels/url`, `/api/channels/rotate`.
    pub(super) fn channels_route(&self, method: &Method, which: &str, q: &str, h: &http::HeaderMap, bytes: &[u8], who: &Who) -> Result<Resp> {
        let cred = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
        if let Some(r) = no(&may(cred, Reach::GridChannels)) {
            return Ok(r);
        }
        let user = who.user().cloned().ok_or_else(|| bad("Sign in first.", 401))?;
        if !self.inbox.opts.enabled {
            return Err(bad("This grid doesn’t hold channels for boxes.", 404));
        }
        let ch = |b: Option<&Value>| b.and_then(Value::as_str).map(str::to_owned).or_else(|| query(q, "channel")).unwrap_or_default();
        match (method.as_str(), which) {
            ("GET", "url") if ch(None) == "email" => self.mail_address(&user, false),
            ("GET", "url") => Ok(json(200, &self.inbox.url_for(&user, &ch(None))?)),
            ("POST", "rotate") => {
                let b = parse_body(h, bytes)?;
                if ch(b.get("channel")) == "email" {
                    return self.mail_address(&user, true);
                }
                Ok(json(200, &self.inbox.rotate(&user, &ch(b.get("channel")))?))
            }
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }
}
