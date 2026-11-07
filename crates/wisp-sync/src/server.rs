//! The server half of sync (plan §4.3–§4.5, §7.2.3), sans-IO: `handle(input, now)` returns what to
//! do and never reads a clock or a socket. One instance owns every stream of this wisp.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use wisp_protocol::{
    Change, ClientMessage, EntityOp, PROTO, PROTO_MIN, Rows, Snapshot, Topic, Welcome, tag,
};

use crate::conn::{Conn, Core, Sub, SubState, V1Conn, json};
use crate::legacy::{V1_HELLO, v1_frame};
use crate::outbox::{Front, FrontKind, Outbox, SharedOp};
use crate::parse::{parse_client_message, parse_hello};
use crate::{
    ChangeRow, CloseReason, CommandOutcome, ConnId, ConnectQuery, Input, Output, SnapshotAnswer,
    Stats, SyncOptions,
};

pub struct SyncServer<C> {
    pub(crate) core: Core<C>,
    pub(crate) conns: BTreeMap<ConnId, Conn<C>>,
    by_client: HashMap<String, ConnId>,
    pub(crate) v1: BTreeMap<ConnId, V1Conn>,
}

impl<C> std::fmt::Debug for SyncServer<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncServer")
            .field("head", &self.core.head)
            .field("conns", &self.conns.len())
            .field("v1", &self.v1.len())
            .finish_non_exhaustive()
    }
}

impl<C: Clone> SyncServer<C> {
    pub fn new(opts: SyncOptions<C>) -> Self {
        let (head, oldest) = (opts.head_seq, opts.oldest_seq);
        Self {
            core: Core {
                opts,
                head,
                oldest,
                req: 0,
                out: Vec::new(),
                stats: Stats::default(),
            },
            conns: BTreeMap::new(),
            by_client: HashMap::new(),
            v1: BTreeMap::new(),
        }
    }

    pub fn epoch(&self) -> &str {
        &self.core.opts.epoch
    }

    pub fn head_seq(&self) -> u64 {
        self.core.head
    }

    pub fn stats(&self) -> Stats {
        self.core.stats
    }

    pub fn caller_of(&self, conn: ConnId) -> Option<&C> {
        self.conns.get(&conn).map(|c| &c.caller)
    }

    pub fn conn_of(&self, client_id: &str) -> Option<ConnId> {
        self.by_client.get(client_id).copied()
    }

    /// Streams that count as use of this box: any non-passive subscription, or a v1 stream that
    /// isn't another wisp relaying it.
    pub fn active_count(&self) -> usize {
        self.conns.values().filter(|c| c.active).count()
            + self.v1.values().filter(|c| !c.relay).count()
    }

    /// When `Input::Tick` next has work: a due flush, heartbeat or v1 ping. None when nothing is
    /// connected. A time in the past means now.
    pub fn next_wake_at(&self) -> Option<u64> {
        let sync = self.conns.values().map(|c| self.core.wake_at(c));
        sync.chain(
            self.v1
                .values()
                .map(|c| c.last_write_at + self.core.opts.v1_ping_ms),
        )
        .min()
    }

    pub fn handle(&mut self, input: Input<C>, now: u64) -> Vec<Output<C>> {
        match input {
            Input::Connect {
                conn,
                caller: _,
                query,
            } if query.is_v1() => self.connect_v1(conn, query.relay, now),
            Input::Connect {
                conn,
                caller,
                query,
            } => self.connect(conn, caller, &query, now),
            Input::Message { conn, message } => self.message(conn, message, now),
            Input::Committed { rows } => self.committed(rows, now),
            Input::SnapshotRows(a) => self.snapshot_rows(a, now),
            Input::WindowRows {
                conn,
                req,
                rows,
                done,
            } => self.window_rows(conn, req, rows, done, now),
            Input::CommandResult { conn, mid, outcome } => {
                self.command_result(conn, mid, outcome, now);
            }
            Input::Notice { notice, topic } => {
                let msg = json(&notice);
                for c in self
                    .conns
                    .values_mut()
                    .filter(|c| topic.as_ref().is_none_or(|t| c.subs.contains_key(t)))
                {
                    c.control.push(msg.clone());
                    self.core.maybe_flush(c, now);
                }
            }
            Input::Legacy {
                event,
                data,
                from_machine,
            } => {
                let frame = v1_frame(event, &json(&data));
                for (id, c) in self
                    .v1
                    .iter_mut()
                    .filter(|(_, c)| !(from_machine && c.relay))
                {
                    c.last_write_at = now;
                    self.core.send_raw(*id, frame.clone(), None);
                }
            }
            Input::Retained { oldest_seq } => self.core.oldest = self.core.oldest.max(oldest_seq),
            Input::Tick => self.tick(now),
            Input::Drained {
                conn,
                buffered_bytes,
            } => {
                if let Some(c) = self.conns.get_mut(&conn) {
                    c.buffered = buffered_bytes;
                    self.core.request_waiting(c);
                    self.core.maybe_flush(c, now);
                }
            }
            Input::Close { conn } => self.drop_conn(conn),
        }
        std::mem::take(&mut self.core.out)
    }

