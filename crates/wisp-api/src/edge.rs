//! One request through the edge (v1 server/index.js's handler), in order:
//!   1. a preview's request (through the trusted proxy, `x-wisp-preview`) goes to that loopback port;
//!   2. Host, then a non-GET's Origin (an open route checks its own secret instead);
//!   3. POST /share is answered at once; a non-GET must be JSON (octet-stream where the route uploads);
//!   4. outside /api and no raw route: the web bundle; under /api: the route, read its body (capped),
//!      decide the caller from its token, check the route's permission, run it;
//!   5. the answer, or the error as `{error, code, message, retry}`. A refusal is never logged.
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, RwLock};

use bytes::Bytes;
use http::{HeaderMap, Method};
use hyper::body::Incoming;
use tokio_util::sync::CancellationToken;
use wisp_kernel::Caller;
use wisp_kernel::http::{OPEN, OPEN_QUIET, Request as KReq};

use crate::auth::{self, AuthOptions};
use crate::backend::Backend;
use crate::body::{MAX_BODY, read_capped};
use crate::error::{ApiError, error_body};
use crate::respond::{self, Answer, Asked, PreparedCache};
use crate::router::{Entry, Own, Params, Spec, Table, Target};
use crate::statics::StaticFiles;
use crate::status::Activity;
use crate::sync::{Hub, Idempotency};
use crate::{guard, preview};

pub const API_VERSION: u32 = 1;
/// Own routes whose permission the kernel or the sync layer checks per command or topic.
pub(crate) const CHECKED_INSIDE: &str = "edge:inside";

pub use crate::config::EdgeConfig;

pub struct Edge {
    pub(crate) cfg: EdgeConfig,
    pub(crate) port: AtomicU16,
    pub(crate) backend: Arc<dyn Backend>,
    table: RwLock<Arc<Table>>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) idem: Idempotency,
    pub(crate) prepared: PreparedCache,
    pub(crate) activity: Activity,
    pub(crate) statics: Option<Arc<StaticFiles>>,
    preview: preview::PreviewClient,
    pub(crate) stop: CancellationToken,
}

impl std::fmt::Debug for Edge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Edge")
            .field("port", &self.port())
            .field("hub", &self.hub)
            .finish_non_exhaustive()
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn own(method: &str, pattern: &str, permission: &str, summary: &str) -> Spec {
    Spec {
        method: method.into(),
        pattern: pattern.into(),
        raw: false,
        permission: permission.into(),
        doc: true,
        summary: summary.into(),
        max_body: None,
        owner: "wisp.edge".into(),
    }
}

