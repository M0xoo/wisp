//! The client half of sync, one per peer (plan §4.5, §7.2.1, §7.3.2), sans-IO: the Rust twin of
//! `packages/sync/src/client.ts`, rule for rule (ADR-0024: the CLI and the TUI are sync clients like the
//! phone). It keeps the cursor for (peer, epoch), refcounts subscriptions (two views of one session are
//! one sub), resends pending mutations after the welcome with the same mid, and negotiates the
//! protocol window. The host opens the stream, feeds frames in and carries the outputs out.
//!
//! size-ok: one machine, as its TypeScript twin, with its rules' tests

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_protocol::{ClientMessage, EntityOp, Mutate, Notice, PROTO, PROTO_MIN, Row, ServerMessage, Sub, Topic, Unsub, Welcome, tag};

/// What to persist so a restart resumes instead of starting over.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub epoch: Option<String>,
    pub cursor: Option<u64>,
    /// topics whose rows the client store holds as of `cursor`
    #[serde(default)]
    pub synced: Vec<String>,
    #[serde(default)]
    pub pending: Vec<Mutate>,
    /// topics the store still holds from before, not subscribed now, and the seq they are as of
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held: Vec<(String, u64)>,
}

#[derive(Debug, Clone)]
pub struct Options {
    pub peer: String,
    pub client_id: String,
    pub build: String,
    pub proto_min: u32,
    pub proto_max: u32,
    pub saved: Option<Saved>,
    pub retry_base_ms: i64,
    pub retry_max_ms: i64,
}

impl Options {
    pub fn new(peer: impl Into<String>, client_id: impl Into<String>, build: impl Into<String>) -> Self {
        Self { peer: peer.into(), client_id: client_id.into(), build: build.into(), proto_min: PROTO_MIN, proto_max: PROTO, saved: None, retry_base_ms: 500, retry_max_ms: 30_000 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Idle,
    Connecting,
    Live,
    Offline,
    Incompatible,
}

/// Which side must update when the protocol windows don't meet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Update {
    Peer,
    Client,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Open,
    /// one decoded SSE frame: its `id:` (the cursor) and its messages
    Frame { id: Option<u64>, messages: Vec<ServerMessage> },
    /// the stream ended or failed
    Lost,
    Subscribe { topic: String, passive: bool },
    Unsubscribe { topic: String, passive: bool },
    Mutate { mid: String, cmd: String, args: Value, base_seq: Option<u64> },
    Window { req: String, topic: String, before_seq: u64, limit: u32 },
    /// the client store couldn't apply an op on this topic: start it over
    Drifted { topic: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// open `GET /api/events` with these query parameters
    Request { params: BTreeMap<String, String> },
    /// POST this to the connection (sub, unsub, window, mutate)
    Send(ClientMessage),
    Reset { peer: String },
    Snapshot { peer: String, topic: String, rows: Vec<Row> },
    EntityOps { peer: String, ops: Vec<EntityOp> },
    Rows { peer: String, req: String, rows: Vec<Row>, done: bool },
    Ack { mid: String, seq: u64, result: Option<Value> },
    Reject { mid: String, code: String, message: String },
    NeedResubscribe { topic: String },
    Denied { topic: String, code: String },
    Notice(Notice),
    State { state: State, update: Option<Update> },
    /// reconnect at this time (the host owns the timer)
    Retry { at: i64 },
}

#[derive(Debug, Clone, Default)]
struct TopicSub {
    refs: u32,
    active_refs: u32,
    synced: bool,
    denied: bool,
    pages: Option<(u64, Vec<Row>)>,
}

#[derive(Debug)]
pub struct SyncClient {
    pub peer: String,
    o: Options,
    state: State,
    epoch: Option<String>,
    cursor: Option<u64>,
    /// in the order first subscribed (the hello lists them so)
    topics: Vec<(String, TopicSub)>,
    held: Vec<(String, u64)>,
    pending: Vec<Mutate>,
    /// the topics the open hello carried: true when resumed from the cursor, false when fresh
    hello: Vec<(String, bool)>,
    attempt: u32,
    out: Vec<Output>,
}

fn sub_msg(topic: &str, active_refs: u32, since: Option<u64>) -> Option<ClientMessage> {
    Some(ClientMessage::Sub(Sub { t: tag::Sub, topic: Topic::parse(topic)?, since, passive: (active_refs == 0).then_some(true) }))
}

fn unsub_msg(topic: &str) -> Option<ClientMessage> {
    Some(ClientMessage::Unsub(Unsub { t: tag::Unsub, topic: Topic::parse(topic)? }))
}

impl SyncClient {
    pub fn new(o: Options) -> Self {
        let saved = o.saved.clone().unwrap_or_default();
        let mut held: Vec<(String, u64)> = saved.cursor.map(|at| saved.synced.iter().map(|t| (t.clone(), at)).collect()).unwrap_or_default();
        for (t, s) in &saved.held {
            if let Some(h) = held.iter_mut().find(|(x, _)| x == t) {
                h.1 = *s;
            } else {
                held.push((t.clone(), *s));
            }
        }
        Self { peer: o.peer.clone(), state: State::Idle, epoch: saved.epoch, cursor: saved.cursor, topics: Vec::new(), held, pending: saved.pending, hello: Vec::new(), attempt: 0, out: Vec::new(), o }
    }

    pub fn state(&self) -> State {
        self.state
    }
    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }
    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }

