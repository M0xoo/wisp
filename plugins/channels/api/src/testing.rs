//! A hub for a transport's tests (no kernel, no network): `TestHub` answers HTTP from a script, opens scripted
//! sockets, keeps configs, remotes, marks and what was said, and records every message the flow was asked to
//! read (`conversed`). Sleeps return at once (each is counted; past `MAX_SLEEPS` the hub's `stop` token is cancelled,
//! so a transport's dial loop ends instead of spinning). Work a transport spawns waits in `spawned` until
//! `run_spawned` awaits it. Sans-IO like the rest of the api crate.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, CancellationToken, Result, WireError};

use crate::conversation::Conversation;
use crate::hub::{AwayEntry, BoxApi, BoxGrid, ChannelHub, ChannelUrl, Exec, ExecOut, HttpRequest, HttpResponse, Later, Net, NetError, Phone, Ws, WsConn, WsFrame};
use crate::transport::Status;
use crate::views::{ActArgs, ActionKind, ChannelCtx, Parsed, ProjectView, Remote, RunOpts, SessionView, Signed, StartOpts, Started, Thread, ThreadCtx};

/// Past this many sleeps the hub stops (a loop that would otherwise dial forever).
pub const MAX_SLEEPS: usize = 64;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An answer for requests whose URL contains `needle`, in order (the last one repeats).
#[derive(Debug, Clone)]
pub struct Reply {
    pub needle: String,
    pub status: u16,
    pub body: Value,
    pub headers: Vec<(String, String)>,
}

