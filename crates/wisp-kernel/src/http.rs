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
    Json { status: u16, body: serde_json::Value },
    /// a JSON answer serialised once, with its ETag and compressed copies kept (the task list)
    Prepared { status: u16, body: Arc<serde_json::Value> },
    Bytes { status: u16, content_type: String, body: Vec<u8>, headers: Vec<(String, String)> },
    Text { status: u16, content_type: String, body: String },
    /// a stream owned by the route (SSE, terminal output)
    Stream { content_type: String, body: tokio::sync::mpsc::Receiver<Vec<u8>> },
    Redirect { status: u16, location: String },
}

impl Response {
    pub fn ok(body: impl serde::Serialize) -> Result<Self> {
        let body = serde_json::to_value(body).map_err(|e| crate::WireError::internal(e.to_string()))?;
        Ok(Self::Json { status: 200, body })
    }
}

pub type Handler = Arc<dyn Fn(Ctx, Call, Request) -> BoxFuture<'static, Result<Response>> + Send + Sync>;

pub struct Route {
    pub method: &'static str,
    /// under /api unless `raw`: `/sessions/:id`, matched by whole segments
    pub pattern: &'static str,
    /// the permission a caller's capability set must hold (default deny)
    pub permission: &'static str,
    /// false: not public API, left out of OpenAPI on purpose
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
        f.debug_struct("Route").field("method", &self.method).field("pattern", &self.pattern).field("permission", &self.permission).finish_non_exhaustive()
    }
}

pub const ROUTES: crate::Point<Route> = crate::Point::new("kernel.http", 1);