    pub fn save(&self) -> Saved {
        let synced: Vec<String> = self.topics.iter().filter(|(_, s)| s.synced).map(|(t, _)| t.clone()).collect();
        let held = self.held.iter().filter(|(t, _)| !synced.contains(t)).cloned().collect();
        Saved { epoch: self.epoch.clone(), cursor: self.cursor, synced, pending: self.pending.clone(), held }
    }

    fn topic(&mut self, t: &str) -> Option<&mut TopicSub> {
        self.topics.iter_mut().find(|(x, _)| x == t).map(|(_, s)| s)
    }

    fn held_of(&self, t: &str) -> Option<u64> {
        self.held.iter().find(|(x, _)| x == t).map(|(_, s)| *s)
    }

    pub fn handle(&mut self, input: Input, now: i64) -> Vec<Output> {
        self.out.clear();
        match input {
            Input::Open => self.open(),
            Input::Frame { id, messages } => self.frame(id, messages),
            Input::Lost => self.lost(now),
            Input::Subscribe { topic, passive } => self.subscribe(&topic, passive),
            Input::Unsubscribe { topic, passive } => self.unsubscribe(&topic, passive),
            Input::Mutate { mid, cmd, args, base_seq } => {
                let m = Mutate { t: tag::Mutate, mid, cmd, args, base_seq };
                // a Map in the TS twin: the same mid keeps its place
                match self.pending.iter_mut().find(|p| p.mid == m.mid) {
                    Some(p) => *p = m.clone(),
                    None => self.pending.push(m.clone()),
                }
                if self.state == State::Live {
                    self.send(ClientMessage::Mutate(m));
                }
            }
            Input::Window { req, topic, before_seq, limit } => {
                if self.state == State::Live
                    && let Some(topic) = Topic::parse(&topic)
                {
                    self.send(ClientMessage::Window(wisp_protocol::Window { t: tag::Window, req, topic, before_seq, limit }));
                }
            }
            Input::Drifted { topic } => {
                let live = self.state == State::Live;
                let Some(s) = self.topic(&topic) else { return std::mem::take(&mut self.out) };
                s.synced = false;
                s.pages = None;
                let active = s.active_refs;
                if live {
                    self.send_opt(unsub_msg(&topic));
                    self.send_opt(sub_msg(&topic, active, None));
                }
            }
        }
        std::mem::take(&mut self.out)
    }

    // ---------- connection ----------

    fn open(&mut self) {
        if matches!(self.state, State::Connecting | State::Live) {
            return;
        }
        self.set_state(State::Connecting, None);
        let mut params = BTreeMap::new();
        params.insert("proto_min".into(), self.o.proto_min.to_string());
        params.insert("proto_max".into(), self.o.proto_max.to_string());
        params.insert("client_id".into(), self.o.client_id.clone());
        params.insert("build".into(), self.o.build.clone());
        let can_resume = self.epoch.is_some() && self.cursor.is_some();
        if let (true, Some(e), Some(c)) = (can_resume, &self.epoch, self.cursor) {
            params.insert("epoch".into(), e.clone());
            params.insert("cursor".into(), c.to_string());
        }
        let (mut topics, mut fresh, mut passive) = (Vec::new(), Vec::new(), Vec::new());
        self.hello.clear();
        for (t, s) in &self.topics {
            if s.denied {
                continue;
            }
            // a topic held as of an older seq can't ride the hello's one cursor: it goes after the welcome
            let held = self.held.iter().find(|(x, _)| x == t).map(|(_, s)| *s);
            if !s.synced && held.is_some() && held != self.cursor {
                continue;
            }
            let resumed = can_resume && (s.synced || held.is_some());
            self.hello.push((t.clone(), resumed));
            if resumed { topics.push(t.clone()) } else { fresh.push(t.clone()) }
            if s.active_refs == 0 {
                passive.push(t.clone());
            }
        }
        if !topics.is_empty() {
            params.insert("topics".into(), topics.join(","));
        }
        if !fresh.is_empty() {
            params.insert("fresh".into(), fresh.join(","));
        }
        if !passive.is_empty() {
            params.insert("passive".into(), if passive.len() == self.hello.len() { "1".into() } else { passive.join(",") });
        }
        self.out.push(Output::Request { params });
    }

