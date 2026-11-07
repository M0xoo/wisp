//! Launched apps (v1 services/apps.js): each served on a port of its own on 127.0.0.1, its own origin
//! (its scripts, storage and fetches work like any site's, and wisp's API stays out of its reach).
//! The port comes from the item's id, so the app keeps its storage between launches. Files come
//! straight from the CAS by the app's tree. At most 8 run; one idle for 30 minutes stops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use http::{HeaderValue, Request, Response, StatusCode};
use wisp_kernel::CancellationToken;
use wisp_stuff_api::StuffKind;
use wisp_stuff_core::appdb::{BODY_LIMIT, DB_CLIENT, check_request, parse_query};
use wisp_stuff_core::serve::{AppRoute, IDLE_MS, MAX_RUNNING, app_file_headers, port_candidates, route_app};

use crate::appdb::{AppDb, no_db};
use crate::error::{Result, bad};
use crate::shelf::Shelf;

pub const PANE_JS: &str = include_str!("../assets/pane.js");
const PANE_KIT: &str = include_str!("../assets/pane-kit.css");
/// wisp's tokens (light and dark, off data-theme, which /_wisp/pane.js sets), from @wisp/tokens.
const TOKENS: &str = include_str!("../../../../packages/tokens/dist/tokens.css");

pub fn pane_css() -> String {
    format!("{TOKENS}{PANE_KIT}")
}

struct Run {
    port: u16,
    tree: String,
    last: Arc<AtomicI64>,
    stop: CancellationToken,
}

/// What one app's server knows.
struct Served {
    tree: Arc<HashMap<String, (String, u64)>>,
    entry: String,
    uses_wisp: bool,
    db: Option<(std::path::PathBuf, String)>,
    shelf: Arc<Shelf>,
    appdb: Arc<AppDb>,
    last: Arc<AtomicI64>,
}

pub struct Apps {
    shelf: Arc<Shelf>,
    pub appdb: Arc<AppDb>,
    running: Mutex<HashMap<String, Run>>,
    root: CancellationToken,
}

impl std::fmt::Debug for Apps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Apps").finish_non_exhaustive()
    }
}

impl Apps {
    pub fn new(shelf: Arc<Shelf>, appdb: Arc<AppDb>, root: CancellationToken) -> Arc<Self> {
        Arc::new(Self { shelf, appdb, running: Mutex::new(HashMap::new()), root })
    }

    pub fn state(&self, id: &str) -> Option<u16> {
        self.running.lock().ok()?.get(id).map(|r| r.port)
    }

    /// Start it (or keep it going): its port. An app updated since serves its new files.
    pub async fn launch(self: &Arc<Self>, id: &str) -> Result<u16> {
        let it = self.shelf.get(id).filter(|x| x.kind == StuffKind::App).ok_or_else(|| bad(404, "That’s not an app in My Stuff."))?;
        let tree = it.tree.clone().ok_or_else(|| bad(409, "That app’s files aren’t in My Stuff yet."))?;
        {
            let mut running = self.running.lock().map_err(|_| crate::error::Error::Poisoned)?;
            if let Some(r) = running.get(id) {
                if r.tree == tree {
                    r.last.store(self.shelf.now(), Ordering::Relaxed);
                    return Ok(r.port);
                }
                if let Some(old) = running.remove(id) {
                    old.stop.cancel();
                }
            }
            if running.len() >= MAX_RUNNING
                && let Some(oldest) = running.iter().min_by_key(|(_, r)| r.last.load(Ordering::Relaxed)).map(|(k, _)| k.clone())
                && let Some(r) = running.remove(&oldest)
            {
                r.stop.cancel();
            }
        }
        let files = crate::appfiles::tree(self.shelf.blobs.as_ref(), &tree).await?;
        let seed = match it.db.as_ref().map(|d| d.seed.clone()).filter(|s| !s.is_empty()) {
            Some(s) => match files.get(&s) {
                Some((h, _)) => self.shelf.blobs.get(h).await?.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default(),
                None => String::new(),
            },
            None => String::new(),
        };
        let last = Arc::new(AtomicI64::new(self.shelf.now()));
        let served = Arc::new(Served {
            tree: files,
            entry: it.entry.clone().unwrap_or_else(|| "index.html".into()),
            uses_wisp: it.uses.as_ref().is_some_and(|u| !u.is_empty()),
            db: it.db.as_ref().map(|_| (self.shelf.data_file(id), seed)),
            shelf: self.shelf.clone(),
            appdb: self.appdb.clone(),
            last: last.clone(),
        });
        let (listener, port) = bind(id).await?;
        let stop = self.root.child_token();
        let router = axum::Router::new().fallback(move |req: Request<Body>| {
            let s = served.clone();
            async move { serve(&s, req).await }
        });
        let shutdown = stop.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown.cancelled_owned()).await;
        });
        self.watch_idle(id.to_owned(), stop.clone(), last.clone());
        let mut running = self.running.lock().map_err(|_| crate::error::Error::Poisoned)?;
        running.insert(id.to_owned(), Run { port, tree, last, stop });
        Ok(port)
    }

    fn watch_idle(self: &Arc<Self>, id: String, stop: CancellationToken, last: Arc<AtomicI64>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tokio::select! {
                    () = stop.cancelled() => return,
                    _ = tick.tick() => {}
                }
                let Some(apps) = me.upgrade() else { return };
                if apps.shelf.now() - last.load(Ordering::Relaxed) > IDLE_MS {
                    apps.stop(&id);
                    return;
                }
            }
        });
    }

    pub fn stop(&self, id: &str) -> bool {
        let r = self.running.lock().ok().and_then(|mut m| m.remove(id));
        r.map(|r| r.stop.cancel()).is_some()
    }

    pub fn stop_all(&self) {
        self.root.cancel();
        if let Ok(mut m) = self.running.lock() {
            m.clear();
        }
    }
}

