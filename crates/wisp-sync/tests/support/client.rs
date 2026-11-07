//! A Rust model of @wisp/sync's `SyncClient` (packages/sync/src/client.ts), rule for rule, so the
//! property test checks the server against the client semantics that ship. It keeps the cursor for
//! (peer, epoch), refcounts subscriptions, resends pending mutations after welcome with the same mid.

use std::collections::BTreeMap;

use wisp_protocol::{
    ClientMessage, EntityOp, Mutate, PROTO, PROTO_MIN, Row, ServerMessage, Sub, Topic, Unsub,
    Welcome, tag,
};
use wisp_sync::ConnectQuery;

#[derive(Debug, Clone, Default)]
pub struct Saved {
    pub epoch: Option<String>,
    pub cursor: Option<u64>,
    /// topics whose rows the client store holds as of `cursor`
    pub synced: Vec<Topic>,
    pub pending: Vec<Mutate>,
    /// topics the store still holds from before, not subscribed now, and the seq they are as of
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

#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Request(ConnectQuery),
    Send(ClientMessage),
    Reset,
    Snapshot { topic: Topic, rows: Vec<Row> },
    EntityOps(Vec<EntityOp>),
    Ack { mid: String },
    Reject { mid: String },
    NeedResubscribe(Topic),
    Denied(Topic),
    State(State),
    Retry(u64),
}

#[derive(Debug, Default)]
struct TopicSub {
    refs: u32,
    active_refs: u32,
    synced: bool,
    denied: bool,
    pages: Option<(u64, Vec<Row>)>,
}

#[derive(Debug)]
pub struct SyncClient {
    client_id: String,
    state: State,
    epoch: Option<String>,
    pub cursor: Option<u64>,
    topics: BTreeMap<Topic, TopicSub>,
    held: BTreeMap<Topic, u64>,
    pending: Vec<Mutate>,
    hello: BTreeMap<Topic, bool>,
    attempt: u32,
    out: Vec<Out>,
}

impl SyncClient {
    pub fn new(client_id: &str, saved: Option<Saved>) -> Self {
        let saved = saved.unwrap_or_default();
        let mut held: BTreeMap<Topic, u64> = saved
            .cursor
            .map(|at| saved.synced.iter().map(|t| (t.clone(), at)).collect())
            .unwrap_or_default();
        held.extend(saved.held);
        let topics = BTreeMap::new();
        Self {
            client_id: client_id.into(),
            state: State::Idle,
            epoch: saved.epoch,
            cursor: saved.cursor,
            topics,
            held,
            pending: saved.pending,
            hello: BTreeMap::new(),
            attempt: 0,
            out: Vec::new(),
        }
    }

    pub fn save(&self) -> Saved {
        let synced: Vec<Topic> = self
            .topics
            .iter()
            .filter(|(_, s)| s.synced)
            .map(|(t, _)| t.clone())
            .collect();
        let held = self
            .held
            .iter()
            .filter(|(t, _)| !synced.contains(t))
            .map(|(t, s)| (t.clone(), *s))
            .collect();
        Saved {
            epoch: self.epoch.clone(),
            cursor: self.cursor,
            synced,
            pending: self.pending.clone(),
            held,
        }
    }

    fn send(&mut self, m: ClientMessage) {
        self.out.push(Out::Send(m));
    }

    fn set_state(&mut self, s: State) {
        if self.state != s {
            self.state = s;
            self.out.push(Out::State(s));
        }
    }

    fn sub_message(topic: &Topic, s: &TopicSub, since: Option<u64>) -> ClientMessage {
        ClientMessage::Sub(Sub {
            t: tag::Sub,
            topic: topic.clone(),
            since,
            passive: (s.active_refs == 0).then_some(true),
        })
    }