    fn lost(&mut self, now: i64) {
        if matches!(self.state, State::Incompatible | State::Idle) {
            return;
        }
        for (_, s) in &mut self.topics {
            s.pages = None; // a half-received snapshot is worthless
        }
        self.set_state(State::Offline, None);
        self.attempt += 1;
        let delay = self.o.retry_base_ms.saturating_mul(2i64.saturating_pow(self.attempt - 1)).min(self.o.retry_max_ms);
        self.out.push(Output::Retry { at: now + delay });
    }

    fn welcome(&mut self, w: &Welcome) -> bool {
        let lo = self.o.proto_min.max(w.peer.proto_min);
        let hi = self.o.proto_max.min(w.peer.proto_max);
        if lo > hi {
            // outside the window: whichever side is older must update (plan §7.3.2)
            let update = if w.peer.proto_max < self.o.proto_min { Update::Peer } else { Update::Client };
            self.state = State::Incompatible;
            self.out.push(Output::State { state: State::Incompatible, update: Some(update) });
            return false;
        }
        let resume = w.resume && Some(&w.epoch) == self.epoch.as_ref();
        if !resume {
            self.out.push(Output::Reset { peer: self.peer.clone() });
            self.held.clear(); // seqs of another epoch, or rows the reset just dropped
        }
        let hello = self.hello.clone();
        for (t, s) in &mut self.topics {
            s.synced = resume && hello.iter().any(|(x, r)| x == t && *r);
            s.pages = None;
        }
        let synced: Vec<String> = self.topics.iter().filter(|(_, s)| s.synced).map(|(t, _)| t.clone()).collect();
        self.held.retain(|(t, _)| !synced.contains(t));
        self.epoch = Some(w.epoch.clone());
        self.attempt = 0;
        self.set_state(State::Live, None);
        // subscribed while the hello was in flight (or held as of an older seq): a held topic resumes
        // from its seq instead of taking the whole topic
        let late: Vec<String> = self.topics.iter().filter(|(t, s)| !hello.iter().any(|(x, _)| x == t) && !s.denied).map(|(t, _)| t.clone()).collect();
        for t in late {
            let m = self.sub_first(&t);
            self.send_opt(m);
        }
        for (t, _) in &hello {
            if !self.topics.iter().any(|(x, _)| x == t) {
                self.send_opt(unsub_msg(t));
            }
        }
        self.hello.clear();
        for m in self.pending.clone() {
            self.send(ClientMessage::Mutate(m));
        }
        true
    }

    // ---------- frames ----------

    fn frame(&mut self, id: Option<u64>, messages: Vec<ServerMessage>) {
        let mut settle = Vec::new();
        let mut resyncs: Vec<String> = Vec::new();
        for m in messages {
            if let ServerMessage::Welcome(w) = &m {
                if !self.welcome(w) {
                    return;
                }
                continue;
            }
            if self.state != State::Live {
                continue; // nothing counts before the welcome
            }
            self.message(m, &mut settle, &mut resyncs);
        }
        if self.state != State::Live {
            return;
        }
        // the frame's id is a watermark: everything at or below it is here
        if id.is_some() {
            self.cursor = id;
        }
        for t in resyncs {
            let cursor = self.cursor;
            let Some(s) = self.topic(&t) else { continue };
            s.pages = None;
            let (synced, active) = (s.synced, s.active_refs);
            self.out.push(Output::NeedResubscribe { topic: t.clone() });
            self.send_opt(sub_msg(&t, active, if synced { cursor } else { None }));
        }
        self.out.extend(settle); // acks after the frame's ops: the effect is in base when the optimistic patch goes
    }

