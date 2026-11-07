//! The extension point `machines.transport@1` (plan §7.2.2): how a peer is reached. A transport
//! opens a [`Channel`], HTTP requests to the peer's wisp multiplexed over whatever it holds open;
//! the sync protocol (one SSE stream plus POSTs) runs on it. A user's plugin adds a transport
//! (Tailscale-direct, a bastion) by contributing to [`TRANSPORT`], as wisp's own do.
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;
use wisp_kernel::{BoxFuture, CancellationToken, Point, Result};

use crate::commands::{AddArgs, LetInOut};
use crate::rows::{Hint, PeerRow, StepStatus};

/// A request body.
#[derive(Debug, Default)]
pub enum Body {
    #[default]
    Empty,
    Bytes(Vec<u8>),
    /// an upload, piped as it is read
    Stream(mpsc::Receiver<Vec<u8>>),
}

#[derive(Debug, Default)]
pub struct ChannelRequest {
    pub method: String,
    /// the path under `/api`, with its query: `/health`, `/events?topics=list`
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    pub timeout_ms: Option<u64>,
    /// this request must never count as use of the box (a passive subscription, a watch)
    pub passive: bool,
}

impl ChannelRequest {
    pub fn get(path: impl Into<String>) -> Self {
        Self {
            method: "GET".into(),
            path: path.into(),
            ..Self::default()
        }
    }
    /// JSON with an explicit content-length, always: a DELETE's body sent unframed reads as a
    /// broken next request on the far side (an empty 400 in v1).
    pub fn json(method: &str, path: impl Into<String>, body: &Value) -> Self {
        let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
        let headers = vec![
            ("content-type".into(), "application/json".into()),
            ("content-length".into(), bytes.len().to_string()),
        ];
        Self {
            method: method.to_owned(),
            path: path.into(),
            headers,
            body: Body::Bytes(bytes),
            ..Self::default()
        }
    }
}

#[derive(Debug)]
pub struct ChannelResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// the body as it comes; ends when the far side is done (or the request was cancelled)
    pub body: mpsc::Receiver<Vec<u8>>,
    /// stop reading: the request over there is cancelled
    pub cancel: CancellationToken,
}

impl ChannelResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    /// The whole body (bounded by `max` bytes; the rest is dropped).
    pub async fn bytes(mut self, max: usize) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(chunk) = self.body.recv().await {
            let room = max.saturating_sub(out.len());
            out.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if out.len() >= max {
                self.cancel.cancel();
                break;
            }
        }
        out
    }
}

/// Why a channel is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// try again
    Lost,
    /// the box is stopped: watch it without waking
    Asleep,
    /// signed out or removed: stop
    Gone,
    /// we hung up
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelEnd {
    pub reason: EndReason,
    pub error: Option<String>,
    pub hint: Option<Hint>,
    /// retrying won't change the answer
    pub give_up: bool,
}

/// A way to the peer's wisp.
pub trait Channel: Send + Sync + 'static {
    fn request(&self, req: ChannelRequest) -> BoxFuture<'static, Result<ChannelResponse>>;
    /// resolves when the way is gone, and says why (every call gets the same answer)
    fn closed(&self) -> BoxFuture<'static, ChannelEnd>;
    fn close(&self);
    /// where it goes, for the tunnel step (`localhost:51234 → 4477`)
    fn label(&self) -> String;
}

/// What a transport tells the card while it connects.
pub trait ConnectIo: Send + Sync + 'static {
    /// moves a step along (one of the transport's `steps`)
    fn step(&self, id: &str, status: StepStatus, detail: Option<&str>);
    fn log(&self, line: &str);
    /// an older wisp there refused this one: its pid, for Restart
    fn stale(&self, pid: Option<u32>);
    /// the secret kept for this peer (`secret_key(id)`)
    fn secret(&self) -> Option<String>;
}

/// What a transport fails with: the card shows `message` and `hint`; `give_up` stops the retries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransportFailure {
    pub message: String,
    pub hint: Option<Hint>,
    pub give_up: bool,
    pub kind: Option<FailKind>,
    /// an HTTP status to answer with, when a route surfaces it
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailKind {
    /// the box is stopped (watch it)
    Asleep,
    /// signed out or removed
    Gone,
}

impl TransportFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            ..Self::default()
        }
    }
    #[must_use]
    pub fn with_hint(mut self, hint: Hint) -> Self {
        self.hint = Some(hint);
        self
    }
    #[must_use]
    pub fn final_(mut self) -> Self {
        self.give_up = true;
        self
    }
}