    // ---------- connections ----------

    fn connect(&mut self, id: ConnId, caller: C, query: &ConnectQuery, now: u64) {
        let hello = parse_hello(query, &id.to_string());
        if let Some(old) = self
            .by_client
            .get(&hello.client_id)
            .copied()
            .filter(|old| *old != id)
        {
            self.drop_conn(old);
            self.core.out.push(Output::Close {
                conn: old,
                reason: CloseReason::Replaced,
            });
        }
        let mut c = Conn {
            id,
            caller,
            client_id: hello.client_id.clone(),
            subs: HashMap::new(),
            out: Outbox::default(),
            control: Vec::new(),
            acks: Vec::new(),
            windows: HashMap::new(),
            buffered: 0,
            last_flush_at: None,
            last_write_at: now,
            active: false,
        };
        let core = &mut self.core;
        let compatible = hello.proto_max.min(PROTO) >= hello.proto_min.max(PROTO_MIN);
        let resume = compatible
            && hello.epoch.as_deref() == Some(core.opts.epoch.as_str())
            && hello
                .cursor
                .is_some_and(|x| x >= core.oldest && x <= core.head);
        let proto = if compatible {
            hello.proto_max.min(PROTO)
        } else {
            PROTO
        };
        let welcome = Welcome {
            t: tag::Welcome,
            epoch: core.opts.epoch.clone(),
            head_seq: core.head,
            oldest_seq: core.oldest,
            resume,
            proto,
            peer: core.opts.peer.clone(),
        };
        if !compatible {
            let w = core.watermark(&c);
            core.write(&mut c, &[json(&welcome)], now, w);
            core.out.push(Output::Close {
                conn: id,
                reason: CloseReason::Incompatible,
            });
            return;
        }
        c.control.push(json(&welcome));
        for t in &hello.invalid {
            Core::deny(&mut c, t, "invalid");
        }
        let mark = core.out.len();
        let since = if resume { hello.cursor } else { None };
        for t in &hello.topics {
            core.subscribe(&mut c, t, hello.passive.has(t), since);
        }
        for t in &hello.fresh {
            core.subscribe(&mut c, t, hello.passive.has(t), None);
        }
        core.update_activity(&mut c);
        core.flush(&mut c, now);
        // The welcome goes before the snapshot requests of this connect: a host that answers at once
        // would otherwise send a snapshot the client drops, since nothing counts before the welcome.
        if let Some(pos) = core.out[mark..]
            .iter()
            .position(|o| matches!(o, Output::Send { .. }))
        {
            core.out[mark..=mark + pos].rotate_right(1);
        }
        c.last_flush_at = None; // ...and it doesn't hold back the snapshots behind it
        self.by_client.insert(hello.client_id, id);
        self.conns.insert(id, c);
    }

    fn connect_v1(&mut self, id: ConnId, relay: bool, now: u64) {
        self.v1.insert(
            id,
            V1Conn {
                relay,
                last_write_at: now,
            },
        );
        self.core.send_raw(id, V1_HELLO.to_owned(), None);
        if !relay {
            self.core.out.push(Output::Activity {
                conn: id,
                active: true,
            });
        }
    }

    fn drop_conn(&mut self, id: ConnId) {
        self.v1.remove(&id);
        if let Some(c) = self.conns.remove(&id)
            && self.by_client.get(&c.client_id) == Some(&id)
        {
            self.by_client.remove(&c.client_id);
        }
    }

