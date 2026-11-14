//! One connection's outbox (plan §4.4): entity ops keyed by (topic, e, id) so a newer change folds
//! into the one still queued, plus snapshot and window pages in front of each topic's ops. Taking
//! from it follows the priority order: the client's sessions, then the list, then the rest.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, OnceLock};

use wisp_protocol::{EntityOp, Topic};

use crate::fold::{fold_into, may_fold, replaces};

/// A committed op, shared by every connection that holds its topic: its JSON is made once, as v1's
/// broadcast stringified once. A fold makes a new, unshared one.
#[derive(Debug)]
pub(crate) struct SharedOp {
    pub op: EntityOp,
    /// `e \0 id`: the outbox key within the topic
    pub key: Arc<str>,
    json: OnceLock<String>,
}

impl SharedOp {
    pub fn new(op: EntityOp) -> Self {
        let key = Arc::from(format!("{}\u{0}{}", op.e, op.id));
        Self { op, key, json: OnceLock::new() }
    }

    pub fn json(&self) -> &str {
        // an op is plain data: serialising it can't fail, and if it did the client would resync
        self.json.get_or_init(|| serde_json::to_string(&self.op).unwrap_or_default())
    }
}

impl Clone for SharedOp {
    fn clone(&self) -> Self {
        Self { op: self.op.clone(), key: self.key.clone(), json: OnceLock::new() }
    }
}

#[derive(Debug)]
struct Item {
    ops: Vec<Arc<SharedOp>>,
    /// the oldest change folded in: the cursor can't pass it until the item is sent
    first_seq: u64,
    bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrontKind {
    Snapshot,
    Rows,
}

/// A snapshot or rows message, already JSON.
#[derive(Debug)]
pub(crate) struct Front {
    pub json: String,
    pub kind: FrontKind,
    /// a snapshot replacing rows the client holds as of `first_seq - 1` pins the cursor like an op
    pub first_seq: Option<u64>,
}

#[derive(Debug, Default)]
struct TopicQueue {
    front: VecDeque<Front>,
    /// insertion order → item; `index` finds an entity's item
    items: BTreeMap<u64, Item>,
    index: HashMap<Arc<str>, u64>,
}

impl TopicQueue {
    fn oldest(&self) -> Option<u64> {
        let fronts = self.front.iter().filter_map(|f| f.first_seq);
        fronts.chain(self.items.values().map(|i| i.first_seq)).min()
    }

    fn busy(&self) -> bool {
        !self.items.is_empty() || self.front.iter().any(|f| f.kind == FrontKind::Snapshot)
    }

    fn is_empty(&self) -> bool {
        self.front.is_empty() && self.items.is_empty()
    }
}

/// What one flush takes: snapshot and rows messages in order, then ops for one patch.
#[derive(Debug, Default)]
pub(crate) struct Taken {
    pub fronts: Vec<String>,
    pub ops: Vec<Arc<SharedOp>>,
    pub bytes: usize,
}

#[derive(Debug, Default)]
pub(crate) struct Outbox {
    topics: BTreeMap<Topic, TopicQueue>,
    order: u64,
}

impl Outbox {
    pub fn push_op(&mut self, op: Arc<SharedOp>, seq: u64, bytes: usize) {
        let q = self.topics.entry(op.op.topic.clone()).or_default();
        if let Some(item) = q.index.get(&op.key).and_then(|at| q.items.get_mut(at)) {
            if replaces(&op.op.change) {
                item.ops.clear();
                item.ops.push(op);
                item.bytes = bytes;
                return;
            }
            item.bytes += bytes;
            if let Some(last) = item.ops.last_mut().filter(|l| may_fold(&l.op.change, &op.op.change)) {
                // copy-on-write: a committed op other connections share is cloned before it changes
                let mine = Arc::make_mut(last);
                if fold_into(&mut mine.op.change, &op.op.change) {
                    mine.json = OnceLock::new();
                    return;
                }
            }
            item.ops.push(op);
            return;
        }
        self.order += 1;
        q.index.insert(op.key.clone(), self.order);
        q.items.insert(self.order, Item { ops: vec![op], first_seq: seq, bytes });
    }

    pub fn push_front(&mut self, topic: &Topic, front: Front) {
        self.topics.entry(topic.clone()).or_default().front.push_back(front);
    }

    /// Drops the topic's queued ops and snapshot pages; window rows stay when `keep_rows` (someone
    /// asked for them). Returns the oldest dropped seq, and whether anything but rows was dropped.
    pub fn drop_topic(&mut self, topic: &Topic, keep_rows: bool) -> (Option<u64>, bool) {
        let Some(q) = self.topics.get_mut(topic) else {
            return (None, false);
        };
        let oldest = q.oldest();
        let any = q.busy();
        q.items.clear();
        q.index.clear();
        if keep_rows {
            q.front.retain(|f| f.kind == FrontKind::Rows);
        } else {
            q.front.clear();
        }
        if q.is_empty() {
            self.topics.remove(topic);
        }
        (oldest, any)
    }

    /// Topics with ops or snapshot pages waiting (window rows alone don't count).
    pub fn busy_topics(&self) -> Vec<Topic> {
        self.topics.iter().filter(|(_, q)| q.busy()).map(|(t, _)| t.clone()).collect()
    }

    pub fn oldest_seq(&self) -> Option<u64> {
        self.topics.values().filter_map(TopicQueue::oldest).min()
    }

    pub fn is_empty(&self) -> bool {
        self.topics.is_empty()
    }

    /// Takes messages and ops up to `budget` bytes, highest priority first. Something is always
    /// taken when anything is queued, so one item bigger than the budget can't stall the stream.
    pub fn take(&mut self, budget: usize) -> Taken {
        let mut taken = Taken::default();
        let mut order: Vec<Topic> = self.topics.keys().cloned().collect();
        order.sort_by_key(Topic::rank); // stable: by name within a rank
        for topic in order {
            let Some(q) = self.topics.get_mut(&topic) else {
                continue;
            };
            let done = take_topic(q, &mut taken, budget);
            if q.is_empty() {
                self.topics.remove(&topic);
            }
            if !done {
                break;
            }
        }
        taken
    }
}

/// False when the budget ran out inside this topic.
fn take_topic(q: &mut TopicQueue, taken: &mut Taken, budget: usize) -> bool {
    let fits = |taken: &Taken, bytes: usize| taken.bytes == 0 || taken.bytes + bytes <= budget;
    while let Some(f) = q.front.front() {
        if !fits(taken, f.json.len()) {
            return false;
        }
        if let Some(f) = q.front.pop_front() {
            taken.bytes += f.json.len();
            taken.fronts.push(f.json);
        }
    }
    while let Some(entry) = q.items.first_entry() {
        if !fits(taken, entry.get().bytes) {
            return false;
        }
        let item = entry.remove();
        if let Some(k) = item.ops.first().map(|o| o.key.clone()) {
            q.index.remove(&k);
        }
        taken.bytes += item.bytes;
        taken.ops.extend(item.ops);
    }
    true
}
