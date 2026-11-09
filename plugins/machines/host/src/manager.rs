//! A peer's connection, run as one task of the plugin's scope per attempt: the transport opens the
//! way, the manager checks wisp answers through it (`tunnel`) and finds its harnesses (`agents`),
//! then the sync link runs until it ends. What each event means is core's `Conn` (v1's rules:
//! reconnect only once it has worked, 2/5/15/30/60 s; a bootstrap `fail` gives up).
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use wisp_kernel::CancellationToken;
use wisp_kernel::services;
use wisp_machines_api::{AutoStart, Channel, ChannelRequest, ConnectIo, Offline, Online, PeerState, Probe, RemoteAgent, StepStatus, Transport, secret_key};
use wisp_machines_core::bootstrap::{AGENTS, TUNNEL};
use wisp_machines_core::conn::{Conn, GRID_WATCH_MS, NO_TUNNEL, Next, TUNNEL_GAP_MS, TUNNEL_TRIES};
use wisp_machines_core::{reply, view};

use crate::error::Res;
use crate::link::{self, End};
use crate::{State, lock};

/// What a transport tells the card while it connects.
pub(crate) struct PeerIo {
    st: Option<Weak<State>>,
    id: String,
    secret: Option<String>,
}

impl std::fmt::Debug for PeerIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerIo").field("id", &self.id).finish_non_exhaustive()
    }
}

impl PeerIo {
    /// For a request that shows nothing on the card (a direct channel).
    pub fn quiet(id: &str) -> Self {
        Self { st: None, id: id.to_owned(), secret: None }
    }
    fn on(&self, f: impl FnOnce(&State, &mut Conn) -> bool) {
        let Some(st) = self.st.as_ref().and_then(Weak::upgrade) else { return };
        if st.with_link(&self.id, |l| f(&st, &mut l.conn)) == Some(true) {
            st.publish(&self.id);
        }
    }
}

impl ConnectIo for PeerIo {
    fn step(&self, id: &str, status: StepStatus, detail: Option<&str>) {
        self.on(|_, c| c.step(id, status, detail));
    }
    fn log(&self, line: &str) {
        self.on(|_, c| {
            c.push_log(line);
            false
        });
    }
    fn stale(&self, pid: Option<u32>) {
        self.on(|_, c| {
            c.status.stale = pid;
            true
        });
    }
    fn secret(&self) -> Option<String> {
        self.secret.clone()
    }
}

/// Connects every peer that says so (a cloud computer is only watched: opening wisp mustn't wake it).
pub(crate) fn start_all(st: &Arc<State>) {
    for p in st.peers().into_iter().filter(|p| p.auto_connect) {
        let Ok(t) = st.transport(&p.transport) else { continue };
        let _ = match t.auto_start(&p) {
            AutoStart::Connect => connect(st, &p.id, false),
            AutoStart::Follow => follow(st, &p.id),
        };
    }
}

/// A new attempt for this peer: the old one (and its channel) is hung up first.
fn begin(st: &Arc<State>, id: &str, steps: &[(&str, &str)], retry: bool, grid: bool) -> CancellationToken {
    let token = st.ctx.scope().child_token();
    st.with_link(id, |l| {
        if let Some(old) = l.token.replace(token.clone()) {
            old.cancel();
        }
        if let Some(ch) = l.channel.take() {
            ch.close();
        }
        l.post = None;
        l.conn = Conn::start(id, steps, grid, retry, Some(&l.conn));
    });
    st.publish(id);
    token
}

pub(crate) fn connect(st: &Arc<State>, id: &str, retry: bool) -> Res<()> {
    let row = st.peer(id)?;
    let t = st.transport(&row.transport)?;
    let token = begin(st, id, t.steps(), retry, row.is_grid());
    let (st2, id2) = (st.clone(), id.to_owned());
    st.ctx.spawn(async move { run(st2, id2, t, token).await });
    Ok(())
}

async fn sleep(st: &State, ms: u64) {
    match st.ctx.clock() {
        Ok(c) => c.sleep(ms).await,
        Err(_) => tokio::time::sleep(Duration::from_millis(ms)).await,
    }
}