    fn message(&mut self, id: ConnId, raw: serde_json::Value, now: u64) {
        let Some(c) = self.conns.get_mut(&id) else {
            return;
        };
        let m = match parse_client_message(raw) {
            Ok(m) => m,
            Err(e) => {
                tracing::debug!(conn = %id, error = %e, "sync: dropped a client message");
                return;
            }
        };
        let core = &mut self.core;
        match m {
            ClientMessage::Sub(s) => {
                core.subscribe(c, &s.topic, s.passive == Some(true), s.since);
                core.update_activity(c);
            }
            ClientMessage::Unsub(u) => {
                c.subs.remove(&u.topic);
                c.out.drop_topic(&u.topic, false);
                core.update_activity(c);
            }
            ClientMessage::Window(w) => {
                if (core.opts.can_read)(&c.caller, &w.topic) {
                    c.windows.insert(w.req.clone(), w.topic.clone());
                    core.out.push(Output::WindowRequest {
                        conn: id,
                        req: w.req,
                        topic: w.topic,
                        before_seq: w.before_seq,
                        limit: w.limit,
                    });
                } else {
                    Core::deny(c, w.topic.as_str(), "forbidden");
                }
            }
            ClientMessage::Mutate(m) => {
                let _span =
                    tracing::debug_span!("sync.mutate", conn = %id, cmd = %m.cmd, mid = %m.mid)
                        .entered();
                core.out.push(Output::Command {
                    conn: id,
                    caller: c.caller.clone(),
                    mid: m.mid,
                    cmd: m.cmd,
                    args: m.args,
                    base_seq: m.base_seq,
                });
            }
            ClientMessage::Hello(_) => {} // the hello rides on the GET; a second one means nothing
        }
        core.maybe_flush(c, now);
    }

    // ---------- answers from the host ----------

    fn snapshot_rows(&mut self, a: SnapshotAnswer, now: u64) {
        let Some(c) = self.conns.get_mut(&a.conn) else {
            return;
        };
        let Some(sub) = c
            .subs
            .get_mut(&a.topic)
            .filter(|s| s.state == SubState::Loading && s.req == a.req)
        else {
            return;
        };
        let since = sub.since;
        let mut buffered = Vec::new();
        if !a.more {
            sub.state = SubState::Live;
            sub.since = None;
            buffered = std::mem::take(&mut sub.buffer);
            sub.buffer_bytes = 0;
        }
        match since.filter(|_| !a.full) {
            None => {
                let msg = Snapshot {
                    t: tag::Snapshot,
                    topic: a.topic.clone(),
                    seq: a.seq,
                    rows: a.rows,
                    more: a.more.then_some(true),
                };
                // replacing rows the client holds as of `since`: the cursor stays there until this is sent
                c.out.push_front(
                    &a.topic,
                    Front {
                        json: json(&msg),
                        kind: FrontKind::Snapshot,
                        first_seq: since.map(|s| s + 1),
                    },
                );
            }
            Some(since) => {
                let first = since + 1;
                let ops = a
                    .rows
                    .into_iter()
                    .map(|r| (r.e, r.id, Change::Upsert { v: r.v }));
                for (e, id, change) in
                    ops.chain(a.deleted.into_iter().map(|d| (d.e, d.id, Change::Del)))
                {
                    let op = Arc::new(SharedOp::new(EntityOp {
                        topic: a.topic.clone(),
                        e,
                        id,
                        change,
                    }));
                    let bytes = op.json().len();
                    c.out.push_op(op, first, bytes);
                }
            }
        }
        for (seq, op) in buffered.into_iter().filter(|(seq, _)| *seq > a.seq) {
            let bytes = op.json().len();
            c.out.push_op(op, seq, bytes);
        }
        self.core.maybe_flush(c, now);
    }

    fn window_rows(
        &mut self,
        id: ConnId,
        req: String,
        rows: Vec<wisp_protocol::Row>,
        done: bool,
        now: u64,
    ) {
        let Some(c) = self.conns.get_mut(&id) else {
            return;
        };
        let Some(topic) = (if done {
            c.windows.remove(&req)
        } else {
            c.windows.get(&req).cloned()
        }) else {
            return;
        };
        let msg = Rows {
            t: tag::Rows,
            req,
            rows,
            done,
        };
        c.out.push_front(
            &topic,
            Front {
                json: json(&msg),
                kind: FrontKind::Rows,
                first_seq: None,
            },
        );
        self.core.maybe_flush(c, now);
    }

    fn command_result(&mut self, id: ConnId, mid: String, outcome: CommandOutcome, now: u64) {
        let Some(c) = self.conns.get_mut(&id) else {
            return;
        };
        match outcome {
            CommandOutcome::Ok { seq, result } => {
                c.acks.push(crate::conn::PendingAck { mid, seq, result });
            }
            CommandOutcome::Err { code, message } => c.control.push(json(&wisp_protocol::Reject {
                t: tag::Reject,
                mid,
                code,
                message,
            })),
        }
        self.core.maybe_flush(c, now);
    }

    // ---------- the change feed ----------