impl Reply {
    #[must_use]
    pub fn json(needle: &str, body: Value) -> Self {
        Self { needle: needle.into(), status: 200, body, headers: Vec::new() }
    }
    #[must_use]
    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
    #[must_use]
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

/// HTTP from a script; every request kept.
#[derive(Debug, Default)]
pub struct ScriptNet {
    pub replies: Mutex<Vec<Reply>>,
    pub requests: Mutex<Vec<HttpRequest>>,
}

impl ScriptNet {
    /// The JSON bodies sent to URLs containing `needle`.
    pub fn sent(&self, needle: &str) -> Vec<Value> {
        lock(&self.requests).iter().filter(|r| r.url.contains(needle)).map(|r| serde_json::from_slice(&r.body).unwrap_or(Value::Null)).collect()
    }
}

#[async_trait]
impl Net for ScriptNet {
    async fn fetch(&self, req: HttpRequest) -> std::result::Result<HttpResponse, NetError> {
        let url = req.url.clone();
        lock(&self.requests).push(req);
        let mut replies = lock(&self.replies);
        let n = replies.iter().filter(|r| url.contains(&r.needle)).count();
        let at = replies.iter().position(|r| url.contains(&r.needle)).ok_or_else(|| NetError::Refused(format!("nothing scripted for {url}")))?;
        let r = if n > 1 { replies.remove(at) } else { replies[at].clone() };
        Ok(HttpResponse { status: r.status, headers: r.headers, body: r.body.to_string().into_bytes() })
    }
}

/// In a socket's script: from here it says nothing, and answers no ping.
pub fn quiet() -> WsFrame {
    WsFrame::Binary(b"<quiet>".to_vec())
}

/// One scripted socket: the frames it delivers, then a close.
#[derive(Debug, Default)]
pub struct ScriptConn {
    frames: Mutex<VecDeque<WsFrame>>,
    sent: Arc<Mutex<Vec<String>>>,
    closed: Mutex<bool>,
}

#[async_trait]
impl WsConn for ScriptConn {
    async fn recv(&self) -> Option<WsFrame> {
        if *lock(&self.closed) {
            return None;
        }
        if lock(&self.frames).front() == Some(&quiet()) {
            // a socket that looks open and says nothing (a laptop that slept)
            std::future::pending::<()>().await;
        }
        let next = lock(&self.frames).pop_front();
        if next.is_none() || matches!(next, Some(WsFrame::Close(..))) {
            *lock(&self.closed) = true;
        }
        Some(next.unwrap_or(WsFrame::Close(1006, String::new())))
    }
    async fn send(&self, text: String) -> std::result::Result<(), NetError> {
        lock(&self.sent).push(text);
        Ok(())
    }
    async fn close(&self, _code: u16) {
        *lock(&self.closed) = true;
    }
    /// a scripted socket is alive while it has frames left (a script that ends has gone quiet)
    async fn ping(&self) -> bool {
        lock(&self.sent).push("<ping>".into());
        let f = lock(&self.frames);
        !f.is_empty() && f.front() != Some(&quiet())
    }
}

/// Sockets from a script: each `connect` takes the next list of frames (none left: refused).
#[derive(Debug, Default)]
pub struct ScriptWs {
    pub sockets: Mutex<VecDeque<Vec<WsFrame>>>,
    /// what was sent on any socket, in order
    pub sent: Arc<Mutex<Vec<String>>>,
    pub urls: Mutex<Vec<String>>,
}

impl ScriptWs {
    pub fn push(&self, frames: Vec<WsFrame>) {
        lock(&self.sockets).push_back(frames);
    }
    pub fn text(t: &Value) -> WsFrame {
        WsFrame::Text(t.to_string())
    }
}

#[async_trait]
impl Ws for ScriptWs {
    async fn connect(&self, url: &str) -> std::result::Result<Box<dyn WsConn>, NetError> {
        lock(&self.urls).push(url.to_owned());
        let frames = lock(&self.sockets).pop_front().ok_or_else(|| NetError::Refused("no socket scripted".into()))?;
        Ok(Box::new(ScriptConn { frames: Mutex::new(frames.into()), sent: self.sent.clone(), closed: Mutex::new(false) }))
    }
}

/// Processes from a script: the answer whose needle in `bin args…` is longest (several under one needle go in
/// order, the last one repeats); every run kept.
#[derive(Debug, Default)]
pub struct ScriptExec {
    pub answers: Mutex<Vec<(String, ExecOut)>>,
    pub runs: Mutex<Vec<Vec<String>>>,
}

impl ScriptExec {
    pub fn answer(&self, needle: &str, code: i32, stdout: &str, stderr: &str) {
        lock(&self.answers).push((needle.to_owned(), ExecOut { code, stdout: stdout.to_owned(), stderr: stderr.to_owned() }));
    }
    /// The runs whose command line contains `needle`.
    pub fn ran(&self, needle: &str) -> Vec<Vec<String>> {
        lock(&self.runs).iter().filter(|r| r.join(" ").contains(needle)).cloned().collect()
    }
}

#[async_trait]
impl Exec for ScriptExec {
    async fn run(&self, bin: &str, args: &[String], _stdin: Option<String>, _timeout_ms: u64) -> Result<ExecOut> {
        let line: Vec<String> = std::iter::once(bin.to_owned()).chain(args.iter().cloned()).collect();
        let joined = line.join(" ");
        lock(&self.runs).push(line);
        let mut a = lock(&self.answers);
        // the longest needle that fits is the most specific answer; answers under one needle go in order
        let at = (0..a.len()).filter(|i| joined.contains(a[*i].0.as_str())).max_by_key(|i| (a[*i].0.len(), std::cmp::Reverse(*i))).ok_or_else(|| WireError::unavailable(format!("{bin}: nothing scripted for {joined}")))?;
        let n = a.iter().filter(|(k, _)| *k == a[at].0).count();
        Ok(if n > 1 { a.remove(at).1 } else { a[at].1.clone() })
    }
}

/// A reply mailed through the grid: (the message it answers, subject, text).
pub type Mailed = Arc<Mutex<Vec<(String, String, String)>>>;

/// The grid as a cloud box sees it: `Some` plays a box (`TestHub.on_box`); mail replies are kept.
#[derive(Debug, Default)]
pub struct NoBox(pub Option<BoxGrid>, pub Mailed);

#[async_trait]
impl BoxApi for NoBox {
    fn grid(&self) -> Option<BoxGrid> {
        self.0.clone()
    }
    fn in_box(&self) -> bool {
        self.0.is_some()
    }
    fn bot_mark(&self, token: &str) -> String {
        format!("mark:{}", token.len())
    }
    async fn channel_url(&self, _b: &BoxGrid, _channel: &str, _bot: Option<&str>, _gone: bool) -> Result<Option<ChannelUrl>> {
        Ok(None)
    }
    async fn rotate_url(&self, _b: &BoxGrid, _channel: &str) -> Result<ChannelUrl> {
        Err(WireError::unavailable("not a cloud wisp"))
    }
    async fn mail_reply(&self, _b: &BoxGrid, reply_to: &str, subject: &str, text: &str) -> Result<Option<String>> {
        let mut m = lock(&self.1);
        m.push((reply_to.to_owned(), subject.to_owned(), text.to_owned()));
        Ok(Some(format!("<r{}@wisp>", m.len())))
    }
    async fn set_channel_key(&self, _b: &BoxGrid, _channel: &str, _key: &str, _linked: &[String]) -> Result<bool> {
        Ok(false)
    }
}

/// wisp as the flow sees it: a fixed context; counts and heard messages kept; nothing starts.
#[derive(Debug, Default)]
pub struct TestPhone {
    pub ctx: ChannelCtx,
    pub counts: Mutex<Vec<(String, Option<String>)>>,
    pub heard: Mutex<Vec<(String, String, String)>>,
    /// files kept as uploads: (name, mime, bytes)
    pub uploads: Mutex<Vec<(String, String, Vec<u8>)>>,
}

#[async_trait]
impl Phone for TestPhone {
    async fn context(&self) -> Result<ChannelCtx> {
        Ok(self.ctx.clone())
    }
    fn count(&self, kind: &str, detail: Option<&str>) {
        lock(&self.counts).push((kind.to_owned(), detail.map(str::to_owned)));
    }
    fn on_grid(&self) -> bool {
        false
    }
    async fn grid_reply(&self, _thread: &str, _text: &str) -> Result<()> {
        Err(WireError::unavailable("not on a grid"))
    }
    fn thread_saved(&self) {}
    fn heard(&self, channel: &str, sender: &str, text: &str) {
        lock(&self.heard).push((channel.to_owned(), sender.to_owned(), text.to_owned()));
    }
    async fn thread_ctx(&self, _session_id: &str) -> Result<ThreadCtx> {
        Ok(ThreadCtx::default())
    }
    async fn start_parsed(&self, _p: &Parsed, _o: &StartOpts) -> Result<Started> {
        Err(WireError::unavailable("a test phone starts nothing"))
    }
    async fn stop(&self, _session_id: &str) -> Result<String> {
        Ok("■ Stopped.".into())
    }
    async fn status(&self, _session_id: &str) -> Result<String> {
        Ok(String::new())
    }
    async fn run(&self, _session_id: &str, _p: &Parsed, _o: &RunOpts, _later: Option<Later>) -> Result<String> {
        Ok("✓ Sent.".into())
    }
    async fn mention(&self, _session_id: &str, _p: &Parsed, _o: &StartOpts) -> Result<Started> {
        Err(WireError::unavailable("a test phone starts nothing"))
    }
    async fn launch(&self, _project: &ProjectView, _prompt: &str) -> Result<Option<SessionView>> {
        Ok(None)
    }
    async fn upload(&self, name: &str, mime: &str, bytes: Vec<u8>) -> Result<Value> {
        let mut u = lock(&self.uploads);
        let size = bytes.len();
        u.push((name.to_owned(), mime.to_owned(), bytes));
        Ok(serde_json::json!({ "id": format!("u{}", u.len()), "name": name, "mime": mime, "size": size }))
    }
    async fn act(&self, _a: &ActArgs) -> Result<String> {
        Ok("✓ Done.".into())
    }
    async fn projects(&self) -> Result<Vec<ProjectView>> {
        Ok(self.ctx.projects.clone())
    }
    async fn session(&self, _id: &str) -> Result<Option<SessionView>> {
        Ok(None)
    }
    async fn sessions(&self) -> Result<Vec<SessionView>> {
        Ok(Vec::new())
    }
}

/// One message the flow was asked to read.
#[derive(Debug, Clone, PartialEq)]
pub struct Conversed {
    pub channel: String,
    pub sender: String,
    pub text: String,
    pub session: Option<String>,
    /// what the transport's thread was for it
    pub thread: Option<Thread>,
    /// the files it brought (uploads)
    pub attachments: Vec<Value>,
}

/// The hub. `reply`: what the flow says back through the conversation's door (`say`), when set; a session id in
/// `start_as` plays a task starting there (the door's `acked` gets a thread with it).
#[derive(Default)]
pub struct TestHub {
    pub phone: Arc<TestPhone>,
    pub net: Arc<ScriptNet>,
    pub ws: Arc<ScriptWs>,
    pub exec: Arc<ScriptExec>,
    pub now: Mutex<i64>,
    pub cfgs: Mutex<BTreeMap<String, Value>>,
    pub marks: Mutex<Vec<(String, Status)>>,
    pub remotes: Mutex<BTreeMap<String, Remote>>,
    pub away: Mutex<BTreeMap<String, AwayEntry>>,
    pub started: Mutex<BTreeMap<String, (String, Option<String>)>>,
    pub warned: Mutex<Vec<String>>,
    pub tunes: BTreeMap<String, u64>,
    pub sleeps: Mutex<Vec<u64>>,
    pub spawned: Mutex<Vec<BoxFuture<'static, ()>>>,
    pub conversed: Mutex<Vec<Conversed>>,
    pub reply: Option<String>,
    pub start_as: Option<String>,
    pub stop: CancellationToken,
    pub n: Mutex<u32>,
    /// play a cloud box on this grid
    pub on_box: Option<BoxGrid>,
    /// replies mailed through it
    pub mailed: Mailed,
}

impl std::fmt::Debug for TestHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestHub").field("cfgs", &*lock(&self.cfgs)).field("marks", &lock(&self.marks).len()).finish_non_exhaustive()
    }
}

