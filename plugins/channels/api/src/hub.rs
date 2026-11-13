//! What a transport gets from the hub, and what the hub needs of wisp (v1 `services/phone.js`). Every
//! IO a transport does goes through these handles (`Net`, `Ws`, `Exec`, `BoxApi`), so a transport's
//! tests play Telegram or Slack in process with no socket open, and the host owns every connection.
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Result};

use crate::transport::Status;
use crate::views::{
    ActArgs, ActionKind, ChannelCtx, Parsed, ProjectView, Remote, RunOpts, SessionView, Signed, StartOpts, Started, Thread, ThreadCtx,
};

// ---------- IO handles ----------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// 0: the host's default (15 s)
    pub timeout_ms: u64,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self { method: "GET".into(), url: url.into(), ..Self::default() }
    }
    pub fn post_json(url: impl Into<String>, body: &Value) -> Self {
        Self {
            method: "POST".into(),
            url: url.into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(body).unwrap_or_default(),
            timeout_ms: 0,
        }
    }
    #[must_use]
    pub fn header(mut self, k: &str, v: impl Into<String>) -> Self {
        self.headers.push((k.to_ascii_lowercase(), v.into()));
        self
    }
    #[must_use]
    pub fn timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a request got no answer. `Broken` is a connection that went under a post: nothing says it
/// wasn't heard, so a sender may try it again (`resend`); a timeout or a refusal is never retried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Broken(String),
    Timeout,
    Cancelled,
    Refused(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Broken(m) => write!(f, "connection broke: {m}"),
            Self::Timeout => f.write_str("timed out"),
            Self::Cancelled => f.write_str("cancelled"),
            Self::Refused(m) => write!(f, "refused: {m}"),
        }
    }
}

#[async_trait]
pub trait Net: Send + Sync + 'static {
    async fn fetch(&self, req: HttpRequest) -> std::result::Result<HttpResponse, NetError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
    /// the connection ended, however it ended: 1006 when it just went
    Close(u16, String),
}

/// A WebSocket the host opened (Slack Socket Mode, Discord's gateway).
#[async_trait]
pub trait WsConn: Send + Sync {
    /// the next frame; `Close` exactly once, then None
    async fn recv(&self) -> Option<WsFrame>;
    async fn send(&self, text: String) -> std::result::Result<(), NetError>;
    async fn close(&self, code: u16);
    /// The keep-alive beat (v1 slack.js: a laptop that slept leaves a socket that looks open): sends a ping and
    /// answers whether anything came from the server since the last beat. false: it's gone, close it. Additive
    /// (2026-11-11); a connection without pings says it's alive.
    async fn ping(&self) -> bool {
        true
    }
}

#[async_trait]
pub trait Ws: Send + Sync + 'static {
    /// a URL can hold a ticket (Slack's does): the host never logs it
    async fn connect(&self, url: &str) -> std::result::Result<Box<dyn WsConn>, NetError>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A child process through the proc service (`proc:spawn{bin:gh}`); never `std::process` in a transport.
#[async_trait]
pub trait Exec: Send + Sync + 'static {
    async fn run(&self, bin: &str, args: &[String], stdin: Option<String>, timeout_ms: u64) -> Result<ExecOut>;
}

// ---------- the grid, from a cloud wisp's side (v1 channels/box.js) ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoxGrid {
    pub grid: String,
    pub auth: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelUrl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u32>,
    #[serde(default)]
    pub held: bool,
}

#[async_trait]
pub trait BoxApi: Send + Sync + 'static {
    /// `{ grid, auth }`, or None: not on a grid, or a sandbox
    fn grid(&self) -> Option<BoxGrid>;
    /// on a grid box at all
    fn in_box(&self) -> bool;
    /// proof of the token, not the token
    fn bot_mark(&self, token: &str) -> String;
    async fn channel_url(&self, b: &BoxGrid, channel: &str, bot: Option<&str>, gone: bool) -> Result<Option<ChannelUrl>>;
    async fn rotate_url(&self, b: &BoxGrid, channel: &str) -> Result<ChannelUrl>;
    async fn mail_reply(&self, b: &BoxGrid, reply_to: &str, subject: &str, text: &str) -> Result<Option<String>>;
    async fn set_channel_key(&self, b: &BoxGrid, channel: &str, key: &str, linked: &[String]) -> Result<bool>;
}

// ---------- what channels needs of wisp ----------

/// A line for the same thread, sent once it exists (a `/btw` answer, a follow-up that waited).
pub type Later = Arc<dyn Fn(String) + Send + Sync>;