async fn run(st: Arc<State>, id: String, t: Arc<dyn Transport>, token: CancellationToken) {
    loop {
        let Next::RetryIn(ms) = attempt(&st, &id, t.as_ref(), &token).await else { return };
        tokio::select! {
            () = token.cancelled() => return,
            () = sleep(&st, ms) => {}
        }
        let Ok(row) = st.peer(&id) else { return };
        st.with_link(&id, |l| l.conn = Conn::start(&id, t.steps(), row.is_grid(), true, Some(&l.conn)));
        st.publish(&id);
    }
}

/// `f` on the connection, then the card is written; its answer is what to do next.
fn on_conn(st: &State, id: &str, f: impl FnOnce(&mut Conn) -> Next) -> Next {
    let next = st.with_link(id, |l| f(&mut l.conn)).unwrap_or(Next::Nothing);
    st.publish(id);
    next
}

async fn attempt(st: &Arc<State>, id: &str, t: &dyn Transport, token: &CancellationToken) -> Next {
    let Ok(row) = st.peer(id) else { return Next::Nothing };
    let secret = match services::secrets(&st.ctx) {
        Ok(s) => s.get(&secret_key(id)).await.ok().flatten(),
        Err(_) => None,
    };
    let io: Arc<dyn ConnectIo> = Arc::new(PeerIo { st: Some(Arc::downgrade(st)), id: id.to_owned(), secret });
    let ch = tokio::select! {
        () = token.cancelled() => return Next::Nothing,
        r = t.connect(row.clone(), io, token.child_token()) => r,
    };
    let ch = match ch {
        Ok(ch) => ch,
        Err(f) => {
            return on_conn(st, id, |c| {
                c.give_up |= f.give_up;
                c.fail(&f.message, f.hint.clone(), true);
                c.closed(None, &row.address)
            });
        }
    };
    st.with_link(id, |l| l.channel = Some(ch.clone()));
    let lists = |s: &str| t.steps().iter().any(|(x, _)| *x == s);
    let health = if lists(TUNNEL) { tunnel(st, id, ch.as_ref(), token).await } else { health(ch.as_ref()).await };
    let Some(health) = health else {
        ch.close();
        return if token.is_cancelled() { Next::Nothing } else { on_conn(st, id, |c| { c.fail(NO_TUNNEL, None, false); c.closed(None, &row.address) }) };
    };
    let agents = if lists(AGENTS) { agents(ch.as_ref(), None).await } else { Vec::new() };
    let (now, label) = (st.now(), ch.label());
    let s = |k: &str| health.get(k).and_then(Value::as_str).map(str::to_owned);
    let pid = health.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok());
    on_conn(st, id, |c| {
        c.online(&label, agents, s("home"), s("version"), pid, wisp_protocol::PROTO, now);
        Next::Nothing
    });
    st.ctx.emit(&st.ctx.root_call(), &Online { id: id.to_owned() });
    let end = link::run(st, id, &ch, token).await;
    after(st, id, &row.address, ch, end).await
}

/// The link ended: hung up by hand, refused (incompatible), or lost (reconnect, if it had worked).
async fn after(st: &Arc<State>, id: &str, address: &str, ch: Arc<dyn Channel>, end: End) -> Next {
    st.save_sync(id, true);
    let state = |st: &State| st.with_link(id, |l| l.conn.status.state).unwrap_or(PeerState::Off);
    match end {
        End::Cancelled | End::Incompatible => {
            ch.close();
            st.ctx.emit(&st.ctx.root_call(), &Offline { id: id.to_owned(), state: state(st) });
            Next::Nothing
        }
        End::Lost => {
            let hang_up = on_conn(st, id, Conn::stream_lost) == Next::HangUp;
            if hang_up {
                ch.close();
            }
            let gone = ch.closed().await;
            let next = on_conn(st, id, |c| {
                if let (Some(e), true) = (gone.error, c.status.error.is_empty()) {
                    c.status.error = e;
                }
                c.hung_up = false;
                c.closed(None, address)
            });
            st.with_link(id, |l| l.channel = None);
            st.ctx.emit(&st.ctx.root_call(), &Offline { id: id.to_owned(), state: state(st) });
            next
        }
    }
}