impl TestHub {
    #[must_use]
    pub fn with_cfg(self, channel: &str, cfg: Value) -> Self {
        lock(&self.cfgs).insert(channel.to_owned(), cfg);
        self
    }
    /// Awaits what transports spawned (and what that spawned), in order.
    pub async fn run_spawned(&self) {
        loop {
            let next: Vec<_> = lock(&self.spawned).drain(..).collect();
            if next.is_empty() {
                return;
            }
            for f in next {
                f.await;
            }
        }
    }
    pub fn last_mark(&self, channel: &str) -> Option<Status> {
        lock(&self.marks).iter().rev().find(|(c, _)| c == channel).map(|(_, s)| s.clone())
    }
    pub fn conversed(&self) -> Vec<Conversed> {
        lock(&self.conversed).clone()
    }
}

#[async_trait]
impl ChannelHub for TestHub {
    fn phone(&self) -> Arc<dyn Phone> {
        self.phone.clone()
    }
    fn net(&self) -> Arc<dyn Net> {
        self.net.clone()
    }
    fn ws(&self) -> Arc<dyn Ws> {
        self.ws.clone()
    }
    fn exec(&self) -> Arc<dyn Exec> {
        self.exec.clone()
    }
    fn grid(&self) -> Arc<dyn BoxApi> {
        Arc::new(NoBox(self.on_box.clone(), self.mailed.clone()))
    }
    fn now_ms(&self) -> i64 {
        *lock(&self.now)
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        let mut s = lock(&self.sleeps);
        s.push(ms);
        if s.len() >= MAX_SLEEPS {
            self.stop.cancel();
        }
        *lock(&self.now) += i64::try_from(ms).unwrap_or(i64::MAX / 4);
        Box::pin(async {})
    }
    fn spawn(&self, fut: BoxFuture<'static, ()>) {
        lock(&self.spawned).push(fut);
    }
    fn warn(&self, msg: &str) {
        lock(&self.warned).push(msg.to_owned());
    }
    fn cfg(&self, channel: &str) -> Value {
        lock(&self.cfgs).get(channel).cloned().unwrap_or_else(|| json!({}))
    }
    fn set_cfg(&self, channel: &str, cfg: Value) {
        lock(&self.cfgs).insert(channel.to_owned(), cfg);
    }
    fn mark(&self, channel: &str, st: Status) {
        lock(&self.marks).push((channel.to_owned(), st));
    }
    fn changed(&self) {}
    fn restart(&self) {}
    fn tune(&self, key: &str) -> Option<u64> {
        self.tunes.get(key).copied()
    }
    fn remote_of(&self, session_id: &str) -> Option<Remote> {
        lock(&self.remotes).get(session_id).cloned()
    }
    fn set_remote(&self, session_id: &str, remote: Remote) {
        lock(&self.remotes).insert(session_id.to_owned(), remote);
    }
    fn find_remote(&self, pred: &(dyn Fn(&Remote, &str) -> bool + Send + Sync)) -> Vec<String> {
        lock(&self.remotes).iter().filter(|(id, r)| pred(r, id)).map(|(id, _)| id.clone()).collect()
    }
    fn away(&self, session_id: &str) -> Option<AwayEntry> {
        lock(&self.away).get(session_id).cloned()
    }
    fn keep_away(&self, session_id: &str, entry: AwayEntry) {
        lock(&self.away).insert(session_id.to_owned(), entry);
    }
    fn sign(&self, session_id: &str, kind: ActionKind, reference: &str, index: u32) -> String {
        format!("sig:{session_id}:{}:{reference}:{index}", kind.code())
    }
    fn verify(&self, s: &Signed) -> bool {
        s.sig == format!("sig:{}:{}:{}:{}", s.s, s.k, s.r, s.i)
    }
    fn started_from(&self, session_id: &str) -> Option<(String, Option<String>)> {
        lock(&self.started).get(session_id).cloned()
    }
    fn mark_started(&self, session_id: &str, channel: &str, by: Option<&str>) {
        lock(&self.started).insert(session_id.to_owned(), (channel.to_owned(), by.map(str::to_owned)));
    }
    fn thread_started(&self, _s: Option<&SessionView>, _thread: Option<&Thread>, _by: Option<&str>, _err: Option<&str>) {}
    async fn default_project(&self) -> Option<ProjectView> {
        self.phone.ctx.projects.first().cloned()
    }
    async fn act(&self, a: &ActArgs) -> Result<String> {
        self.phone.act(a).await
    }
    async fn converse(&self, c: &dyn Conversation, text: &str, session_id: Option<&str>, _thread_text: Option<&str>) -> Result<Value> {
        let thread = c.thread(&Parsed::default()).await;
        lock(&self.conversed).push(Conversed { channel: c.channel().to_owned(), sender: c.sender().to_owned(), text: text.to_owned(), session: session_id.map(str::to_owned), thread: thread.clone(), attachments: c.attachments() });
        let Some(reply) = &self.reply else { return Ok(Value::Null) };
        let sent = c.say(reply.clone()).await?;
        if let (Some(sid), Some(mut t)) = (self.start_as.as_ref(), thread) {
            t.session = Some(sid.clone());
            c.acked(Some(&t), &sent);
        }
        Ok(sent)
    }
    fn hash(&self, s: &str) -> String {
        // FNV-1a: stable, enough to tell two inputs apart in a test
        let h = s.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
        format!("{h:016x}")
    }
    fn random_int(&self, min: u32, max: u32) -> u32 {
        let mut n = lock(&self.n);
        *n = n.wrapping_add(1);
        min + *n % max.saturating_sub(min).max(1)
    }
    fn random_hex(&self, bytes: usize) -> String {
        let n = self.random_int(0, u32::MAX);
        format!("{n:0width$x}", width = bytes * 2).chars().take(bytes * 2).collect()
    }
}