impl std::fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for TransportFailure {}

/// What a watch of an asleep peer found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// up again (woken elsewhere: the phone, a schedule): connect
    Running,
    Asleep,
    Gone,
}

/// After `stop_remote`: the grid stopped it (watch it) or it is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    Asleep,
    Off,
}

/// What `start` does with a peer whose row says auto-connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoStart {
    Connect,
    /// watch without waking (opening wisp here mustn't wake a cloud computer)
    Follow,
}

pub type Failing<T> = std::result::Result<T, TransportFailure>;

/// The row fields a transport sets from add/update input.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cleaned {
    pub name: Option<String>,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub command: Option<String>,
    pub auto_connect: Option<bool>,
}

pub trait Transport: Send + Sync + 'static {
    fn kind(&self) -> &str;
    /// the steps a connect goes through, `(id, label)`, shown on the card; the manager runs
    /// `tunnel` and `agents` itself when they are listed
    fn steps(&self) -> &'static [(&'static str, &'static str)];
    /// validates add/update input; the error is in words the page shows
    fn clean(&self, input: &AddArgs, prev: Option<&PeerRow>) -> Failing<Cleaned>;
    /// opens the way; resolves once requests go through
    fn connect(
        &self,
        peer: PeerRow,
        io: Arc<dyn ConnectIo>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Failing<Arc<dyn Channel>>>;
    /// checked while asleep, without waking the box
    fn probe(&self, _peer: PeerRow, _io: Arc<dyn ConnectIo>) -> BoxFuture<'static, Probe> {
        Box::pin(async { Probe::Asleep })
    }
    /// an asleep box still takes requests (they wake it); false for a computer only its owner turns on
    fn wakes_on_request(&self, _peer: &PeerRow) -> bool {
        false
    }
    /// a way that needs no open connection (grid: one HTTPS request each), used while asleep or waking
    fn direct(&self, _peer: &PeerRow, _io: Arc<dyn ConnectIo>) -> Option<Arc<dyn Channel>> {
        None
    }
    /// stops wisp over there; restarting is the manager's
    fn stop_remote(
        &self,
        peer: PeerRow,
        _pid: Option<u32>,
        _io: Arc<dyn ConnectIo>,
    ) -> BoxFuture<'static, Failing<Stopped>> {
        let name = peer.name;
        Box::pin(async move {
            Err(TransportFailure {
                status: Some(400),
                ..TransportFailure::new(format!("wisp on {name} can’t be stopped from here."))
            })
        })
    }
    /// the peer is about to go: tidy up over there; returns other peers that go with it
    fn forget(&self, _peer: PeerRow, _all: Vec<PeerRow>) -> BoxFuture<'static, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
    /// a terminal there running `command` (Take over), or `None` when the transport has none
    fn terminal_argv(&self, _peer: &PeerRow, _command: &str) -> Option<Vec<String>> {
        None
    }
    /// "type your password once" (ssh)
    fn let_in(&self, _peer: PeerRow, _password: String) -> BoxFuture<'static, Failing<LetInOut>> {
        Box::pin(async {
            Err(TransportFailure {
                status: Some(400),
                ..TransportFailure::new(
                    "A cloud computer signs in through its grid: Settings → Cloud.",
                )
            })
        })
    }
    fn auto_start(&self, _peer: &PeerRow) -> AutoStart {
        AutoStart::Connect
    }
}

pub const TRANSPORT: Point<dyn Transport> = Point::new("machines.transport", 1);

/// One action of `/sessions/<id>@<machine>/<action>` another plugin answers (take over, move…).
#[derive(Debug, Clone)]
pub struct ProxyCall {
    pub machine: String,
    /// the id over there
    pub id: String,
    /// the id here, `<id>@<machine>`
    pub qualified: String,
    pub action: String,
    pub method: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    /// what the request came through (x-wisp-tunnel, a proxy): some answers differ for the grid
    pub headers: Vec<(String, String)>,
}

/// `machines.proxy@1`: `None` lets the call pass through to the peer unchanged.
pub trait ProxyAction: Send + Sync + 'static {
    fn action(&self) -> &str;
    fn methods(&self) -> &[&str];
    fn handle(&self, call: ProxyCall) -> BoxFuture<'static, Result<Option<(u16, Value)>>>;
}

pub const PROXY: Point<dyn ProxyAction> = Point::new("machines.proxy", 1);
