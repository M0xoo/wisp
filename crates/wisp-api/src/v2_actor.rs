//! The v2 stream's actor: the one task that owns wisp-sync's machine. Every input reaches it as a
//! `Msg`; it does what the machine returns (frames to each stream's queue, reads to `Snapshots`,
//! commands to `Backend::call` once per mid) and sleeps until the machine's next wake.
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::mpsc;
use wisp_kernel::{Caller, Result, WireError};
use wisp_sync::{CommandOutcome, ConnId, Input, Output, SnapshotAnswer, SyncServer};

use super::{Msg, Snapshots, now_ms};
use crate::backend::Backend;
use crate::sync::{Idempotency, command_answer};

struct Stream {
    pub(super) tx: mpsc::Sender<Bytes>,
    caller: Caller,
    /// bytes queued and not yet written to the socket: the machine's backpressure signal
    queued: Arc<AtomicUsize>,
    pub(super) active: bool,
}

pub(super) struct Actor {
    server: SyncServer<Caller>,
    conns: HashMap<ConnId, Stream>,
    tx: mpsc::UnboundedSender<Msg>,
    snaps: Arc<dyn Snapshots>,
    backend: Arc<dyn Backend>,
    idem: Arc<Idempotency>,
    active: Arc<AtomicUsize>,
}

impl Actor {
    pub(super) fn new(
        server: SyncServer<Caller>,
        tx: mpsc::UnboundedSender<Msg>,
        snaps: Arc<dyn Snapshots>,
        backend: Arc<dyn Backend>,
        active: Arc<AtomicUsize>,
    ) -> Self {
        Self { server, conns: HashMap::new(), tx, snaps, backend, idem: Arc::new(Idempotency::default()), active }
    }

    pub(super) async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        loop {
            let wake = self.server.next_wake_at().map(|at| at.saturating_sub(now_ms()));
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => Some(m), None => return },
                () = sleep(wake) => None,
            };
            match msg {
                Some(Msg::Open { conn, caller, query, tx, queued }) => {
                    self.conns.insert(conn, Stream { tx, caller: caller.clone(), queued, active: false });
                    self.feed(Input::Connect { conn, caller, query });
                }
                Some(Msg::Post { caller, client, body, reply }) => {
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
        let conn = self
            .server
            .conn_of(client)
            .ok_or_else(|| WireError::not_found("no open stream for this client: open GET /api/events first"))?;
        // a stream's messages come from whoever opened it, never another caller
        let owner = self.conns.get(&conn).map(|s| &s.caller);
        if owner.is_none_or(|c| c.set != caller.set || c.session != caller.session) {
            return Err(WireError::forbidden("that stream belongs to another caller"));
        }
        self.feed(Input::Message { conn, message });
        Ok(())
    }

    /// Streams whose socket went away: closed in the machine too.
    fn reap(&mut self) {
        let gone: Vec<ConnId> = self.conns.iter().filter(|(_, s)| s.tx.is_closed()).map(|(c, _)| *c).collect();
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
                    inputs.push(Input::Drained { conn, buffered_bytes: s.queued.load(Ordering::Relaxed) });
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
            Output::SnapshotRequest { conn, topic, since, req } => {
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
            Output::WindowRequest { conn, req, topic, before_seq, limit } => {
                let (snaps, tx) = (self.snaps.clone(), self.tx.clone());
                tokio::spawn(async move {
                    let (rows, done) = snaps.window(&topic, before_seq, limit).await;
                    let _ = tx.send(Msg::In(Input::WindowRows { conn, req, rows, done }));
                });
            }
            Output::Command { conn, caller, mid, cmd, args, .. } => self.command(conn, caller, mid, cmd, args),
        }
    }

    /// Runs once per (caller, mid): a mutate retried over a flaky tunnel gets the first answer.
    fn command(&self, conn: ConnId, caller: Caller, mid: String, cmd: String, args: Value) {
        let (backend, idem, tx, snaps) = (self.backend.clone(), self.idem.clone(), self.tx.clone(), self.snaps.clone());
        tokio::spawn(async move {
            let key = format!("{}|{}|{mid}", caller.set, caller.session.as_deref().unwrap_or(""));
            let (status, v) =
                idem.once(key, async move {
                    command_answer(backend.call(caller, &cmd, args).await, i64::try_from(snaps.head_seq()).unwrap_or(0))
                })
                .await;
            let outcome = if status == 200 {
                CommandOutcome::Ok { seq: v["seq"].as_u64().unwrap_or(0), result: v.get("result").cloned().filter(|r| !r.is_null()) }
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