/// `GET /health` through the channel: wisp's answer, or `None`.
pub(crate) async fn health(ch: &dyn Channel) -> Option<Value> {
    let r = ch.request(ChannelRequest { timeout_ms: Some(3_000), passive: true, ..ChannelRequest::get("/health") }).await.ok()?;
    if r.status != 200 {
        return None;
    }
    let v = reply::parse_reply(&r.bytes(64 * 1024).await);
    (v.get("name").and_then(Value::as_str) == Some("wisp")).then_some(v)
}

/// The `tunnel` step: wisp answers through the way within 40 × 250 ms.
async fn tunnel(st: &State, id: &str, ch: &dyn Channel, token: &CancellationToken) -> Option<Value> {
    for _ in 0..TUNNEL_TRIES {
        if token.is_cancelled() {
            return None;
        }
        if let Some(h) = health(ch).await {
            let label = ch.label();
            if st.with_link(id, |l| l.conn.step(TUNNEL, StepStatus::Done, Some(&label))) == Some(true) {
                st.publish(id);
            }
            return Some(h);
        }
        sleep(st, TUNNEL_GAP_MS).await;
    }
    None
}

/// A command on the peer through `POST /api/cmd` (its own idempotency key).
pub(crate) async fn cmd(ch: &dyn Channel, name: &str, args: Value) -> Option<Value> {
    let key = format!("machines-{:016x}", rand::random::<u64>());
    let mut req = ChannelRequest::json("POST", "/cmd", &json!({ "cmd": name, "args": args }));
    req.headers.push(("idempotency-key".into(), key));
    req.timeout_ms = Some(30_000);
    let r = ch.request(req).await.ok()?;
    let v = reply::parse_reply(&r.bytes(4 * 1024 * 1024).await);
    (v.get("ok") == Some(&Value::Bool(true))).then(|| v.get("result").cloned().unwrap_or(Value::Null))
}

/// The peer's harnesses (`runtime.agents`); `fresh`: detect again first.
pub(crate) async fn agents(ch: &dyn Channel, fresh: Option<&str>) -> Vec<RemoteAgent> {
    let args = fresh.map_or_else(|| json!({}), |f| json!({ "fresh": f }));
    cmd(ch, "runtime.agents", args).await.map(|v| view::remote_agents(&v)).unwrap_or_default()
}

/// Hung up by hand: nothing reconnects it.
pub(crate) fn disconnect(st: &State, id: &str) {
    st.with_link(id, |l| {
        if let Some(t) = l.token.take() {
            t.cancel();
        }
        if let Some(ch) = l.channel.take() {
            ch.close();
        }
        l.post = None;
        l.conn.disconnect(false);
    });
    st.publish(id);
}

/// Watched without waking it: the transport's probe, every 20 s, until it runs (then connect).
pub(crate) fn follow(st: &Arc<State>, id: &str) -> Res<()> {
    let row = st.peer(id)?;
    let t = st.transport(&row.transport)?;
    let token = begin(st, id, &[], false, row.is_grid());
    on_conn(st, id, |c| c.asleep(GRID_WATCH_MS));
    let (st2, id2) = (st.clone(), id.to_owned());
    st.ctx.spawn(async move {
        loop {
            tokio::select! {
                () = token.cancelled() => return,
                () = sleep(&st2, GRID_WATCH_MS) => {}
            }
            let Ok(row) = st2.peer(&id2) else { return };
            match t.probe(row, Arc::new(PeerIo::quiet(&id2))).await {
                Probe::Asleep => {}
                Probe::Running => {
                    let _ = connect(&st2, &id2, false);
                    return;
                }
                Probe::Gone => {
                    disconnect(&st2, &id2);
                    return;
                }
            }
        }
    });
    Ok(())
}

/// The ids of peers whose link is running (online or on its way).
pub(crate) fn active(st: &State) -> Vec<String> {
    lock(&st.links).iter().filter(|(_, l)| l.token.as_ref().is_some_and(|t| !t.is_cancelled())).map(|(id, _)| id.clone()).collect()
}
