//! The v2 sync stream (ADR-0005): wisp-sync's sans-IO `SyncServer`, carried onto sockets. One task owns
//! the machine; everything reaches it as a message, and it does what the machine returns: frames go to
//! each stream's queue, snapshot and window reads go to `Snapshots` (the store, once it lands), commands
//! go to `Backend::call` (once per mid), and the clock wakes it only when the machine asks
//! (`next_wake_at`): an idle wisp does no work.
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use wisp_kernel::{BoxFuture, Caller, Result, WireError};
use wisp_protocol::{Notice, PeerInfo, Row, Topic};
use wisp_sync::{
    ChangeRow, CommandOutcome, ConnId, ConnectQuery, Gone, Input, Output, SnapshotAnswer,
    SyncOptions, SyncServer,
};

use crate::backend::Backend;
use crate::sync::{Idempotency, SyncMount, command_answer};

/// A stream may fall this far behind before it is closed (the client resumes from its cursor).
const QUEUE: usize = 4096;

/// A topic's rows as the store reads them.
#[derive(Debug, Clone, Default)]
pub struct Read {
    pub seq: u64,
    pub rows: Vec<Row>,
    /// false: only rows changed since `since`, with `deleted`
    pub full: bool,
    pub deleted: Vec<Gone>,
}

/// What the stream reads (wisp-store and each plugin's topic, wired by the binary).
pub trait Snapshots: Send + Sync + 'static {
    fn epoch(&self) -> String;
    fn head_seq(&self) -> u64;
    fn oldest_seq(&self) -> u64;
    fn snapshot(&self, topic: &Topic, since: Option<u64>) -> BoxFuture<'static, Read>;
    /// events before `before_seq`, newest first: (rows, done)
    fn window(
        &self,
        topic: &Topic,
        before_seq: u64,
        limit: u32,
    ) -> BoxFuture<'static, (Vec<Row>, bool)>;
}

/// No store in this build: every topic is empty at seq 0.
#[derive(Debug, Clone)]
pub struct Empty {
    pub epoch: String,
}

impl Snapshots for Empty {
    fn epoch(&self) -> String {
        self.epoch.clone()
    }
    fn head_seq(&self) -> u64 {
        0
    }
    fn oldest_seq(&self) -> u64 {
        0
    }
    fn snapshot(&self, _: &Topic, _: Option<u64>) -> BoxFuture<'static, Read> {
        Box::pin(async {
            Read {
                full: true,
                ..Read::default()
            }
        })
    }
    fn window(&self, _: &Topic, _: u64, _: u32) -> BoxFuture<'static, (Vec<Row>, bool)> {
        Box::pin(async { (Vec::new(), true) })
    }
}

enum Msg {
    Open {
        conn: ConnId,
        caller: Caller,
        query: ConnectQuery,
        tx: mpsc::Sender<Bytes>,
        queued: Arc<AtomicUsize>,
    },
    Post {
        caller: Caller,
        client: String,
        body: Value,
        reply: oneshot::Sender<Result<()>>,
    },
    In(Input<Caller>),
    /// the socket went away
    Gone(ConnId),
}

pub struct Driver {
    tx: mpsc::UnboundedSender<Msg>,
    next: AtomicU64,
    active: Arc<AtomicUsize>,
    snaps: Arc<dyn Snapshots>,
}

