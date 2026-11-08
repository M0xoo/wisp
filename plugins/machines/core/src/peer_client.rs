//! The client half of sync, one per peer (plan §4.5, §7.2.1, §7.3.2), sans-IO: a port of
//! `@wisp/sync`'s `SyncClient` (packages/sync/src/client.ts, the spec) onto `wisp-protocol`'s types.
//! It keeps the cursor for (peer, epoch), refcounts subscriptions, keeps them passive unless a view
//! needs the box awake, resends pending mutations after the welcome with the **same** mid, and
//! negotiates the protocol window. The host feeds it inputs and carries out what it returns.
//!
//! size-ok: a port of @wisp/sync's `SyncClient` (the spec), kept 1:1 with it
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_protocol::{ClientMessage, EntityOp, Mutate, Notice, Row, ServerMessage, Sub, Topic, Unsub, Welcome, Window, tag};

/// What to persist so a restart resumes from the cursor instead of starting over.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub epoch: Option<String>,
    pub cursor: Option<u64>,
    /// topics whose rows the mirror holds as of `cursor`
    pub synced: Vec<Topic>,
    pub pending: Vec<Mutate>,
    /// topics the mirror still holds from before, not subscribed now, with the seq they are as of
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held: Vec<(Topic, u64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Connecting,
    Live,
    Offline,
    Incompatible,
}

/// Which side must update when the windows don't overlap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Update {
    Peer,
    Client,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// open `GET /api/events` with these query parameters
    Request(Vec<(String, String)>),
    /// POST this to the connection
    Send(ClientMessage),
    /// drop every row held for this peer (a new epoch)
    Reset,
    Snapshot { topic: Topic, rows: Vec<Row> },
    EntityOps(Vec<EntityOp>),
    Rows { req: String, rows: Vec<Row>, done: bool },
    Ack { mid: String, seq: u64, result: Option<Value> },
    Reject { mid: String, code: String, message: String },
    NeedResubscribe(Topic),
    Denied { topic: Topic, code: String },
    Notice(Notice),
    State(State, Option<Update>),
    /// reconnect at this time (the host owns the timer)
    Retry { at: i64 },
}

#[derive(Debug, Clone)]
struct TopicSub {
    refs: u32,
    active: u32,
    synced: bool,
    denied: bool,
    pages: Option<(u64, Vec<Row>)>,
}

#[derive(Debug, Clone)]
pub struct Opts {
    pub client_id: String,
    pub build: String,
    pub proto_min: u32,
    pub proto_max: u32,
    pub retry_base_ms: i64,
    pub retry_max_ms: i64,
}

impl Opts {
    pub fn new(client_id: impl Into<String>, build: impl Into<String>) -> Self {
        Self { client_id: client_id.into(), build: build.into(), proto_min: wisp_protocol::PROTO_MIN, proto_max: wisp_protocol::PROTO, retry_base_ms: 500, retry_max_ms: 30_000 }
    }
}

#[derive(Debug)]
pub struct PeerClient {
    o: Opts,
    state: State,
    epoch: Option<String>,
    cursor: Option<u64>,
    topics: BTreeMap<Topic, TopicSub>,
    held: BTreeMap<Topic, u64>,
    pending: BTreeMap<String, Mutate>,
    /// the topics the open hello carried: true when resumed from the cursor
    hello: BTreeMap<Topic, bool>,
    attempt: u32,
    out: Vec<Out>,
}

fn sub(topic: &Topic, since: Option<u64>, passive: bool) -> ClientMessage {
    ClientMessage::Sub(Sub { t: tag::Sub, topic: topic.clone(), since, passive: passive.then_some(true) })
}