    pub fn open(&mut self) -> Vec<Out> {
        if !matches!(self.state, State::Connecting | State::Live) {
            self.set_state(State::Connecting);
            let mut q = ConnectQuery {
                proto_min: Some(PROTO_MIN.to_string()),
                proto_max: Some(PROTO.to_string()),
                client_id: Some(self.client_id.clone()),
                build: Some("test".into()),
                ..ConnectQuery::default()
            };
            let can_resume = self.epoch.is_some() && self.cursor.is_some();
            if can_resume {
                q.epoch.clone_from(&self.epoch);
                q.cursor = self.cursor.map(|c| c.to_string());
            }
            let (mut topics, mut fresh, mut passive) = (Vec::new(), Vec::new(), Vec::new());
            self.hello.clear();
            for (t, s) in &self.topics {
                if s.denied {
                    continue;
                }
                // a topic held as of an older seq can't ride the hello's one cursor: it goes after the welcome
                if !s.synced && self.held.get(t).is_some_and(|at| Some(*at) != self.cursor) {
                    continue;
                }
                let resumed = can_resume && (s.synced || self.held.contains_key(t));
                self.hello.insert(t.clone(), resumed);
                if resumed {
                    topics.push(t.as_str())
                } else {
                    fresh.push(t.as_str())
                }
                if s.active_refs == 0 {
                    passive.push(t.as_str());
                }
            }
            let join = |v: &[&str]| (!v.is_empty()).then(|| v.join(","));
            q.topics = join(&topics);
            q.fresh = join(&fresh);
            q.passive = if passive.is_empty() {
                None
            } else if passive.len() == self.hello.len() {
                Some("1".into())
            } else {
                join(&passive)
            };
            self.out.push(Out::Request(q));
        }
        std::mem::take(&mut self.out)
    }

    pub fn lost(&mut self, now: u64) -> Vec<Out> {
        if !matches!(self.state, State::Incompatible | State::Idle) {
            for s in self.topics.values_mut() {
                s.pages = None; // a half-received snapshot is worthless
            }
            self.set_state(State::Offline);
            self.attempt += 1;
            let delay = (500u64 << (self.attempt - 1).min(16)).min(30_000);
            self.out.push(Out::Retry(now + delay));
        }
        std::mem::take(&mut self.out)
    }

    fn welcome(&mut self, w: &Welcome) -> bool {
        if PROTO_MIN.max(w.peer.proto_min) > PROTO.min(w.peer.proto_max) {
            self.state = State::Incompatible;
            self.out.push(Out::State(State::Incompatible));
            return false;
        }
        let resume = w.resume && w.epoch.as_str() == self.epoch.as_deref().unwrap_or("\u{0}");
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
        // subscribed while the hello was in flight (or held as of an older seq)
        let later: Vec<Topic> = self
            .topics
            .iter()
            .filter(|(t, s)| !self.hello.contains_key(*t) && !s.denied)
            .map(|(t, _)| t.clone())
            .collect();
        for t in later {
            let m = self.sub_first(&t);
            self.send(m);
        }
        let gone: Vec<Topic> = self
            .hello
            .keys()
            .filter(|t| !self.topics.contains_key(*t))
            .cloned()
            .collect();
        for t in gone {
            self.send(ClientMessage::Unsub(Unsub {
                t: tag::Unsub,
                topic: t,
            }));
        }
        self.hello.clear();
        for m in self.pending.clone() {
            self.send(ClientMessage::Mutate(m));
        }
        true
    }

    pub fn frame(&mut self, id: Option<u64>, messages: Vec<ServerMessage>) -> Vec<Out> {
        let mut settle = Vec::new();
        let mut resyncs: Vec<Topic> = Vec::new();
        for m in messages {
            if let ServerMessage::Welcome(w) = &m {
                if !self.welcome(w) {
                    return std::mem::take(&mut self.out);
                }
                continue;
            }
            if self.state == State::Live {
                self.message(m, &mut settle, &mut resyncs); // nothing counts before the welcome
            }
        }
        if self.state != State::Live {
            return std::mem::take(&mut self.out);
        }
        if id.is_some() {
            self.cursor = id; // a watermark: everything at or below it is here
        }
        for t in resyncs {
            let cursor = self.cursor;
            let Some(s) = self.topics.get_mut(&t) else {
                continue;
            };
            s.pages = None;
            let since = if s.synced { cursor } else { None };
            let m = Self::sub_message(&t, s, since);
            self.out.push(Out::NeedResubscribe(t));
            self.send(m);
        }
        self.out.extend(settle); // acks after the frame's ops
        std::mem::take(&mut self.out)
    }