    fn message(&mut self, m: ServerMessage, settle: &mut Vec<Output>, resyncs: &mut Vec<String>) {
        match m {
            ServerMessage::Snapshot(snap) => {
                let topic = snap.topic.as_str().to_owned();
                let Some(s) = self.topic(&topic) else { return };
                if s.pages.as_ref().is_none_or(|(seq, _)| *seq != snap.seq) {
                    s.pages = Some((snap.seq, Vec::new()));
                }
                if let Some((_, rows)) = s.pages.as_mut() {
                    rows.extend(snap.rows);
                }
                if snap.more == Some(true) {
                    return;
                }
                let rows = s.pages.take().map(|(_, r)| r).unwrap_or_default();
                s.synced = true;
                self.out.push(Output::Snapshot { peer: self.peer.clone(), topic, rows });
            }
            ServerMessage::Patch(p) => {
                // a topic waiting for its snapshot takes no ops: the snapshot replaces them
                let ops: Vec<EntityOp> = p.ops.into_iter().filter(|op| self.topics.iter().any(|(t, s)| t == op.topic.as_str() && s.synced)).collect();
                if !ops.is_empty() {
                    self.out.push(Output::EntityOps { peer: self.peer.clone(), ops });
                }
            }
            ServerMessage::Rows(r) => self.out.push(Output::Rows { peer: self.peer.clone(), req: r.req, rows: r.rows, done: r.done }),
            ServerMessage::Ack(a) => {
                if self.take_pending(&a.mid) {
                    settle.push(Output::Ack { mid: a.mid, seq: a.seq, result: a.result });
                }
            }
            ServerMessage::Reject(r) => {
                if self.take_pending(&r.mid) {
                    settle.push(Output::Reject { mid: r.mid, code: r.code, message: r.message });
                }
            }
            ServerMessage::Resync(r) => {
                let t = r.topic.as_str().to_owned();
                if self.topics.iter().any(|(x, _)| *x == t) && !resyncs.contains(&t) {
                    resyncs.push(t);
                }
            }
            ServerMessage::Notice(n) => self.notice(n),
            ServerMessage::Welcome(_) => {}
        }
    }

    fn take_pending(&mut self, mid: &str) -> bool {
        let before = self.pending.len();
        self.pending.retain(|p| p.mid != mid);
        self.pending.len() != before
    }

    fn notice(&mut self, n: Notice) {
        if n.kind == "denied"
            && let Some(topic) = n.data.get("topic").and_then(Value::as_str).map(str::to_owned)
        {
            if let Some(s) = self.topic(&topic) {
                s.denied = true;
            }
            let code = n.data.get("code").and_then(Value::as_str).unwrap_or("forbidden").to_owned();
            self.out.push(Output::Denied { topic, code });
            return;
        }
        self.out.push(Output::Notice(n));
    }

    // ---------- subscriptions ----------

    fn subscribe(&mut self, topic: &str, passive: bool) {
        if self.topic(topic).is_none() {
            self.topics.push((topic.to_owned(), TopicSub::default()));
        }
        let live = self.state == State::Live;
        let Some(s) = self.topic(topic) else { return };
        let was_active = s.active_refs > 0;
        s.refs += 1;
        if !passive {
            s.active_refs += 1;
        }
        let (refs, active) = (s.refs, s.active_refs);
        if !live {
            return;
        }
        // the first view sends the sub; a first active view turns a passive sub into one that counts
        if refs == 1 {
            let m = self.sub_first(topic);
            self.send_opt(m);
        } else if !was_active && active == 1 {
            self.send_opt(sub_msg(topic, active, None));
        }
    }

    /// The first sub of a topic on this stream: from the seq the store holds it as of, if it does.
    fn sub_first(&mut self, topic: &str) -> Option<ClientMessage> {
        let since = self.held_of(topic);
        let s = self.topic(topic)?;
        let active = s.active_refs;
        if since.is_some() {
            s.synced = true; // the server pins the cursor at `since` until the delta is sent
            self.held.retain(|(t, _)| t != topic);
        }
        sub_msg(topic, active, since)
    }

    fn unsubscribe(&mut self, topic: &str, passive: bool) {
        let live = self.state == State::Live;
        let Some(s) = self.topic(topic) else { return };
        s.refs = s.refs.saturating_sub(1);
        if !passive && s.active_refs > 0 {
            s.active_refs -= 1;
        }
        let (refs, active, denied) = (s.refs, s.active_refs, s.denied);
        if refs > 0 {
            if active == 0 && !passive && live {
                self.send_opt(sub_msg(topic, active, None));
            }
            return;
        }
        self.topics.retain(|(t, _)| t != topic);
        if live && !denied {
            self.send_opt(unsub_msg(topic));
        }
    }

    fn send(&mut self, m: ClientMessage) {
        self.out.push(Output::Send(m));
    }

    fn send_opt(&mut self, m: Option<ClientMessage>) {
        if let Some(m) = m {
            self.send(m);
        }
    }

    fn set_state(&mut self, state: State, update: Option<Update>) {
        if self.state == state {
            return;
        }
        self.state = state;
        self.out.push(Output::State { state, update });
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
#[path = "client_tests.rs"]
mod tests;
