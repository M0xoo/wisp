//! The `channels.transport@1` point: one way to reach wisp from outside (v1 `channels/channel.js`).
//! The hub owns the config, the public API, the fan-out and what a message may do; a transport owns
//! only its wire. A user's plugin adds a transport the same way the built-in ones do.
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, CancellationToken, Point, Result, WireError};

use crate::hub::ChannelHub;
use crate::views::{Msg, SessionView, Thread};

/// What a transport module contributes into `channels.transport@1`.
pub trait TransportDef: Send + Sync + 'static {
    /// `telegram`, `slack`, …: the key of its config, its status and its part of `GET /api/remote`
    fn name(&self) -> &'static str;
    /// made once per hub; the hub hands itself in
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport>;
    /// config fields (dotted: `hook.secret`) kept in `~/.wisp/secrets.json`, never in the store
    fn secrets(&self) -> &'static [&'static str] {
        &[]
    }
    /// its on switch, a bool setting that ships off. Default `channels.<name>.enabled`.
    fn setting(&self) -> String {
        enabled_key(self.name())
    }
}

pub const TRANSPORTS: Point<dyn TransportDef> = Point::new("channels.transport", 1);

/// A transport's on switch: every integration ships off.
pub fn enabled_key(channel: &str) -> String {
    format!("channels.{channel}.enabled")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    /// ntfy, Telegram: hears the phone's events (waiting, finished) for every task
    Phone,
    /// Slack, Discord, GitHub, email, routed: answers only where it was asked (`reports`)
    Thread,
}

/// Headers as the edge read them, names lower-cased.
pub type Headers = Vec<(String, String)>;

pub fn header<'a>(h: &'a Headers, name: &str) -> Option<&'a str> {
    h.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InboundOpts {
    /// when the grid took it, ms since the epoch
    pub at_ms: i64,
    /// the grid already checked the channel's own signature (its delivery mark)
    pub verified: bool,
}

/// A transport's answer to a message the grid held. A 4xx is final; only a 2xx means handled.
pub struct InboundResult {
    pub status: u16,
    pub body: Value,
    /// runs once the answer has gone: what must wait for the grid to hear it
    pub after: Option<BoxFuture<'static, ()>>,
}

impl std::fmt::Debug for InboundResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboundResult")
            .field("status", &self.status)
            .field("body", &self.body)
            .field("after", &self.after.is_some())
            .finish()
    }
}

impl InboundResult {
    pub fn new(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            after: None,
        }
    }
    pub fn error(status: u16, message: &str) -> Self {
        Self::new(status, serde_json::json!({ "error": message }))
    }
    pub fn ok() -> Self {
        Self::new(200, serde_json::json!({ "ok": true }))
    }
    #[must_use]
    pub fn then(mut self, after: BoxFuture<'static, ()>) -> Self {
        self.after = Some(after);
        self
    }
}

/// Health for Settings, merged over the last one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct Status {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(flatten)]
    #[ts(skip)]
    pub more: serde_json::Map<String, Value>,
}

/// One way to reach wisp from outside.
#[async_trait]
pub trait Transport: Send + Sync + 'static {
    fn name(&self) -> &str;
    /// configured well enough to send
    fn ready(&self) -> bool;
    fn kind(&self) -> TransportKind;
    /// a phone transport that can send now (Telegram: linked to a chat)
    fn sending(&self) -> bool {
        self.ready()
    }
    /// Telegram's channel layer: the hub defuses what leaves, and routes reports by origin
    fn layer(&self) -> bool {
        false
    }
    /// Called on each (re)start of the hub, ready or not: one that isn't ready returns at once after
    /// what being off needs (Telegram drops a webhook an earlier run left). A ready one listens until
    /// `stop` is cancelled.
    async fn start(&self, stop: CancellationToken);
    /// send `msg` about `s` (or about nothing in particular)
    async fn publish(&self, msg: &Msg, s: Option<&SessionView>) -> Result<()>;
    /// a thread transport: this task is reported here
    fn reports(&self, _s: Option<&SessionView>) -> bool {
        false
    }
    /// a message the grid held for this cloud wisp: verify it with the channel's own check, handle it
    async fn inbound(&self, _raw: &[u8], _headers: &Headers, _opts: InboundOpts) -> InboundResult {
        InboundResult::error(404, "This channel has no inbound here.")
    }
    /// the grid lost `n` of this channel's messages (a full grid, an hour asleep)
    async fn dropped(&self, _n: u32) {}
    /// replace this cloud wisp's inbound URL and point the channel at the new one
    async fn rotate(&self) -> InboundResult {
        InboundResult::error(404, "This channel has no URL to rotate.")
    }
    /// answers under way that nothing else shows (for /api/status)
    fn busy(&self) -> u32 {
        0
    }
    /// a task or crew job from this channel began, or couldn't
    fn thread_started(
        &self,
        _s: Option<&SessionView>,
        _thread: Option<&Thread>,
        _by: Option<&str>,
        _err: Option<&str>,
    ) {
    }
    /// its part of `GET /api/remote`: config with secrets masked, plus health. None: not in Settings.
    fn view(&self) -> Option<Value> {
        None
    }
    /// its part of `PUT /api/remote`; masked tokens mean unchanged. An `invalid` error refuses it.
    async fn update(&self, _body: &Value) -> Result<()> {
        Ok(())
    }
    /// the hub stopped: free what `start` did not tie to its token
    fn stop(&self) {}
    /// `GET /api/remote/<name>/<what>` (Slack's manifest, Discord's invite)
    async fn extra(&self, what: &str) -> Result<Value> {
        Err(WireError::not_found(format!("{}: no {what}", self.name())))
    }
}