    fn message(&mut self, m: ServerMessage, settle: &mut Vec<Out>, resyncs: &mut Vec<Topic>) {
        match m {
            ServerMessage::Snapshot(snap) => {
                let Some(s) = self.topics.get_mut(&snap.topic) else {
                    return;
                };
                let pages = match s.pages.take() {
                    Some((seq, rows)) if seq == snap.seq => (seq, rows),
                    _ => (snap.seq, Vec::new()),
                };
                let (seq, mut rows) = pages;
                rows.extend(snap.rows);
                if snap.more == Some(true) {
                    s.pages = Some((seq, rows));
                    return;
                }
                s.synced = true;
                self.out.push(Out::Snapshot {
                    topic: snap.topic,
                    rows,
                });
            }
            ServerMessage::Patch(p) => {
                // a topic waiting for its snapshot takes no ops: the snapshot replaces them
                let ops: Vec<EntityOp> = p
                    .ops
                    .into_iter()
                    .filter(|op| self.topics.get(&op.topic).is_some_and(|s| s.synced))
                    .collect();
                if !ops.is_empty() {
                    self.out.push(Out::EntityOps(ops));
                }
            }
            ServerMessage::Ack(a) => {
                if self.take_pending(&a.mid) {
                    settle.push(Out::Ack { mid: a.mid });
                }
            }
            ServerMessage::Reject(r) => {
                if self.take_pending(&r.mid) {
                    settle.push(Out::Reject { mid: r.mid });
                }
            }
            ServerMessage::Resync(r) => {
                if self.topics.contains_key(&r.topic) && !resyncs.contains(&r.topic) {
                    resyncs.push(r.topic);
                }
            }
            ServerMessage::Notice(n) => {
                if n.kind == "denied" {
                    if let Some(topic) = n
                        .data
                        .get("topic")
                        .and_then(|t| t.as_str())
                        .and_then(Topic::parse)
                    {
                        if let Some(s) = self.topics.get_mut(&topic) {
                            s.denied = true;
                        }
                        self.out.push(Out::Denied(topic));
                    }
                }
            }
            ServerMessage::Rows(_) | ServerMessage::Welcome(_) => {}
        }
    }

    fn take_pending(&mut self, mid: &str) -> bool {
        let before = self.pending.len();
        self.pending.retain(|m| m.mid != mid);
        self.pending.len() != before
    }

    pub fn subscribe(&mut self, topic: &Topic, passive: bool) -> Vec<Out> {
        let s = self.topics.entry(topic.clone()).or_default();
        let was_active = s.active_refs > 0;
        s.refs += 1;
        if !passive {
            s.active_refs += 1;
        }
        let (refs, active) = (s.refs, s.active_refs);
        if self.state == State::Live {
            if refs == 1 {
                let m = self.sub_first(topic);
                self.send(m);
            } else if !was_active && active == 1 {
                let m = Self::sub_message(topic, &self.topics[topic], None);
                self.send(m);
            }
        }
        std::mem::take(&mut self.out)
    }

    /// The first sub of a topic on this stream: from the seq the store holds it as of, if it does.
    fn sub_first(&mut self, topic: &Topic) -> ClientMessage {
        let since = self.held.remove(topic);
        let s = self.topics.entry(topic.clone()).or_default();
        if since.is_some() {
            s.synced = true; // the server pins the cursor at `since` until the delta is sent
        }
        Self::sub_message(topic, s, since)
    }

    pub fn unsubscribe(&mut self, topic: &Topic, passive: bool) -> Vec<Out> {
        let live = self.state == State::Live;
        if let Some(s) = self.topics.get_mut(topic) {
            s.refs -= 1;
            if !passive && s.active_refs > 0 {
                s.active_refs -= 1;
            }
            if s.refs > 0 {
                if s.active_refs == 0 && !passive && live {
                    let m = Self::sub_message(topic, s, None);
                    self.send(m);
                }
            } else if let Some(s) = self.topics.remove(topic) {
                if live && !s.denied {
                    self.send(ClientMessage::Unsub(Unsub {
                        t: tag::Unsub,
                        topic: topic.clone(),
                    }));
                }
            }
        }
        std::mem::take(&mut self.out)
    }

    pub fn mutate(&mut self, m: Mutate) -> Vec<Out> {
        self.pending.retain(|p| p.mid != m.mid);
        self.pending.push(m.clone());
        if self.state == State::Live {
            self.send(ClientMessage::Mutate(m));
        }
        std::mem::take(&mut self.out)
    }

    /// The client store couldn't apply an op on this topic: start it over.
    pub fn drifted(&mut self, topic: &Topic) -> Vec<Out> {
        let live = self.state == State::Live;
        if let Some(s) = self.topics.get_mut(topic) {
            s.synced = false;
            s.pages = None;
            if live {
                let m = Self::sub_message(topic, s, None);
                self.send(ClientMessage::Unsub(Unsub {
                    t: tag::Unsub,
                    topic: topic.clone(),
                }));
                self.send(m);
            }
        }
        std::mem::take(&mut self.out)
    }
}
