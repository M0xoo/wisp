//! The v2 sync stream (ADR-0005): wisp-sync's sans-IO `SyncServer`, carried onto sockets. One task owns
//! the machine; everything reaches it as a message, and it does what the machine returns: frames go to
//! each stream's queue, snapshot and window reads go to `Snapshots` (the store: `v2_store.rs`), commands
//! go to `Backend::call` (once per mid), and the clock wakes it only when the machine asks
//! (`next_wake_at`): an idle wisp does no work.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use wisp_kernel::{BoxFuture, Caller, Result, WireError};
use wisp_protocol::{Notice, PeerInfo, Row, Topic};
use wisp_sync::{ChangeRow, ConnId, ConnectQuery, Gone, Input, SyncOptions, SyncServer};

use crate::backend::Backend;
use crate::sync::SyncMount;

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
        let actor = Actor::new(SyncServer::new(opts), tx, snaps, backend, active);
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

#[path = "v2_actor.rs"]
mod actor;
use actor::Actor;
