//! The rows each peer's `list` shows, as this wisp last saw them: fresh while the peer is online,
//! kept while it isn't (an asleep box's tasks stay on screen), and saved so a restart shows them and
//! resumes from the cursor instead of taking the whole list again. Pure: the host flushes `dirty()`
//! to the store in one transaction per flush, not one per remote change.
//!
//! Ids stay as the peer made them.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use wisp_machines_api::{MirrorRow, RemoteOp};
use wisp_protocol::{Change, EntityOp, Row, Topic, apply_patch};

pub const LIST: &str = "list";

type Key = (String, String); // (entity, id)

#[derive(Debug, Default)]
pub struct Mirror {
    /// peer → topic → (e, id) → value
    peers: BTreeMap<String, BTreeMap<String, BTreeMap<Key, Value>>>,
    /// peer → list rows whose stored copy is behind
    dirty: BTreeMap<String, BTreeSet<Key>>,
}

/// One list row that changed, for `machines.remote`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Touched {
    pub peer: String,
    pub op: RemoteOp,
    pub id: String,
}

impl Mirror {
    pub fn new() -> Self {
        Self::default()
    }

    /// A row read back from the store at start.
    pub fn load(&mut self, peer: &str, e: &str, id: &str, v: Value) {
        self.topic(peer, LIST).insert((e.to_owned(), id.to_owned()), v);
    }

    fn topic(&mut self, peer: &str, topic: &str) -> &mut BTreeMap<Key, Value> {
        self.peers.entry(peer.to_owned()).or_default().entry(topic.to_owned()).or_default()
    }

    /// The list rows of one peer, or of every peer.
    pub fn rows(&self, peer: Option<&str>) -> Vec<MirrorRow> {
        let mut out = Vec::new();
        for (p, topics) in &self.peers {
            if peer.is_some_and(|x| x != p) {
                continue;
            }
            for ((_, id), v) in topics.get(LIST).into_iter().flatten() {
                out.push(MirrorRow { peer: p.clone(), id: id.clone(), v: v.clone() });
            }
        }
        out
    }

    pub fn get(&self, peer: &str, e: &str, id: &str) -> Option<&Value> {
        self.peers.get(peer)?.get(LIST)?.get(&(e.to_owned(), id.to_owned()))
    }

    pub fn len(&self, peer: &str) -> usize {
        self.peers.get(peer).and_then(|t| t.get(LIST)).map_or(0, BTreeMap::len)
    }

    pub fn is_empty(&self) -> bool {
        self.peers.values().all(|t| t.values().all(BTreeMap::is_empty))
    }

    fn touch(&mut self, peer: &str, key: &Key, op: RemoteOp, out: &mut Vec<Touched>) {
        self.dirty.entry(peer.to_owned()).or_default().insert(key.clone());
        out.push(Touched { peer: peer.to_owned(), op, id: key.1.clone() });
    }

    /// A full snapshot of one topic replaces what was there; only rows that differ are touched.
    pub fn snapshot(&mut self, peer: &str, topic: &Topic, rows: Vec<Row>) -> Vec<Touched> {
        let next: BTreeMap<Key, Value> = rows.into_iter().map(|r| ((r.e, r.id), r.v)).collect();
        let before = std::mem::replace(self.topic(peer, topic.as_str()), next);
        let mut out = Vec::new();
        if topic.as_str() != LIST {
            return out;
        }
        let after = self.topic(peer, LIST).clone();
        for k in before.keys().filter(|k| !after.contains_key(*k)) {
            self.touch(peer, k, RemoteOp::Del, &mut out);
        }
        for (k, v) in &after {
            if before.get(k) != Some(v) {
                self.touch(peer, k, RemoteOp::Upsert, &mut out);
            }
        }
        out
    }

    /// Applies ops in order. Returns what changed, and the topics that drifted (an op that didn't
    /// apply: the caller resubscribes those).
    pub fn apply(&mut self, peer: &str, ops: Vec<EntityOp>) -> (Vec<Touched>, Vec<Topic>) {
        let mut out = Vec::new();
        let mut drifted: Vec<Topic> = Vec::new();
        for op in ops {
            let key = (op.e.clone(), op.id.clone());
            let rows = self.topic(peer, op.topic.as_str());
            let ok = match op.change {
                Change::Upsert { v } => {
                    rows.insert(key.clone(), v);
                    true
                }
                Change::Del => {
                    rows.remove(&key);
                    true
                }
                Change::Patch { ops } => rows.get_mut(&key).is_some_and(|doc| apply_patch(doc, &ops).is_ok()),
                Change::Append { v } => match rows.get_mut(&key) {
                    Some(Value::Array(items)) => {
                        items.extend(v);
                        true
                    }
                    Some(_) => false,
                    None => {
                        rows.insert(key.clone(), Value::Array(v));
                        true
                    }
                },
            };
            if !ok {
                if !drifted.contains(&op.topic) {
                    drifted.push(op.topic.clone());
                }
                continue;
            }
            if op.topic.as_str() == LIST {
                let there = self.topic(peer, LIST).contains_key(&key);
                self.touch(peer, &key, if there { RemoteOp::Upsert } else { RemoteOp::Del }, &mut out);
            }
        }
        (out, drifted)
    }

    /// A peer whose rows can't be trusted any more (a new epoch), or one removed.
    pub fn reset(&mut self, peer: &str) -> Vec<Touched> {
        let keys: Vec<Key> = self.peers.remove(peer).and_then(|mut t| t.remove(LIST)).map(|l| l.into_keys().collect()).unwrap_or_default();
        let mut out = Vec::new();
        for k in &keys {
            self.touch(peer, k, RemoteOp::Del, &mut out);
        }
        out
    }

    /// What to write since the last flush: `(peer, e, id, Some(value) | None for a delete)`.
    pub fn take_dirty(&mut self) -> Vec<(String, String, String, Option<Value>)> {
        let dirty = std::mem::take(&mut self.dirty);
        let mut out = Vec::new();
        for (peer, keys) in dirty {
            for (e, id) in keys {
                let v = self.get(&peer, &e, &id).cloned();
                out.push((peer.clone(), e, id, v));
            }
        }
        out
    }

    /// Rows of this peer's list whose `state` is `running` (the card's "working").
    pub fn working(&self, peer: &str) -> u32 {
        let n = self.peers.get(peer).and_then(|t| t.get(LIST)).map_or(0, |l| l.values().filter(|v| v.get("state").and_then(Value::as_str) == Some("running")).count());
        u32::try_from(n).unwrap_or(u32::MAX)
    }
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