    fn committed(&mut self, mut rows: Vec<ChangeRow>, now: u64) {
        rows.sort_by_key(|r| r.seq);
        for row in rows {
            let seq = row.seq;
            self.core.head = self.core.head.max(seq);
            let wanted = self.conns.values().any(|c| {
                c.subs
                    .get(&row.topic)
                    .is_some_and(|s| matches!(s.state, SubState::Live | SubState::Loading))
            });
            if !wanted {
                continue; // waiting and dropped: the snapshot or delta asked for later covers it
            }
            let topic = row.topic.clone();
            let op = Arc::new(SharedOp::new(EntityOp {
                topic: row.topic,
                e: row.entity,
                id: row.id,
                change: row.change,
            }));
            let bytes = op.json().len();
            for c in self.conns.values_mut() {
                let Some(sub) = c
                    .subs
                    .get_mut(&topic)
                    .filter(|s| matches!(s.state, SubState::Live | SubState::Loading))
                else {
                    continue;
                };
                let op = op.clone();
                if sub.state == SubState::Live {
                    c.out.push_op(op, seq, bytes);
                    continue;
                }
                sub.buffer.push((seq, op));
                sub.buffer_bytes += bytes;
                // the host is slow to answer: start the topic over rather than hold changes without end
                if sub.buffer_bytes > self.core.opts.load_buffer_bytes {
                    let req = self.core.next_req();
                    Core::<C>::start_request(c.id, &topic, sub, req, &mut self.core.out);
                }
            }
        }
        for c in self.conns.values_mut() {
            self.core.maybe_flush(c, now);
        }
    }

    fn tick(&mut self, now: u64) {
        for c in self.conns.values_mut() {
            self.core.request_waiting(c);
            self.core.maybe_flush(c, now);
            self.core.heartbeat(c, now);
        }
        let ping = self.core.opts.v1_ping_ms;
        for (id, c) in &mut self.v1 {
            if now.saturating_sub(c.last_write_at) >= ping {
                c.last_write_at = now;
                self.core
                    .send_raw(*id, v1_frame(crate::V1Event::Ping, "{}"), None);
            }
        }
    }
}

impl<C> Core<C> {
    pub(crate) fn subscribe(
        &mut self,
        c: &mut Conn<C>,
        topic: &Topic,
        passive: bool,
        since: Option<u64>,
    ) {
        if !(self.opts.can_read)(&c.caller, topic) {
            return Self::deny(c, topic.as_str(), "forbidden");
        }
        if let Some(existing) = c
            .subs
            .get_mut(topic)
            .filter(|s| s.state != SubState::Dropped && since.is_none())
        {
            existing.passive = passive; // the same sub again: only its passive flag can change
            return;
        }
        c.out.drop_topic(topic, true);
        // a cursor older than the change log can't be resumed from: take the whole topic
        let from = since.filter(|s| *s >= self.oldest && *s <= self.head);
        let mut sub = Sub {
            passive,
            state: SubState::Waiting,
            since: from,
            req: 0,
            buffer: Vec::new(),
            buffer_bytes: 0,
        };
        if c.buffered <= self.low_water() {
            let req = self.next_req();
            Self::start_request(c.id, topic, &mut sub, req, &mut self.out);
        }
        c.subs.insert(topic.clone(), sub);
    }

    pub(crate) fn next_req(&mut self) -> u64 {
        self.req += 1;
        self.req
    }

    pub(crate) fn start_request(
        conn: ConnId,
        topic: &Topic,
        sub: &mut Sub,
        req: u64,
        out: &mut Vec<Output<C>>,
    ) {
        sub.state = SubState::Loading;
        sub.req = req;
        sub.buffer.clear();
        sub.buffer_bytes = 0;
        out.push(Output::SnapshotRequest {
            conn,
            topic: topic.clone(),
            since: sub.since,
            req,
        });
    }

    /// Snapshots held back while the connection was over the high-water mark.
    pub(crate) fn request_waiting(&mut self, c: &mut Conn<C>) {
        if c.buffered > self.low_water() {
            return;
        }
        let mut waiting: Vec<_> = c
            .subs
            .iter_mut()
            .filter(|(_, s)| s.state == SubState::Waiting)
            .collect();
        waiting.sort_by(|a, b| a.0.rank().cmp(&b.0.rank()).then_with(|| a.0.cmp(b.0)));
        for (topic, sub) in waiting {
            self.req += 1;
            Self::start_request(c.id, topic, sub, self.req, &mut self.out);
        }
    }

    pub(crate) fn update_activity(&mut self, c: &mut Conn<C>) {
        let active = c.subs.values().any(|s| !s.passive);
        if active != c.active {
            c.active = active;
            self.out.push(Output::Activity { conn: c.id, active });
        }
    }
}
