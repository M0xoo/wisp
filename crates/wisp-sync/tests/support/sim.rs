//! One server wired to client models: frames go through encode → random chunking → parse, messages
//! through serde_json and the server's parser, snapshot answers come from the fake store (at once or
//! when `answer_all` runs), and sockets report a backlog when a client is slow.

use std::collections::VecDeque;

use wisp_protocol::Topic;
use wisp_sync::sse::{SseParser, decode_frame};
use wisp_sync::{ConnId, Input, Output, SnapshotAnswer, SyncServer};

use super::client::{Out, Saved, State, SyncClient};
use super::{EntityMap, FakeStore, Rng, TestChange, apply_entity_ops, apply_snapshot};

#[derive(Debug)]
pub struct SimClient {
    pub name: String,
    pub client: SyncClient,
    pub map: EntityMap,
    pub conn: Option<ConnId>,
    parser: SseParser,
    pub acks: Vec<String>,
    pub rejects: Vec<String>,
    pub resyncs: u32,
    pub drifts: u32,
    pub resets: u32,
    pub lives: u32,
    pub retry_at: Option<u64>,
    pub incompatible: bool,
    /// frames sent but not yet read by the client: lost with the connection
    pub transit: VecDeque<String>,
    /// what the socket reports as still buffered after a write
    pub backlog: usize,
}

