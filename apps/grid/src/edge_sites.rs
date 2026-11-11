//! Published apps on the edge (v1 grid/server.js `/api/sites…` and the `<slug>--app--<handle>` address):
//!
//! - `GET /api/sites`: whether this grid publishes apps, its size cap, and yours;
//! - `PUT /api/sites/<key>?title=…&entry=…` with the bundle as the body: publish or update (up to `maxBytes`);
//! - `DELETE /api/sites/<key>`: unpublish (`{ok: false}` when it isn't yours or isn't there).
//!
//! From wisp on a computer (its device token) or the grid's pages (a session). A site's own address answers
//! anyone, with no cookie of the grid's.

use http::Method;
use hyper::body::Incoming;
use serde_json::json;

use super::{Grid, Who, no, query};
use crate::error::{Result, bad};
use crate::http::{Resp, full, json, read_bytes, respond};
use crate::rows::SiteRow;
use crate::trust::{Reach, may};

impl Grid {
    /// `<slug>--app--<handle>.<domain>`: the app's files, for anyone.
    pub(super) fn site_reach(&self, req: &http::Request<Incoming>, site: Option<&SiteRow>) -> Resp {
        let Some(s) = site else { return json(404, &json!({ "error": "No app at this address." })) };
        let out = self.sites.serve(req.method().as_str(), req.uri().path(), s);
        let ct = out.headers.iter().find(|(k, _)| *k == "content-type").map_or("application/octet-stream", |(_, v)| v.as_str()).to_owned();
        let extra: Vec<(&'static str, String)> = out.headers.into_iter().filter(|(k, _)| *k != "content-type").collect();
        respond(out.status, &ct, full(out.body), &extra)
    }

    /// `/api/sites[/<key>]`, with the body read up to the grid's cap for apps.
    pub(super) async fn sites_route(&self, req: http::Request<Incoming>, who: &Who, key: Option<&str>, q: &str) -> Result<Resp> {
        let cred = who.credential().ok_or_else(|| bad("Sign in first.", 401))?;
        if let Some(r) = no(&may(cred, Reach::GridPublish)) {
            return Ok(r);
        }
        let user = who.user().cloned().ok_or_else(|| bad("Sign in first.", 401))?;
        let method = req.method().clone();
        match (method, key) {
            (Method::GET, None) => {
                let list: Vec<_> = self.sites.list(&user.id)?.iter().map(|s| self.sites.view(s)).collect();
                Ok(json(200, &json!({ "enabled": self.sites.enabled, "maxBytes": self.sites.max_bytes, "sites": list })))
            }
            (Method::PUT, Some(k)) => {
                if !self.sites.enabled {
                    return Ok(json(403, &json!({ "error": "This grid doesn’t publish apps." })));
                }
                let cap = usize::try_from(self.sites.max_bytes).unwrap_or(usize::MAX);
                let body = read_bytes(req.into_body(), cap).await.map_err(|_| bad(format!("That app is too big to publish here ({} MB at most).", self.sites.max_bytes / 1024 / 1024), 413))?;
                let title = query(q, "title").unwrap_or_default();
                let entry = query(q, "entry").unwrap_or_default();
                Ok(json(200, &self.sites.publish(&user, k, &body, &title, &entry)?))
            }
            (Method::DELETE, Some(k)) => Ok(json(200, &json!({ "ok": self.sites.remove(&user.id, k)? }))),
            _ => Ok(json(404, &json!({ "error": "not found" }))),
        }
    }
}
