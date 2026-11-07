//! Test harness: a fake store with a change log, the client's apply rules, and a simulated wire that
//! carries SyncServer frames to client models through the real SSE encoder and parser.
//! Deterministic: a seeded RNG and a scripted clock.
#![allow(
    clippy::semicolon_if_nothing_returned,
    dead_code,
    unused_imports,
    clippy::unwrap_used,
    clippy::missing_panics_doc
)]

pub mod client;
mod sim;

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_protocol::{Change, EntityOp, PeerInfo, Row, Topic, diff, patched};
use wisp_sync::{ChangeRow, Gone, SyncOptions, SyncServer};

pub use sim::{Sim, SimClient, SimOpts};

pub fn peer() -> PeerInfo {
    PeerInfo {
        peer: "laptop".into(),
        name: "laptop".into(),
        build: "test".into(),
        version: "2.0.0".into(),
        proto_min: 2,
        proto_max: 2,
        plugins: vec![],
    }
}

pub fn topic(s: &str) -> Topic {
    Topic::parse(s).unwrap()
}

/// xorshift32, as the TS harness's `rng`.
#[derive(Debug, Clone)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(if seed == 0 { 1 } else { seed })
    }

    pub fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        f64::from(self.0) / 4_294_967_296.0
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64) as usize
    }
}

/// What a test commits. `Set` diffs the old value into a patch row, as the real store does.
#[derive(Debug, Clone)]
pub enum Op {
    Upsert(Value),
    Set(Value),
    Del,
    Append(Vec<Value>),
}

#[derive(Debug, Clone)]
pub struct TestChange {
    pub topic: Topic,
    pub e: String,
    pub id: String,
    pub op: Op,
}

pub fn ch(t: &str, e: &str, id: &str, op: Op) -> TestChange {
    TestChange {
        topic: topic(t),
        e: e.into(),
        id: id.into(),
        op,
    }
}

/// A list row's title, set (so it goes as a patch once the row exists).
pub fn title(t: &str) -> TestChange {
    ch("list", "session", "s1", Op::Set(json!({ "title": t })))
}

pub fn key(e: &str, id: &str) -> String {
    format!("{e}\u{0}{id}")
}

/// topic → `e \0 id` → row
pub type EntityMap = BTreeMap<Topic, BTreeMap<String, Row>>;

#[derive(Debug, Default)]
pub struct FakeStore {
    pub rows: EntityMap,
    pub log: Vec<ChangeRow>,
    pub seq: u64,
    pub oldest: u64,
}

impl FakeStore {
    /// One transaction: the change rows it wrote (a no-op writes none).
    pub fn commit(&mut self, changes: &[TestChange], at: u64) -> Vec<ChangeRow> {
        let mut out = Vec::new();
        for c in changes {
            let t = self.rows.entry(c.topic.clone()).or_default();
            let k = key(&c.e, &c.id);
            let cur = t.get(&k).map(|r| r.v.clone());
            let change = match (&c.op, cur) {
                (Op::Del, None) => continue,
                (Op::Del, Some(_)) => {
                    t.remove(&k);
                    Change::Del
                }
                (Op::Append(items), cur) => {
                    let mut list = match cur {
                        None => vec![],
                        Some(Value::Array(a)) => a,
                        Some(_) => continue,
                    };
                    list.extend(items.iter().cloned());
                    t.insert(
                        k,
                        Row {
                            e: c.e.clone(),
                            id: c.id.clone(),
                            v: Value::Array(list),
                        },
                    );
                    Change::Append { v: items.clone() }
                }
                (Op::Set(v), Some(old)) => {
                    let ops = diff(&old, v);
                    if ops.is_empty() {
                        continue;
                    }
                    t.insert(
                        k,
                        Row {
                            e: c.e.clone(),
                            id: c.id.clone(),
                            v: patched(&old, &ops).unwrap(),
                        },
                    );
                    Change::Patch { ops }
                }
                (Op::Upsert(v) | Op::Set(v), _) => {
                    t.insert(
                        k,
                        Row {
                            e: c.e.clone(),
                            id: c.id.clone(),
                            v: v.clone(),
                        },
                    );
                    Change::Upsert { v: v.clone() }
                }
            };
            self.seq += 1;
            let row = ChangeRow {
                seq: self.seq,
                topic: c.topic.clone(),
                entity: c.e.clone(),
                id: c.id.clone(),
                change,
                at,
            };
            self.log.push(row.clone());
            out.push(row);
        }
        out
    }

