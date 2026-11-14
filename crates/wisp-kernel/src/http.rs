//! HTTP routes as a kernel-owned point (`kernel.http@1`). Plugins describe routes with these plain
//! types; `wisp-api` serves them with axum. v1's API paths stay as thin adapters over commands, so
//! v1 clients (older phones, the SDK, other machines) keep working.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::{BoxFuture, Call, Ctx, Result};

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    /// the full path, `/api/sessions/abc`
    pub path: String,
    pub params: BTreeMap<String, String>,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    /// already capped (2 MB unless the route says otherwise) and read
    pub body: Vec<u8>,
}

impl Request {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params.get(name).map(String::as_str)
    }
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.body).map_err(|e| crate::WireError::invalid(format!("body: {e}")))
    }
}

#[derive(Debug)]
pub enum Response {
    Json {
        status: u16,
        body: serde_json::Value,
    },
    /// a JSON answer serialised once, with its `ETag` and compressed copies kept (the task list)
    Prepared {
        status: u16,
        body: Arc<serde_json::Value>,
    },
    Bytes {
        status: u16,
        content_type: String,
        body: Vec<u8>,
        headers: Vec<(String, String)>,
    },
    Text {
        status: u16,
        content_type: String,
        body: String,
    },
    /// a stream owned by the route (SSE, terminal output)
    Stream {
        content_type: String,
        body: tokio::sync::mpsc::Receiver<Vec<u8>>,
    },
    Redirect {
        status: u16,
        location: String,
    },
}

/// The sending end of a streamed response. A send waits while the client is slow (64 chunks in flight),
/// and fails once the client has gone: the route stops then.
pub type StreamTx = tokio::sync::mpsc::Sender<Vec<u8>>;

impl Response {
    /// A streamed answer of `content_type` (terminal output, a long read): chunks go as they're sent.
    pub fn stream(content_type: impl Into<String>) -> (StreamTx, Self) {
        let (tx, body) = tokio::sync::mpsc::channel(64);
        (tx, Self::Stream { content_type: content_type.into(), body })
    }

    /// Server-sent events: `event:`/`data:` frames, one per send of [`sse_frame`].
    pub fn sse() -> (StreamTx, Self) {
        Self::stream("text/event-stream")
    }

    pub fn ok(body: impl serde::Serialize) -> Result<Self> {
        let body = serde_json::to_value(body).map_err(|e| crate::WireError::internal(e.to_string()))?;
        Ok(Self::Json { status: 200, body })
    }
}

/// One server-sent event: `event: <name>` (when given) and its data, one `data:` line per line.
pub fn sse_frame(event: Option<&str>, data: &str) -> Vec<u8> {
    let mut out = String::new();
    if let Some(e) = event {
        out.push_str("event: ");
        out.push_str(e);
        out.push('\n');
    }
    for line in data.split('\n') {
        out.push_str("data: ");
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    out.into_bytes()
}

pub type Handler = Arc<dyn Fn(Ctx, Call, Request) -> BoxFuture<'static, Result<Response>> + Send + Sync>;

pub struct Route {
    pub method: &'static str,
    /// under /api unless `raw`: `/sessions/:id`, matched by whole segments
    pub pattern: &'static str,
    /// the permission a caller's capability set must hold (default deny)
    pub permission: &'static str,
    /// false: not public API, left out of `OpenAPI` on purpose
    pub doc: bool,
    pub summary: &'static str,
    /// outside /api (hooks, webhooks, previews)
    pub raw: bool,
    /// a body cap other than 2 MB (uploads)
    pub max_body: Option<usize>,
    pub handler: Handler,
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Route")
            .field("method", &self.method)
            .field("pattern", &self.pattern)
            .field("permission", &self.permission)
            .finish_non_exhaustive()
    }
}

pub const ROUTES: crate::Point<Route> = crate::Point::new("kernel.http", 1);

// ---- additive (wisp-api/edge agent, 2026-11-08): what the edge needs from plugins, as data ----

/// `Route::permission` of a route callable from outside (a trigger's secret URL, a webhook): no Host,
/// Origin or JSON check and no capability check; the handler verifies its own secret or signature.
pub const OPEN: &str = "open";
/// As `OPEN`, and a call doesn't count as activity for `GET /api/status` (a channel's inbound message
/// must never keep a cloud box awake; the work it starts does that).
pub const OPEN_QUIET: &str = "open:quiet";

/// What a plugin reports for `GET /api/status`, which the grid reads to stop an idle box.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Liveness {
    /// turns running
    pub live: u32,
    /// side questions (/btw) running
    pub sides: u32,
    /// terminals and shells open
    pub terms: u32,
    /// channels with work in flight
    pub channels: u32,
    /// the last run start, turn or end (ms since the epoch); the edge adds non-GET requests
    pub last_activity_at: Option<i64>,
    /// the next scheduled wake (a trigger, a crew check-in, a later): the grid wakes the box then
    pub next_wake_at: Option<i64>,
}

/// A plugin's part of `GET /api/status`. Called on each status read: keep it a few atomic loads.
pub trait StatusPart: Send + Sync + 'static {
    fn liveness(&self) -> Liveness;
}

pub const STATUS: crate::Point<dyn StatusPart> = crate::Point::new("kernel.status", 1);