impl Edge {
    /// Must run inside a tokio runtime (the web bundle's compressor is a task).
    pub fn new(cfg: EdgeConfig, backend: Arc<dyn Backend>, hub: Arc<Hub>) -> Arc<Self> {
        let stop = CancellationToken::new();
        let statics = cfg
            .web_dir
            .as_ref()
            .map(|d| StaticFiles::new(d.clone(), stop.child_token()));
        let edge = Arc::new(Self {
            cfg,
            port: AtomicU16::new(0),
            backend,
            table: RwLock::new(Arc::new(Table::new())),
            hub,
            idem: Idempotency::default(),
            prepared: PreparedCache::default(),
            activity: Activity::new(now_ms()),
            statics,
            preview: preview::client(),
            stop,
        });
        edge.reload_routes();
        edge
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// Rebuilds the table from the plugins that are on (after a plugin is switched on or off).
    pub fn reload_routes(&self) {
        let mut t = Table::new();
        for (m, p, perm, s, o) in [
            (
                "GET",
                "/health",
                "edge:health",
                "Is wisp up: name, version, apiVersion, pid, url",
                Own::Health,
            ),
            (
                "GET",
                "/status",
                "edge:status",
                "Whether anything is going on (the grid stops an idle box)",
                Own::Status,
            ),
            (
                "GET",
                "/events",
                "edge:events",
                "Live events: the v2 sync stream with a hello in the query, else v1's events",
                Own::Events,
            ),
            (
                "POST",
                "/events",
                CHECKED_INSIDE,
                "A sync message (sub, unsub, window, mutate) for an open v2 stream",
                Own::EventsPost,
            ),
            (
                "POST",
                "/cmd",
                CHECKED_INSIDE,
                "Run a command {cmd, args} once per Idempotency-Key",
                Own::Cmd,
            ),
            (
                "GET",
                "/openapi.json",
                "edge:health",
                "This document",
                Own::OpenApi,
            ),
        ] {
            let _ = t.add(own(m, p, perm, s), Target::Own(o));
        }
        for b in self.backend.routes() {
            let what = format!("{} {}", b.spec.method, b.spec.pattern);
            if let Err(e) = t.add(b.spec, Target::Plugin(b.invoke)) {
                tracing::warn!("route refused: {e} ({what})");
            }
        }
        if let Ok(mut slot) = self.table.write() {
            *slot = Arc::new(t);
        }
    }

    /// The route for a request; a miss wakes plugins waiting on `onRoute` (an API path, or a write to a
    /// raw path such as a webhook) and looks once more.
    async fn find(&self, method: &Method, path: &str) -> Option<(Arc<Entry>, Params)> {
        if let Some(f) = self.table().find(method.as_str(), path) {
            return Some(f);
        }
        if (path.starts_with("/api/") || !guard::safe_method(method))
            && self.backend.wake_route(method.as_str(), path).await
        {
            self.reload_routes();
            return self.table().find(method.as_str(), path);
        }
        None
    }

    /// Every route served now, in table order (`OpenAPI`'s test reads it).
    pub fn routes(&self) -> Vec<Arc<Entry>> {
        self.table().list().to_vec()
    }

    pub(crate) fn table(&self) -> Arc<Table> {
        self.table.read().map(|t| t.clone()).unwrap_or_default()
    }

    pub async fn handle(self: &Arc<Self>, req: http::Request<Incoming>) -> Answer {
        let via = self.cfg.proxy.via(req.headers());
        if via && req.headers().contains_key("x-wisp-preview") {
            return match preview::preview_port(req.headers(), self.port())
                .filter(|_| self.cfg.previews)
            {
                Some(p) => preview::forward(&self.preview, req, p).await,
                None => fail(&ApiError::NotFound),
            };
        }
        match self.route(req, via).await {
            Ok(a) => a,
            Err(e) => fail(&e),
        }
    }

    async fn route(
        self: &Arc<Self>,
        req: http::Request<Incoming>,
        via: bool,
    ) -> Result<Answer, ApiError> {
        let (parts, body) = req.into_parts();
        let (method, path) = (parts.method.clone(), parts.uri.path().to_owned());
        let found = self.find(&method, &path).await;
        let perm = found.as_ref().map(|(e, _)| e.permission.as_str());
        let open = matches!(perm, Some(OPEN | OPEN_QUIET));
        guard::check(
            &method,
            &parts.headers,
            self.port(),
            &self.cfg.proxy,
            via,
            open,
        )?;
        if guard::is_share(&method, &path) {
            return Ok(respond::redirect(303, guard::SHARE_LANDING));
        }
        if !guard::safe_method(&method) {
            if !open {
                guard::content_ok(
                    &method,
                    &parts.headers,
                    found.as_ref().is_some_and(|(e, _)| e.max_body.is_some()),
                )?;
            }
            if perm != Some(OPEN_QUIET) {
                self.activity.touch(now_ms());
            }
        }
        let Some((entry, params)) = found else {
            if !path.starts_with("/api/")
                && guard::safe_method(&method)
                && let Some(s) = &self.statics
            {
                return Ok(s
                    .serve(&method, &path, parts.uri.query(), &parts.headers)
                    .await);
            }
            return Err(ApiError::NotFound);
        };
        let body = if guard::safe_method(&method) {
            Bytes::new()
        } else {
            json_body(
                &parts.headers,
                read_capped(body, entry.max_body.unwrap_or(MAX_BODY)).await?,
            )?
        };
        let auth = AuthOptions {
            master: &self.cfg.master,
            user_set: &self.cfg.user_set,
            via_proxy: via,
            public: open,
            agent_set: None,
        };
        let caller = self.caller(&parts.headers, &params, &body, &auth)?;
        if !open && entry.permission != CHECKED_INSIDE {
            let why = if auth::edge_denies(&caller, &entry.permission) {
                Err(format!("{} may not {}", caller.set, entry.permission))
            } else {
                self.backend.explain(&caller, &entry.permission)
            };
            if let Err(why) = why {
                return Err(ApiError::Wire(wisp_kernel::WireError::forbidden(why)));
            }
        }
        let asked = Asked::of(&method, &parts.headers);
        match &entry.target {
            Target::Own(o) => {
                crate::own::run(self, *o, caller, &parts, &params, body, &asked).await
            }
            Target::Plugin(invoke) => {
                self.plugin(invoke, &entry, caller, &parts, params, body, &asked)
                    .await
            }
        }
    }

    fn caller(
        &self,
        h: &HeaderMap,
        params: &Params,
        body: &[u8],
        o: &AuthOptions<'_>,
    ) -> Result<Caller, ApiError> {
        // the backend decides the agent's set (agent:capped for a capped task)
        let backend = self.backend.clone();
        let f: auth::AgentSet = Arc::new(move |id: &str| backend.agent_set(id));
        auth::resolve(
            h,
            params,
            body,
            &AuthOptions {
                agent_set: Some(&f),
                ..*o
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn plugin(
        &self,
        invoke: &crate::router::Invoke,
        entry: &Entry,
        caller: Caller,
        parts: &http::request::Parts,
        params: Params,
        body: Bytes,
        asked: &Asked,
    ) -> Result<Answer, ApiError> {
        let req = KReq {
            method: parts.method.as_str().to_owned(),
            path: parts.uri.path().to_owned(),
            params,
            query: parse_query(parts.uri.query()),
            headers: parts
                .headers
                .iter()
                .filter_map(|(k, v)| {
                    v.to_str()
                        .ok()
                        .map(|v| (k.as_str().to_owned(), v.to_owned()))
                })
                .collect(),
            body: body.to_vec(),
        };
        let span = tracing::info_span!("route", method = %entry.method, path = %entry.path, set = %caller.set);
        let out = tracing::Instrument::instrument(invoke(caller, req), span).await;
        match out {
            Ok(r) => Ok(crate::own::convert(self, r, asked).await),
            Err(e) => {
                if e.status() >= 500 {
                    tracing::error!(route = %format!("{} {}", entry.method, entry.path), "{e}");
                }
                Ok(fail(&ApiError::Wire(e)))
            }
        }
    }

    /// Stops the background work (compression, pings) and ends the v1 streams.
    pub fn shutdown(&self) {
        self.stop.cancel();
        self.hub.close();
    }
}

/// A JSON body: empty is `{}` (v1's readJson), anything else must parse.
fn json_body(h: &HeaderMap, body: Bytes) -> Result<Bytes, ApiError> {
    let json =
        crate::trust::header(h, "content-type").is_some_and(|c| c.starts_with("application/json"));
    if !json {
        return Ok(body);
    }
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Bytes::from_static(b"{}"));
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(&body).map_err(|_| ApiError::InvalidJson)?;
    Ok(body)
}

/// `URLSearchParams`: `+` is a space, escapes decoded, a malformed one kept as typed.
pub fn parse_query(q: Option<&str>) -> Vec<(String, String)> {
    let dec = |s: &str| {
        let s = s.replace('+', " ");
        crate::router::percent_decode(&s).unwrap_or(s)
    };
    q.unwrap_or("")
        .split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            kv.split_once('=')
                .map_or_else(|| (dec(kv), String::new()), |(k, v)| (dec(k), dec(v)))
        })
        .collect()
}

pub(crate) fn fail(e: &ApiError) -> Answer {
    if !e.is_refusal() {
        tracing::error!("{e}");
    }
    respond::plain_json(e.status(), &error_body(&e.to_wire()))
}

#[cfg(test)]
#[path = "edge_tests.rs"]
mod tests;
