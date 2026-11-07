//! The small kernel services an install provides at boot (plan §6.1): paths, secrets, net and notify,
//! beside `Clock` (lib.rs), the store (wisp-store) and proc (wisp-proc). Each is a trait object so an
//! install swaps it (the grid, the simulation, a test). `crates/wisp` provides the real ones.
//!
//! Additive (wisp-api/edge agent, 2026-11-08): a plugin reads them with the helpers at the bottom,
//! `services::paths(&ctx)?`, so no plugin names the `Arc<dyn …>` wrapping.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::{BoxFuture, Ctx, Result};

/// Where wisp keeps its files: `~/.wisp`, or `WISP_HOME`.
#[derive(Debug, Clone)]
pub struct Paths {
    home: PathBuf,
}

impl Paths {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }
    pub fn home(&self) -> &Path {
        &self.home
    }
    /// `<home>/<rel>` (v1 paths keep their names: `stuff`, `uploads`, `worktrees`, …)
    pub fn join(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.home.join(rel)
    }
    /// A plugin's own folder: `<home>/plugins/<id>`.
    pub fn plugin_dir(&self, plugin: &str) -> PathBuf {
        self.home.join("plugins").join(plugin)
    }
}

/// `~/.wisp/secrets.json` (0600), never the database. Keys are `ns/key`; a key without `/` is in `wisp`.
pub trait Secrets: Send + Sync + 'static {
    fn get(&self, key: &str) -> BoxFuture<'static, Result<Option<String>>>;
    fn set(&self, key: &str, value: &str) -> BoxFuture<'static, Result<()>>;
    fn delete(&self, key: &str) -> BoxFuture<'static, Result<()>>;
    /// every key starting with `prefix`, sorted
    fn keys(&self, prefix: &str) -> BoxFuture<'static, Result<Vec<String>>>;
}

/// One HTTP request out. Plugins never open their own client (plan §3.1 rule 8: one HTTP client).
#[derive(Debug, Clone, Default)]
pub struct NetRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// 0: the service's default (30 s)
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct NetResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl NetResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.body)
            .map_err(|e| crate::WireError::invalid(format!("response body: {e}")))
    }
}

pub trait Net: Send + Sync + 'static {
    /// Transport failures are `unavailable` (retry: true); any HTTP status is an `Ok` answer.
    fn fetch(&self, req: NetRequest) -> BoxFuture<'static, Result<NetResponse>>;
}

/// Ephemeral notices for every client: a `notice` frame for v2 clients, an event of that name for v1
/// clients (`toast`, `finished`, `reminder`, `summary`, …). Never stored, never replayed.
pub trait Notify: Send + Sync + 'static {
    /// `topic`: only subscribers of that topic get it (v2); v1 clients get every notice.
    fn notice(&self, kind: &str, data: Value, topic: Option<&str>);
}

pub type SecretsService = Arc<dyn Secrets>;
pub type NetService = Arc<dyn Net>;
pub type NotifyService = Arc<dyn Notify>;

pub fn paths(ctx: &Ctx) -> Result<Arc<Paths>> {
    ctx.service::<Paths>()
}
pub fn secrets(ctx: &Ctx) -> Result<SecretsService> {
    ctx.service::<SecretsService>().map(|s| (*s).clone())
}
pub fn net(ctx: &Ctx) -> Result<NetService> {
    ctx.service::<NetService>().map(|s| (*s).clone())
}
pub fn notify(ctx: &Ctx) -> Result<NotifyService> {
    ctx.service::<NotifyService>().map(|s| (*s).clone())
}