/// v1 `phoneActions(app)`: what the channel layer asks of wisp. The host implements it with other
/// plugins' commands, run as the channel's caller (`agent:capped` below Full auto).
#[async_trait]
pub trait Phone: Send + Sync + 'static {
    async fn context(&self) -> Result<ChannelCtx>;
    /// counts only, and only fixed values: never what a message said
    fn count(&self, kind: &str, detail: Option<&str>);
    /// a routed message's way back: through the grid, which holds the bot
    fn on_grid(&self) -> bool;
    async fn grid_reply(&self, thread: &str, text: &str) -> Result<()>;
    /// a queued job's thread got its first reply
    fn thread_saved(&self);
    /// a message came in from someone the channel lets in: triggers on `chat.message` hear it (ADR-0043). Its
    /// text is handed on, never logged or counted.
    fn heard(&self, _channel: &str, _sender: &str, _text: &str) {}
    async fn thread_ctx(&self, session_id: &str) -> Result<ThreadCtx>;
    async fn start_parsed(&self, p: &Parsed, o: &StartOpts) -> Result<Started>;
    async fn stop(&self, session_id: &str) -> Result<String>;
    async fn status(&self, session_id: &str) -> Result<String>;
    /// `later`: where an answer that comes after the reply goes (a `/btw` answer, a queued follow-up)
    async fn run(&self, session_id: &str, p: &Parsed, o: &RunOpts, later: Option<Later>) -> Result<String>;
    async fn mention(&self, session_id: &str, p: &Parsed, o: &StartOpts) -> Result<Started>;
    async fn launch(&self, project: &ProjectView, prompt: &str) -> Result<Option<SessionView>>;
    /// A file a message brought, kept as an upload (`stuff.receive`): `{id, name, mime, size}` for a task's
    /// `attachments`. Additive (2026-11-11); a phone without uploads refuses.
    async fn upload(&self, _name: &str, _mime: &str, _bytes: Vec<u8>) -> Result<serde_json::Value> {
        Err(wisp_kernel::WireError::unavailable("files can't be kept here"))
    }
    async fn act(&self, a: &ActArgs) -> Result<String>;
    async fn projects(&self) -> Result<Vec<ProjectView>>;
    /// a task here or on a machine (`<id>@<machine>`), with its turns and ask
    async fn session(&self, id: &str) -> Result<Option<SessionView>>;
    /// running or waiting top-level tasks here
    async fn sessions(&self) -> Result<Vec<SessionView>>;
}

/// A task on another machine has no row here: its thread is kept in the channel's config.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AwayEntry {
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(default)]
    pub at: i64,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}

/// The hub as a transport sees it (v1 `Remote`, the part channels used).
#[async_trait]
pub trait ChannelHub: Send + Sync + 'static {
    fn phone(&self) -> Arc<dyn Phone>;
    fn net(&self) -> Arc<dyn Net>;
    fn ws(&self) -> Arc<dyn Ws>;
    fn exec(&self) -> Arc<dyn Exec>;
    fn grid(&self) -> Arc<dyn BoxApi>;
    fn now_ms(&self) -> i64;
    /// a sleep that ends early when the hub stops
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()>;
    /// work tied to the hub's scope (a retry later, a reply after the answer went)
    fn spawn(&self, fut: BoxFuture<'static, ()>);
    fn warn(&self, msg: &str);

    /// this channel's config (an object; secrets merged in)
    fn cfg(&self, channel: &str) -> Value;
    /// replaces it and saves: secrets to the secrets file, the rest to the channels table
    fn set_cfg(&self, channel: &str, cfg: Value);
    fn mark(&self, channel: &str, st: Status);
    /// Settings should look again
    fn changed(&self);
    /// restart every transport (a changed config)
    fn restart(&self);
    /// a tunable tests turn down (`ntfyPollMs`, `tgLongPoll`, `slackBackoffMs`, …)
    fn tune(&self, key: &str) -> Option<u64>;

    fn remote_of(&self, session_id: &str) -> Option<Remote>;
    fn set_remote(&self, session_id: &str, remote: Remote);
    fn find_remote(&self, pred: &(dyn Fn(&Remote, &str) -> bool + Send + Sync)) -> Vec<String>;
    fn away(&self, session_id: &str) -> Option<AwayEntry>;
    fn keep_away(&self, session_id: &str, entry: AwayEntry);

    fn sign(&self, session_id: &str, kind: ActionKind, reference: &str, index: u32) -> String;
    fn verify(&self, s: &Signed) -> bool;
    /// where a task started: `(channel, by)`
    fn started_from(&self, session_id: &str) -> Option<(String, Option<String>)>;
    fn mark_started(&self, session_id: &str, channel: &str, by: Option<&str>);
    fn thread_started(&self, s: Option<&SessionView>, thread: Option<&Thread>, by: Option<&str>, err: Option<&str>);
    async fn default_project(&self) -> Option<ProjectView>;
    async fn act(&self, a: &ActArgs) -> Result<String>;

    /// One message through `c`'s door: the grammar and what it asks for (wisp.channels' flow, v1
    /// `converse`). `session_id`: the task its thread belongs to; `thread_text`: the message as it reads
    /// there. Additive (2026-11-10): a hub without the flow says so.
    async fn converse(
        &self,
        _c: &dyn crate::conversation::Conversation,
        _text: &str,
        _session_id: Option<&str>,
        _thread_text: Option<&str>,
    ) -> Result<Value> {
        Err(wisp_kernel::WireError::unavailable("this hub reads no messages"))
    }

    /// sha256 hex (a link guesser's bucket, a hashed sender)
    fn hash(&self, s: &str) -> String;
    /// uniform in `[min, max)`
    fn random_int(&self, min: u32, max: u32) -> u32;
    fn random_hex(&self, bytes: usize) -> String;
}