impl SimClient {
    pub fn new(name: &str, saved: Option<Saved>) -> Self {
        Self {
            name: name.into(),
            client: SyncClient::new(name, saved),
            map: EntityMap::new(),
            conn: None,
            parser: SseParser::new(),
            acks: vec![],
            rejects: vec![],
            resyncs: 0,
            drifts: 0,
            resets: 0,
            lives: 0,
            retry_at: None,
            incompatible: false,
            transit: VecDeque::new(),
            backlog: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SimOpts {
    /// snapshot answers wait for `answer_all`
    pub async_answers: bool,
    /// frames wait for `deliver`
    pub wire: bool,
    /// frames reach the parser in random small chunks
    pub chunked: bool,
}

#[derive(Debug, Clone)]
struct Request {
    conn: ConnId,
    topic: Topic,
    since: Option<u64>,
    req: u64,
}

#[derive(Debug)]
pub struct Sim {
    pub now: u64,
    pub store: FakeStore,
    pub server: SyncServer<String>,
    pub clients: Vec<SimClient>,
    answers: VecDeque<Request>,
    /// every snapshot request the server made: (topic, since)
    pub requests: Vec<(Topic, Option<u64>)>,
    pub frames: u64,
    pub bytes: u64,
    next_conn: u64,
    rand: Rng,
    opts: SimOpts,
}

impl Sim {
    pub fn new(store: FakeStore, server: SyncServer<String>, clients: Vec<SimClient>, rand: Rng, opts: SimOpts) -> Self {
        Self {
            now: 1000,
            store,
            server,
            clients,
            answers: VecDeque::new(),
            requests: vec![],
            frames: 0,
            bytes: 0,
            next_conn: 0,
            rand,
            opts,
        }
    }

    pub fn pending_answers(&self) -> usize {
        self.answers.len()
    }

    pub fn drop_answers(&mut self) {
        self.answers.clear();
    }

    pub fn server_in(&mut self, input: Input<String>) {
        let outs = self.server.handle(input, self.now);
        self.server_out(outs);
    }

    fn client_of(&self, conn: ConnId) -> Option<usize> {
        self.clients.iter().position(|c| c.conn == Some(conn))
    }

    fn server_out(&mut self, outs: Vec<Output<String>>) {
        for o in outs {
            match o {
                Output::Send { conn, frame, id } => {
                    let Some(ci) = self.client_of(conn) else {
                        continue;
                    };
                    self.frames += u64::from(id.is_some());
                    self.bytes += frame.len() as u64;
                    self.clients[ci].transit.push_back(frame);
                    let backlog = self.clients[ci].backlog;
                    self.server_in(Input::Drained { conn, buffered_bytes: backlog });
                    if !self.opts.wire {
                        self.deliver(ci, usize::MAX);
                    }
                }
                Output::Close { conn, .. } => {
                    if let Some(ci) = self.client_of(conn) {
                        self.lose(ci);
                    }
                }
                Output::SnapshotRequest { conn, topic, since, req } => {
                    self.requests.push((topic.clone(), since));
                    let r = Request { conn, topic, since, req };
                    if self.opts.async_answers { self.answers.push_back(r) } else { self.answer(&r) }
                }
                Output::WindowRequest { .. } | Output::Command { .. } | Output::Activity { .. } => {}
            }
        }
    }

    fn answer(&mut self, r: &Request) {
        // a delta needs the log back to `since`: once retention passed it, only a full snapshot will do
        let full = r.since.is_none_or(|s| s < self.store.oldest) || self.rand.next() < 0.2;
        let (rows, deleted) = match r.since.filter(|_| !full) {
            Some(since) => self.store.delta(&r.topic, since),
            None => (self.store.snapshot(&r.topic), vec![]),
        };
        let a = SnapshotAnswer { conn: r.conn, topic: r.topic.clone(), req: r.req, seq: self.store.seq, rows, full, deleted, more: false };
        self.server_in(Input::SnapshotRows(a));
    }

    pub fn answer_all(&mut self) {
        while let Some(r) = self.answers.pop_front() {
            self.answer(&r);
        }
    }

    /// Reads up to `max` frames off the wire into the client.
    pub fn deliver(&mut self, ci: usize, max: usize) {
        for _ in 0..max {
            let Some(frame) = self.clients[ci].transit.pop_front() else {
                break;
            };
            let bytes = frame.into_bytes();
            let mut parts = Vec::new();
            if self.opts.chunked {
                let mut i = 0;
                while i < bytes.len() {
                    let n = 1 + self.rand.below(40);
                    parts.push(bytes[i..(i + n).min(bytes.len())].to_vec());
                    i += n;
                }
            } else {
                parts.push(bytes);
            }
            for p in parts {
                let events = self.clients[ci].parser.push(&p);
                for ev in events {
                    if let Some((id, messages)) = decode_frame(&ev) {
                        let outs = self.clients[ci].client.frame(id, messages);
                        self.client_out(ci, outs);
                    }
                }
            }
        }
    }

    pub fn client_out(&mut self, ci: usize, outs: Vec<Out>) {
        for o in outs {
            match o {
                Out::Request(query) => {
                    self.next_conn += 1;
                    let conn = ConnId(self.next_conn);
                    let c = &mut self.clients[ci];
                    c.conn = Some(conn);
                    c.parser = SseParser::new();
                    let caller = c.name.clone();
                    self.server_in(Input::Connect { conn, caller, query });
                }
                Out::Send(m) => {
                    if let Some(conn) = self.clients[ci].conn {
                        let message = serde_json::to_value(&m).unwrap_or_default();
                        self.server_in(Input::Message { conn, message });
                    }
                }
                Out::Reset => {
                    self.clients[ci].resets += 1;
                    self.clients[ci].map.clear();
                }
                Out::Snapshot { topic, rows } => apply_snapshot(&mut self.clients[ci].map, &topic, rows),
                Out::EntityOps(ops) => {
                    for t in apply_entity_ops(&mut self.clients[ci].map, &ops) {
                        self.clients[ci].drifts += 1;
                        let outs = self.clients[ci].client.drifted(&t);
                        self.client_out(ci, outs);
                    }
                }
                Out::Ack { mid } => self.clients[ci].acks.push(mid),
                Out::Reject { mid } => self.clients[ci].rejects.push(mid),
                Out::NeedResubscribe(_) => self.clients[ci].resyncs += 1,
                Out::Retry(at) => self.clients[ci].retry_at = Some(at),
                Out::State(State::Incompatible) => self.clients[ci].incompatible = true,
                Out::State(State::Live) => self.clients[ci].lives += 1,
                Out::State(_) | Out::Denied(_) => {}
            }
        }
    }

    pub fn commit(&mut self, changes: &[TestChange]) {
        let rows = self.store.commit(changes, self.now);
        if !rows.is_empty() {
            self.server_in(Input::Committed { rows });
        }
    }

    pub fn tick(&mut self, ms: u64) {
        self.now += ms;
        self.server_in(Input::Tick);
    }

    pub fn lose(&mut self, ci: usize) {
        let Some(conn) = self.clients[ci].conn.take() else {
            return;
        };
        self.clients[ci].transit.clear();
        let _ = self.server.handle(Input::Close { conn }, self.now);
        let outs = self.clients[ci].client.lost(self.now);
        self.client_out(ci, outs);
    }

    pub fn open(&mut self, ci: usize) {
        let outs = self.clients[ci].client.open();
        self.client_out(ci, outs);
    }

    pub fn subscribe(&mut self, ci: usize, t: &Topic, passive: bool) {
        let outs = self.clients[ci].client.subscribe(t, passive);
        self.client_out(ci, outs);
    }

    pub fn unsubscribe(&mut self, ci: usize, t: &Topic) {
        let outs = self.clients[ci].client.unsubscribe(t, false);
        self.client_out(ci, outs);
    }
}