impl std::fmt::Debug for Driver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Driver")
            .field("active", &self.active.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

fn now_ms() -> u64 {
    u64::try_from(crate::edge::now_ms()).unwrap_or(0)
}

/// `topic:read{topic:<t>}` decides who reads what (plan §6.5).
fn can_read(backend: Arc<dyn Backend>) -> wisp_sync::CanRead<Caller> {
    Box::new(move |c: &Caller, t: &Topic| {
        backend
            .explain(c, &format!("topic:read{{topic:{}}}", t.as_str()))
            .is_ok()
    })
}

impl Driver {
    /// Starts the machine's task; it ends when the last handle (and every stream) is gone.
    pub fn start(
        snaps: Arc<dyn Snapshots>,
        backend: Arc<dyn Backend>,
        peer: PeerInfo,
    ) -> Arc<Self> {
        let opts = SyncOptions::new(
            snaps.epoch(),
            peer,
            snaps.head_seq(),
            snaps.oldest_seq(),
            can_read(backend.clone()),
        );
        let (tx, rx) = mpsc::unbounded_channel();
        let active = Arc::new(AtomicUsize::new(0));
        let me = Arc::new(Self {
            tx: tx.clone(),
            next: AtomicU64::new(1),
            active: active.clone(),
            snaps: snaps.clone(),
        });
        let actor = Actor {
            server: SyncServer::new(opts),
            conns: HashMap::new(),
            tx,
            snaps,
            backend,
            idem: Arc::new(Idempotency::default()),
            active,
        };
        tokio::spawn(actor.run(rx));
        me
    }

    /// The store committed: rows for every stream that holds their topics.
    pub fn committed(&self, rows: Vec<ChangeRow>) {
        let _ = self.tx.send(Msg::In(Input::Committed { rows }));
    }

    /// Retention moved: cursors below `oldest_seq` can no longer resume.
    pub fn retained(&self, oldest_seq: u64) {
        let _ = self.tx.send(Msg::In(Input::Retained { oldest_seq }));
    }
}

fn connect_query(q: Vec<(String, String)>, last_event_id: Option<String>) -> ConnectQuery {
    let mut c = ConnectQuery {
        last_event_id,
        ..ConnectQuery::default()
    };
    for (k, v) in q {
        let slot = match k.as_str() {
            "proto_min" => &mut c.proto_min,
            "proto_max" => &mut c.proto_max,
            "client_id" => &mut c.client_id,
            "build" => &mut c.build,
            "epoch" => &mut c.epoch,
            "cursor" => &mut c.cursor,
            "topics" => &mut c.topics,
            "fresh" => &mut c.fresh,
            "passive" => &mut c.passive,
            _ => continue,
        };
        *slot = Some(v);
    }
    c
}

impl SyncMount for Driver {
    fn events(
        &self,
        caller: Caller,
        query: Vec<(String, String)>,
        last_event_id: Option<String>,
    ) -> Result<mpsc::Receiver<Bytes>> {
        let conn = ConnId(self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, mut queue) = mpsc::channel::<Bytes>(QUEUE);
        let (out, rx) = mpsc::channel::<Bytes>(16);
        let queued = Arc::new(AtomicUsize::new(0));
        // the pump hands frames to the socket as it takes them: what's left in `queue` is the backlog
        // the machine sees; a client gone ends the pump, which closes `queue`, which closes the stream
        let (left, actor) = (queued.clone(), self.tx.clone());
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    b = queue.recv() => {
                        let Some(b) = b else { break };
                        left.fetch_sub(b.len(), Ordering::Relaxed);
                        if out.send(b).await.is_err() {
                            break;
                        }
                    }
                    () = out.closed() => break,
                }
            }
            let _ = actor.send(Msg::Gone(conn));
        });
        self.tx
            .send(Msg::Open {
                conn,
                caller,
                query: connect_query(query, last_event_id),
                tx,
                queued,
            })
            .map_err(|_| WireError::unavailable("the sync stream stopped"))?;
        Ok(rx)
    }

    fn message(
        &self,
        caller: Caller,
        client: String,
        body: Bytes,
    ) -> BoxFuture<'static, Result<()>> {
        let tx = self.tx.clone();
        Box::pin(async move {
            let body: Value = serde_json::from_slice(&body)
                .map_err(|e| WireError::invalid(format!("message: {e}")))?;
            let (reply, rx) = oneshot::channel();
            tx.send(Msg::Post {
                caller,
                client,
                body,
                reply,
            })
            .map_err(|_| WireError::unavailable("the sync stream stopped"))?;
            rx.await
                .map_err(|_| WireError::unavailable("the sync stream stopped"))?
        })
    }

    fn notice(&self, kind: &str, data: &Value, topic: Option<&str>) {
        let notice = Notice {
            t: wisp_protocol::tag::Notice,
            kind: kind.to_owned(),
            data: data.clone(),
        };
        let _ = self.tx.send(Msg::In(Input::Notice {
            notice,
            topic: topic.and_then(Topic::parse),
        }));
    }

    fn looking(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }

    fn head_seq(&self) -> i64 {
        i64::try_from(self.snaps.head_seq()).unwrap_or(i64::MAX)
    }
}

struct Stream {
    tx: mpsc::Sender<Bytes>,
    caller: Caller,
    /// bytes queued and not yet written to the socket: the machine's backpressure signal
    queued: Arc<AtomicUsize>,
    active: bool,
}