async fn bind(id: &str) -> Result<(tokio::net::TcpListener, u16)> {
    for port in port_candidates(id) {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            return Ok((l, port));
        }
    }
    Err(bad(503, "No free port to start the app on."))
}

fn reply(status: u16, headers: &[(&str, &str)], body: impl Into<Body>) -> Response<Body> {
    let mut r = Response::new(body.into());
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (k, v) in headers {
        if let (Ok(k), Ok(v)) = (http::HeaderName::try_from(*k), HeaderValue::from_str(v)) {
            r.headers_mut().insert(k, v);
        }
    }
    r
}

fn json(status: u16, v: &serde_json::Value) -> Response<Body> {
    reply(status, &[("content-type", "application/json"), ("cache-control", "no-store"), ("x-content-type-options", "nosniff")], v.to_string())
}

fn header<'a>(req: &'a Request<Body>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

async fn serve(s: &Served, req: Request<Body>) -> Response<Body> {
    s.last.store(s.shelf.now(), Ordering::Relaxed);
    let method = req.method().as_str().to_owned();
    let head = method == "HEAD";
    let host = header(&req, "host").unwrap_or_default().to_owned();
    let path = req.uri().path().to_owned();
    let route = route_app(&method, &host, &path, &s.entry, s.db.is_some(), |rel| s.tree.contains_key(rel));
    let body = |b: &'static str| if head { Body::empty() } else { Body::from(b) };
    match route {
        AppRoute::Forbidden => reply(403, &[("content-type", "text/plain")], "forbidden host"),
        AppRoute::PaneJs => reply(200, &[("content-type", "text/javascript; charset=utf-8"), ("cache-control", "no-store"), ("x-content-type-options", "nosniff")], body(PANE_JS)),
        AppRoute::PaneCss => reply(200, &[("content-type", "text/css; charset=utf-8"), ("cache-control", "no-cache"), ("x-content-type-options", "nosniff")], if head { Body::empty() } else { Body::from(pane_css()) }),
        AppRoute::NoDb => json(404, &no_db()),
        AppRoute::WispNotFound => json(404, &serde_json::json!({ "error": "not found" })),
        AppRoute::Db { js: true } => reply(200, &[("content-type", "text/javascript; charset=utf-8"), ("cache-control", "no-store"), ("x-content-type-options", "nosniff")], body(DB_CLIENT)),
        AppRoute::Db { js: false } => db_query(s, req).await,
        AppRoute::MethodNotAllowed => reply(405, &[("allow", "GET, HEAD")], Body::empty()),
        AppRoute::NotFound => reply(404, &[("content-type", "text/plain; charset=utf-8")], "Not found in this app."),
        AppRoute::File(rel) => file(s, &rel, head).await,
    }
}

async fn file(s: &Served, rel: &str, head: bool) -> Response<Body> {
    let Some((hash, size)) = s.tree.get(rel) else { return reply(404, &[], "Not found in this app.") };
    let Ok(Some(bytes)) = s.shelf.blobs.get(hash).await else { return reply(404, &[], "Not found in this app.") };
    let hs = app_file_headers(wisp_stuff_core::kind::type_of(rel), s.uses_wisp);
    let mut r = reply(200, &[], if head { Body::empty() } else { Body::from(bytes.as_ref().clone()) });
    for (k, v) in hs.iter().map(|(k, v)| (k.as_str(), v.as_str())).chain([("content-length", size.to_string().as_str())]) {
        if let (Ok(k), Ok(v)) = (http::HeaderName::try_from(k), HeaderValue::from_str(v)) {
            r.headers_mut().insert(k, v);
        }
    }
    r
}

async fn db_query(s: &Served, req: Request<Body>) -> Response<Body> {
    let Some((file, seed)) = s.db.clone() else { return json(404, &no_db()) };
    let method = req.method().as_str().to_owned();
    let host = header(&req, "host").map(str::to_owned);
    if let Err((st, m)) = check_request(&method, header(&req, "content-type"), header(&req, "origin"), host.as_deref()) {
        return json(st, &serde_json::json!({ "error": m }));
    }
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), BODY_LIMIT + 1).await else {
        return json(413, &serde_json::json!({ "error": "That query is too long (1 MB at most)." }));
    };
    let q = match parse_query(&bytes, &seed) {
        Ok(q) => q,
        Err((st, m)) => return json(st, &serde_json::json!({ "error": m })),
    };
    match s.appdb.query(file, seed, q).await {
        Ok(v) => json(200, &v),
        Err((st, m)) => json(st, &serde_json::json!({ "error": m })),
    }
}
