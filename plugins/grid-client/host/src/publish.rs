//! `stuff.publish@1` (v1 services/publish.js): an app from My Stuff on your wisp Grid at a public link. My Stuff
//! packs it (`stuff.bundle`, secrets left out); this sends it to the grid signed in to (`PUT /api/sites/<id>`,
//! the device token) and records the link (`stuff.setPublished`). Publishing again updates the same link;
//! unpublishing takes it down and leaves the app in My Stuff.

use std::sync::Arc;

use base64::Engine as _;
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, WireError};
use wisp_stuff_api::{Published, StuffItem, StuffKind};

use crate::net::host_of;
use crate::{Slot, st};

pub(crate) struct Publish {
    pub slot: Slot,
    pub ctx: Ctx,
}

/// A query value or a path segment, percent-encoded (unreserved characters as they are).
fn enc(s: &str) -> String {
    s.bytes().fold(String::new(), |mut out, b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            use std::fmt::Write as _;
            let _ = write!(out, "%{b:02X}");
        }
        out
    })
}

/// The grid's answer as v1 said it: an older grid without sites, a refusal in its words.
pub fn answer(host: &str, method: &str, status: u16, v: &Value) -> std::result::Result<Value, WireError> {
    if status == 404 && method != "DELETE" {
        return Err(WireError::conflict(format!("{host} doesn’t publish apps yet (its wisp Grid is older).")));
    }
    if status == 401 {
        return Err(WireError::conflict("Sign in again to wisp Cloud (Settings → Cloud) to publish apps.".to_owned()));
    }
    // a delete of what's already gone isn't an error: the link is down either way
    if status >= 400 && !(status == 404 && method == "DELETE") {
        return Err(crate::net::refused(status, v));
    }
    Ok(v.clone())
}

fn item(id: &str) -> StuffItem {
    StuffItem { id: id.to_owned(), kind: StuffKind::App, ..StuffItem::default() }
}

impl wisp_stuff_api::commands::Publisher for Publish {
    fn targets(&self, call: &Call) -> Result<Vec<Value>> {
        call.require("stuff:read")?;
        let Ok(s) = st(&self.slot) else { return Ok(Vec::new()) };
        Ok(s.account().map(|a| vec![json!({ "id": "cloud", "host": host_of(&a.grid), "handle": a.handle })]).unwrap_or_default())
    }

    fn publish(&self, call: &Call, id: &str, _opts: Value) -> BoxFuture<'static, Result<StuffItem>> {
        let (slot, ctx, call, id) = (self.slot.clone(), self.ctx.clone(), call.clone(), id.to_owned());
        Box::pin(async move {
            call.require_write("stuff:publish")?;
            let state = st(&slot)?;
            let (acct, token) = state
                .signed_in()
                .await
                .map_err(|_| WireError::conflict("Sign in to a wisp Grid first (Settings → Cloud) to publish apps."))?;
            let bundle = crate::calls::bundle(&ctx, &call, &id).await?;
            let body = base64::engine::general_purpose::STANDARD.decode(&bundle.body).map_err(|e| WireError::internal(e.to_string()))?;
            let or = |v: &str, d: &'static str| if v.is_empty() { d.to_owned() } else { v.to_owned() };
            let (title, entry) = (or(&bundle.title, "App"), or(&bundle.entry, "index.html"));
            let host = host_of(&acct.grid).to_owned();
            let url = format!("{}/api/sites/{}?title={}&entry={}", acct.grid.trim_end_matches('/'), enc(&id), enc(&title), enc(&entry));
            let r = state
                .http
                .put(&url)
                .bearer_auth(&token)
                .header("content-type", "application/octet-stream")
                .body(body)
                .timeout(std::time::Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| WireError::unavailable(format!("Couldn’t reach {host}: {e}")))?;
            let status = r.status().as_u16();
            let v: Value = r.json().await.unwrap_or_else(|_| json!({}));
            let site = answer(&host, "PUT", status, &v)?;
            let now = ctx.clock().map_or(0, |c| c.now_ms());
            let url = site["url"].as_str().ok_or_else(|| WireError::internal(format!("{host} published it but gave no link")))?.to_owned();
            let published =
                Published { url, account: Some("cloud".into()), host: Some(host), handle: Some(acct.handle), rev: None, at: Some(now) };
            crate::calls::set_published(&ctx, &call, &id, Some(published)).await?;
            Ok(item(&id))
        })
    }

    fn unpublish(&self, call: &Call, id: &str) -> BoxFuture<'static, Result<StuffItem>> {
        let (slot, ctx, call, id) = (self.slot.clone(), self.ctx.clone(), call.clone(), id.to_owned());
        Box::pin(async move {
            call.require_write("stuff:publish")?;
            let s = st(&slot)?;
            let Ok((a, token)) = s.signed_in().await else {
                crate::calls::set_published(&ctx, &call, &id, None).await?;
                return Err(WireError::conflict(
                    "You’re signed out of wisp Cloud, so it’s still up there: unpublish it from your account page.",
                ));
            };
            let host = host_of(&a.grid).to_owned();
            let url = format!("{}/api/sites/{}", a.grid.trim_end_matches('/'), enc(&id));
            let (status, v) = crate::net::call(&s.http, "DELETE", &url, Some(&token), None, &[]).await?;
            answer(&host, "DELETE", status, &v)?;
            crate::calls::set_published(&ctx, &call, &id, None).await?;
            Ok(item(&id))
        })
    }
}

pub(crate) fn provide(s: &mut wisp_kernel::Setup, slot: &Slot) {
    let p: Arc<dyn wisp_stuff_api::commands::Publisher> = Arc::new(Publish { slot: slot.clone(), ctx: s.ctx() });
    s.provide::<wisp_stuff_api::commands::PublishService>(p);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grids_answer_says_an_older_grid_a_lost_sign_in_or_its_refusal() {
        assert!(answer("g.test", "PUT", 404, &json!({})).unwrap_err().message.contains("doesn’t publish apps yet"));
        assert!(answer("g.test", "PUT", 401, &json!({})).unwrap_err().message.contains("Sign in again"));
        assert_eq!(
            answer("g.test", "PUT", 400, &json!({ "error": "No index.html in the app." })).unwrap_err().message,
            "No index.html in the app."
        );
        assert_eq!(answer("g.test", "DELETE", 404, &json!({ "ok": false })).unwrap()["ok"], false, "a delete of what's gone is no error");
        assert_eq!(answer("g.test", "PUT", 200, &json!({ "url": "https://x/" })).unwrap()["url"], "https://x/");
    }
}