struct Actor {
    server: SyncServer<Caller>,
    conns: HashMap<ConnId, Stream>,
    tx: mpsc::UnboundedSender<Msg>,
    snaps: Arc<dyn Snapshots>,
    backend: Arc<dyn Backend>,
    idem: Arc<Idempotency>,
    active: Arc<AtomicUsize>,
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        loop {
            let wake = self
                .server
                .next_wake_at()
                .map(|at| at.saturating_sub(now_ms()));
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => Some(m), None => return },
                () = sleep(wake) => None,
            };
            match msg {
                Some(Msg::Open {
                    conn,
                    caller,
                    query,
                    tx,
                    queued,
                }) => {
                    self.conns.insert(
                        conn,
                        Stream {
                            tx,
                            caller: caller.clone(),
                            queued,
                            active: false,
                        },
                    );
                    self.feed(Input::Connect {
                        conn,
                        caller,
                        query,
                    });
                }
                Some(Msg::Post {
                    caller,
                    client,
                    body,
                    reply,
                }) => {
                    let _ = reply.send(self.post(&caller, &client, body));
                }
                Some(Msg::In(input)) => self.feed(input),
                Some(Msg::Gone(conn)) => {
                    if self.conns.contains_key(&conn) {
                        self.close(conn);
                        self.feed(Input::Close { conn });
                    }
                }
                None => self.feed(Input::Tick),
            }
            self.reap();
        }
    }

    fn post(&mut self, caller: &Caller, client: &str, message: Value) -> Result<()> {
        let conn = self.server.conn_of(client).ok_or_else(|| {
            WireError::not_found("no open stream for this client: open GET /api/events first")
        })?;
        // a stream's messages come from whoever opened it, never another caller
        let owner = self.conns.get(&conn).map(|s| &s.caller);
        if owner.is_none_or(|c| c.set != caller.set || c.session != caller.session) {
            return Err(WireError::forbidden(
                "that stream belongs to another caller",
            ));
        }
        self.feed(Input::Message { conn, message });
        Ok(())
    }

    /// Streams whose socket went away: closed in the machine too.
    fn reap(&mut self) {
        let gone: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, s)| s.tx.is_closed())
            .map(|(c, _)| *c)
            .collect();
        for c in gone {
            self.close(c);
            self.feed(Input::Close { conn: c });
        }
    }

    fn close(&mut self, conn: ConnId) {
        if let Some(s) = self.conns.remove(&conn)
            && s.active
        {
            self.active.fetch_sub(1, Ordering::Relaxed);
        }
    }

    fn feed(&mut self, first: Input<Caller>) {
        let mut inputs = vec![first];
        while let Some(input) = inputs.pop() {
            let mut sent: Vec<ConnId> = Vec::new();
            for out in self.server.handle(input, now_ms()) {
                self.carry(out, &mut sent);
            }
            sent.sort_unstable();
            sent.dedup();
            for conn in sent {
                if let Some(s) = self.conns.get(&conn) {
                    inputs.push(Input::Drained {
                        conn,
                        buffered_bytes: s.queued.load(Ordering::Relaxed),
                    });
                }
            }
        }
    }

    fn carry(&mut self, out: Output<Caller>, sent: &mut Vec<ConnId>) {
        match out {
            Output::Send { conn, frame, .. } => {
                let ok = self.conns.get(&conn).is_some_and(|s| {
                    s.queued.fetch_add(frame.len(), Ordering::Relaxed);
                    s.tx.try_send(Bytes::from(frame)).is_ok()
                });
                if ok {
                    sent.push(conn);
                } else {
                    self.close(conn);
                }
            }
            Output::Activity { conn, active } => {
                if let Some(s) = self.conns.get_mut(&conn).filter(|s| s.active != active) {
                    s.active = active;
                    if active {
                        self.active.fetch_add(1, Ordering::Relaxed)
                    } else {
                        self.active.fetch_sub(1, Ordering::Relaxed)
                    };
                }
            }
            Output::Close { conn, .. } => self.close(conn),
            Output::SnapshotRequest {
                conn,
                topic,
                since,
                req,
            } => {
                let (snaps, tx) = (self.snaps.clone(), self.tx.clone());
                tokio::spawn(async move {
                    let r = snaps.snapshot(&topic, since).await;
                    let a = SnapshotAnswer {
                        conn,
                        topic,
                        req,
                        seq: r.seq,
                        rows: r.rows,
                        full: r.full || since.is_none(),
                        deleted: r.deleted,
                        more: false,
                    };
                    let _ = tx.send(Msg::In(Input::SnapshotRows(a)));
                });
            }
            Output::WindowRequest {
                conn,
                req,
                topic,
                before_seq,
                limit,
            } => {
                let (snaps, tx) = (self.snaps.clone(), self.tx.clone());
                tokio::spawn(async move {
                    let (rows, done) = snaps.window(&topic, before_seq, limit).await;
                    let _ = tx.send(Msg::In(Input::WindowRows {
                        conn,
                        req,
                        rows,
                        done,
                    }));
                });
            }
            Output::Command {
                conn,
                caller,
                mid,
                cmd,
                args,
                ..
            } => self.command(conn, caller, mid, cmd, args),
        }
    }

    /// Runs once per (caller, mid): a mutate retried over a flaky tunnel gets the first answer.
    fn command(&self, conn: ConnId, caller: Caller, mid: String, cmd: String, args: Value) {
        let (backend, idem, tx, snaps) = (
            self.backend.clone(),
            self.idem.clone(),
            self.tx.clone(),
            self.snaps.clone(),
        );
        tokio::spawn(async move {
            let key = format!(
                "{}|{}|{mid}",
                caller.set,
                caller.session.as_deref().unwrap_or("")
            );
            let (status, v) = idem
                .once(key, async move {
                    command_answer(
                        backend.call(caller, &cmd, args).await,
                        i64::try_from(snaps.head_seq()).unwrap_or(0),
                    )
                })
                .await;
            let outcome = if status == 200 {
                CommandOutcome::Ok {
                    seq: v["seq"].as_u64().unwrap_or(0),
                    result: v.get("result").cloned().filter(|r| !r.is_null()),
                }
            } else {
                CommandOutcome::Err {
                    code: v["error"]["code"].as_str().unwrap_or("internal").to_owned(),
                    message: v["error"]["message"].as_str().unwrap_or("").to_owned(),
                }
            };
            let _ = tx.send(Msg::In(Input::CommandResult { conn, mid, outcome }));
        });
    }
}

async fn sleep(ms: Option<u64>) {
    match ms {
        Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
        None => std::future::pending().await,
    }
}