impl PeerClient {
    pub fn new(o: Opts, saved: Option<Saved>) -> Self {
        let saved = saved.unwrap_or_default();
        let mut held: BTreeMap<Topic, u64> = saved.cursor.map(|at| saved.synced.iter().map(|t| (t.clone(), at)).collect()).unwrap_or_default();
        held.extend(saved.held);
        let pending = saved.pending.into_iter().map(|m| (m.mid.clone(), m)).collect();
        Self { o, state: State::Idle, epoch: saved.epoch, cursor: saved.cursor, topics: BTreeMap::new(), held, pending, hello: BTreeMap::new(), attempt: 0, out: Vec::new() }
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
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    pub fn save(&self) -> Saved {
        let synced: Vec<Topic> = self.topics.iter().filter(|(_, s)| s.synced).map(|(t, _)| t.clone()).collect();
        let held = self.held.iter().filter(|(t, _)| !synced.contains(t)).map(|(t, s)| (t.clone(), *s)).collect();
        Saved { epoch: self.epoch.clone(), cursor: self.cursor, synced, pending: self.pending.values().cloned().collect(), held }
    }

    fn take(&mut self) -> Vec<Out> {
        std::mem::take(&mut self.out)
    }

    fn send(&mut self, m: ClientMessage) {
        self.out.push(Out::Send(m));
    }

    fn set_state(&mut self, s: State) {
        if self.state != s {
            self.state = s;
            self.out.push(Out::State(s, None));
        }
    }

    // ---------- connection ----------

    pub fn open(&mut self) -> Vec<Out> {
        if matches!(self.state, State::Connecting | State::Live) {
            return self.take();
        }
        self.set_state(State::Connecting);
        let mut params = vec![("proto_min".into(), self.o.proto_min.to_string()), ("proto_max".into(), self.o.proto_max.to_string()), ("client_id".into(), self.o.client_id.clone()), ("build".into(), self.o.build.clone())];
        let resume_at = match (&self.epoch, self.cursor) {
            (Some(e), Some(c)) => {
                params.push(("epoch".into(), e.clone()));
                params.push(("cursor".into(), c.to_string()));
                Some(c)
            }
            _ => None,
        };
        let (mut topics, mut fresh, mut passive) = (Vec::new(), Vec::new(), Vec::new());
        self.hello.clear();
        for (t, s) in &self.topics {
            // a topic held as of an older seq can't ride the hello's one cursor: it goes after the welcome
            if s.denied || (!s.synced && self.held.get(t).is_some_and(|at| Some(*at) != self.cursor)) {
                continue;
            }
            let resumed = resume_at.is_some() && (s.synced || self.held.contains_key(t));
            self.hello.insert(t.clone(), resumed);
            if resumed { topics.push(t.as_str()) } else { fresh.push(t.as_str()) }
            if s.active == 0 {
                passive.push(t.as_str());
            }
        }
        if !topics.is_empty() {
            params.push(("topics".into(), topics.join(",")));
        }
        if !fresh.is_empty() {
            params.push(("fresh".into(), fresh.join(",")));
        }
        if !passive.is_empty() {
            params.push(("passive".into(), if passive.len() == self.hello.len() { "1".into() } else { passive.join(",") }));
        }
        self.out.push(Out::Request(params));
        self.take()
    }

    pub fn lost(&mut self, now: i64) -> Vec<Out> {
        if matches!(self.state, State::Incompatible | State::Idle) {
            return self.take();
        }
        self.topics.values_mut().for_each(|s| s.pages = None); // a half-received snapshot is worthless
        self.set_state(State::Offline);
        self.attempt += 1;
        let exp = 2_i64.saturating_pow(self.attempt.saturating_sub(1).min(30));
        let delay = self.o.retry_max_ms.min(self.o.retry_base_ms.saturating_mul(exp));
        self.out.push(Out::Retry { at: now + delay });
        self.take()
    }

    fn welcome(&mut self, w: &Welcome) -> bool {
        let lo = self.o.proto_min.max(w.peer.proto_min);
        let hi = self.o.proto_max.min(w.peer.proto_max);
        if lo > hi {
            // outside the window: whichever side is older must update (plan §7.3.2)
            let update = if w.peer.proto_max < self.o.proto_min { Update::Peer } else { Update::Client };
            self.state = State::Incompatible;
            self.out.push(Out::State(State::Incompatible, Some(update)));
            return false;
        }
        let resume = w.resume && self.epoch.as_deref() == Some(w.epoch.as_str());
        if !resume {
            self.out.push(Out::Reset);
            self.held.clear(); // seqs of another epoch, or rows the reset just dropped
        }
        for (t, s) in &mut self.topics {
            s.synced = resume && self.hello.get(t) == Some(&true);
            s.pages = None;
            if s.synced {
                self.held.remove(t);
            }
        }
        self.epoch = Some(w.epoch.clone());
        self.attempt = 0;
        self.set_state(State::Live);
        let late: Vec<Topic> = self.topics.iter().filter(|(t, s)| !self.hello.contains_key(*t) && !s.denied).map(|(t, _)| t.clone()).collect();
        for t in late {
            let m = self.sub_first(&t);
            self.send(m);
        }
        let gone: Vec<Topic> = self.hello.keys().filter(|t| !self.topics.contains_key(*t)).cloned().collect();
        for t in gone {
            self.send(ClientMessage::Unsub(Unsub { t: tag::Unsub, topic: t }));
        }
        self.hello.clear();
        let pending: Vec<Mutate> = self.pending.values().cloned().collect();
        for m in pending {
            self.send(ClientMessage::Mutate(m));
        }
        true
    }

    // ---------- frames ----------

    /// One decoded SSE frame: its `id:` (a watermark: everything at or below it is here) and messages.
    pub fn frame(&mut self, id: Option<u64>, messages: Vec<ServerMessage>) -> Vec<Out> {
        let mut settle = Vec::new();
        let mut resyncs: Vec<Topic> = Vec::new();
        for m in messages {
            if let ServerMessage::Welcome(w) = &m {
                if !self.welcome(w) {
                    return self.take();
                }
                continue;
            }
            if self.state == State::Live {
                self.message(m, &mut settle, &mut resyncs);
            }
        }
        if self.state != State::Live {
            return self.take();
        }
        if let Some(id) = id {
            self.cursor = Some(id);
        }
        for t in resyncs {
            let Some(s) = self.topics.get_mut(&t) else { continue };
            s.pages = None;
            let since = if s.synced { self.cursor } else { None };
            let passive = s.active == 0;
            self.out.push(Out::NeedResubscribe(t.clone()));
            self.send(sub(&t, since, passive));
        }
        self.out.extend(settle); // acks after the frame's ops: the effect is in base when the patch goes
        self.take()
    }

    fn message(&mut self, m: ServerMessage, settle: &mut Vec<Out>, resyncs: &mut Vec<Topic>) {
        match m {
            ServerMessage::Snapshot(s) => {
                let Some(sub) = self.topics.get_mut(&s.topic) else { return };
                let pages = match sub.pages.take() {
                    Some((seq, rows)) if seq == s.seq => (seq, rows),
                    _ => (s.seq, Vec::new()),
                };
                let (seq, mut rows) = pages;
                rows.extend(s.rows);
                if s.more == Some(true) {
                    sub.pages = Some((seq, rows));
                    return;
                }
                sub.synced = true;
                self.out.push(Out::Snapshot { topic: s.topic, rows });
            }
            ServerMessage::Patch(p) => {
                // a topic waiting for its snapshot takes no ops: the snapshot replaces them
                let ops: Vec<EntityOp> = p.ops.into_iter().filter(|op| self.topics.get(&op.topic).is_some_and(|s| s.synced)).collect();
                if !ops.is_empty() {
                    self.out.push(Out::EntityOps(ops));
                }
            }
            ServerMessage::Rows(r) => self.out.push(Out::Rows { req: r.req, rows: r.rows, done: r.done }),
            ServerMessage::Ack(a) => {
                if self.pending.remove(&a.mid).is_some() {
                    settle.push(Out::Ack { mid: a.mid, seq: a.seq, result: a.result });
                }
            }
            ServerMessage::Reject(r) => {
                if self.pending.remove(&r.mid).is_some() {
                    settle.push(Out::Reject { mid: r.mid, code: r.code, message: r.message });
                }
            }
            ServerMessage::Resync(r) => {
                if self.topics.contains_key(&r.topic) && !resyncs.contains(&r.topic) {
                    resyncs.push(r.topic);
                }
            }
            ServerMessage::Notice(n) => self.notice(n),
            ServerMessage::Welcome(_) => {}
        }
    }

    fn notice(&mut self, n: Notice) {
        if n.kind == "denied"
            && let Some(topic) = n.data.get("topic").and_then(Value::as_str).and_then(Topic::parse) {
                if let Some(s) = self.topics.get_mut(&topic) {
                    s.denied = true;
                }
                let code = n.data.get("code").and_then(Value::as_str).unwrap_or("forbidden").to_owned();
                self.out.push(Out::Denied { topic, code });
                return;
            }
        self.out.push(Out::Notice(n));
    }

    // ---------- subscriptions and commands ----------

    pub fn subscribe(&mut self, topic: &Topic, passive: bool) -> Vec<Out> {
        let s = self.topics.entry(topic.clone()).or_insert(TopicSub { refs: 0, active: 0, synced: false, denied: false, pages: None });
        let was_active = s.active > 0;
        s.refs += 1;
        if !passive {
            s.active += 1;
        }
        let (refs, active) = (s.refs, s.active);
        if self.state == State::Live {
            // the first view sends the sub; a first active view turns a passive sub into one that counts
            if refs == 1 {
                let m = self.sub_first(topic);
                self.send(m);
            } else if !was_active && active == 1 {
                self.send(sub(topic, None, false));
            }
        }
        self.take()
    }

    /// The first sub of a topic on this stream: from the seq the mirror holds it as of, if it does.
    fn sub_first(&mut self, topic: &Topic) -> ClientMessage {
        let since = self.held.remove(topic);
        let Some(s) = self.topics.get_mut(topic) else { return sub(topic, None, true) };
        if since.is_some() {
            s.synced = true; // the server pins the cursor at `since` until the delta is sent
        }
        sub(topic, since, s.active == 0)
    }

    pub fn unsubscribe(&mut self, topic: &Topic, passive: bool) -> Vec<Out> {
        let Some(s) = self.topics.get_mut(topic) else { return self.take() };
        s.refs = s.refs.saturating_sub(1);
        if !passive {
            s.active = s.active.saturating_sub(1);
        }
        let (refs, active, denied) = (s.refs, s.active, s.denied);
        if refs > 0 {
            if active == 0 && !passive && self.state == State::Live {
                self.send(sub(topic, None, true)); // nobody needs the box awake for it any more
            }
            return self.take();
        }
        self.topics.remove(topic);
        if self.state == State::Live && !denied {
            self.send(ClientMessage::Unsub(Unsub { t: tag::Unsub, topic: topic.clone() }));
        }
        self.take()
    }

    /// A command for this peer. Kept by `mid` until it is acked or rejected, and resent with the same
    /// mid after every welcome: the peer runs it once however often the link drops.
    pub fn mutate(&mut self, mid: &str, cmd: &str, args: Value, base_seq: Option<u64>) -> Vec<Out> {
        let m = Mutate { t: tag::Mutate, mid: mid.to_owned(), cmd: cmd.to_owned(), args, base_seq };
        self.pending.insert(m.mid.clone(), m.clone());
        if self.state == State::Live {
            self.send(ClientMessage::Mutate(m));
        }
        self.take()
    }

    pub fn window(&mut self, req: &str, topic: &Topic, before_seq: u64, limit: u32) -> Vec<Out> {
        if self.state == State::Live {
            self.send(ClientMessage::Window(Window { t: tag::Window, req: req.to_owned(), topic: topic.clone(), before_seq, limit }));
        }
        self.take()
    }

    /// The mirror couldn't apply an op on this topic: start it over.
    pub fn drifted(&mut self, topic: &Topic) -> Vec<Out> {
        let Some(s) = self.topics.get_mut(topic) else { return self.take() };
        s.synced = false;
        s.pages = None;
        let passive = s.active == 0;
        if self.state == State::Live {
            self.send(ClientMessage::Unsub(Unsub { t: tag::Unsub, topic: topic.clone() }));
            self.send(sub(topic, None, passive));
        }
        self.take()
    }
}

/// A wisp frame from an SSE event (`event: sync`): its cursor and messages; `None` for anything else.
pub fn decode_frame(event: &str, id: Option<&str>, data: &str) -> Option<(Option<u64>, Vec<ServerMessage>)> {
    if event != "sync" {
        return None;
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(data) else { return None };
    let messages = items.into_iter().filter_map(|m| serde_json::from_value(m).ok()).collect();
    Some((id.and_then(|i| i.parse().ok()), messages))
}

#[cfg(test)]
#[path = "peer_client_tests.rs"]
mod tests;