    pub fn snapshot(&self, t: &Topic) -> Vec<Row> {
        self.rows
            .get(t)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Rows changed since `since` (current values) and the ones gone: a resume's delta.
    pub fn delta(&self, t: &Topic, since: u64) -> (Vec<Row>, Vec<Gone>) {
        let mut seen: BTreeMap<String, (String, String)> = BTreeMap::new();
        for r in self.log.iter().filter(|r| &r.topic == t && r.seq > since) {
            seen.insert(key(&r.entity, &r.id), (r.entity.clone(), r.id.clone()));
        }
        let (mut rows, mut gone) = (Vec::new(), Vec::new());
        for (k, (e, id)) in seen {
            match self.rows.get(t).and_then(|m| m.get(&k)) {
                Some(r) => rows.push(r.clone()),
                None => gone.push(Gone { e, id }),
            }
        }
        (rows, gone)
    }

    pub fn trim(&mut self, up_to: u64) {
        self.log.retain(|r| r.seq > up_to);
        self.oldest = self.oldest.max(up_to);
    }
}

pub fn make_server(
    store: &FakeStore,
    f: impl FnOnce(&mut SyncOptions<String>),
) -> SyncServer<String> {
    let mut o = SyncOptions::new(
        "E1",
        peer(),
        store.seq,
        store.oldest,
        Box::new(|_: &String, _: &Topic| true),
    );
    f(&mut o);
    SyncServer::new(o)
}

pub fn apply_snapshot(map: &mut EntityMap, t: &Topic, rows: Vec<Row>) {
    map.insert(
        t.clone(),
        rows.into_iter().map(|r| (key(&r.e, &r.id), r)).collect(),
    );
}

/// Applies ops in order; returns the topics where one didn't apply (the copy drifted).
pub fn apply_entity_ops(map: &mut EntityMap, ops: &[EntityOp]) -> Vec<Topic> {
    let mut failed: Vec<Topic> = Vec::new();
    for op in ops {
        let rows = map.entry(op.topic.clone()).or_default();
        let k = key(&op.e, &op.id);
        let ok = match &op.change {
            Change::Upsert { v } => {
                rows.insert(
                    k,
                    Row {
                        e: op.e.clone(),
                        id: op.id.clone(),
                        v: v.clone(),
                    },
                );
                true
            }
            Change::Del => {
                rows.remove(&k);
                true
            }
            Change::Patch { ops } => match rows.get(&k).map(|r| patched(&r.v, ops)) {
                Some(Ok(v)) => {
                    rows.insert(
                        k,
                        Row {
                            e: op.e.clone(),
                            id: op.id.clone(),
                            v,
                        },
                    );
                    true
                }
                _ => false,
            },
            Change::Append { v } => match rows.get(&k).map(|r| r.v.clone()) {
                None => {
                    rows.insert(
                        k,
                        Row {
                            e: op.e.clone(),
                            id: op.id.clone(),
                            v: Value::Array(v.clone()),
                        },
                    );
                    true
                }
                Some(Value::Array(mut a)) => {
                    a.extend(v.iter().cloned());
                    rows.insert(
                        k,
                        Row {
                            e: op.e.clone(),
                            id: op.id.clone(),
                            v: Value::Array(a),
                        },
                    );
                    true
                }
                Some(_) => false,
            },
        };
        if !ok && !failed.contains(&op.topic) {
            failed.push(op.topic.clone());
        }
    }
    failed
}

/// The rows of `t`, sorted, to compare a client with the store.
pub fn view(map: &EntityMap, t: &Topic) -> Vec<Row> {
    map.get(t)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}
