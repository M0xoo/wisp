//! What the server keeps per connection and per subscription (server.rs and flush.rs run the rules).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use wisp_protocol::Topic;

use crate::outbox::{Outbox, SharedOp};
use crate::{ConnId, Output, Stats, SyncOptions};

/// loading: a snapshot or delta is asked for · waiting: held back by backpressure · dropped: resync sent
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubState {
    Loading,
    Waiting,
    Live,
    Dropped,
}

#[derive(Debug)]
pub(crate) struct Sub {
    pub passive: bool,
    pub state: SubState,
    /// loading, waiting, dropped: the client holds the topic as of this seq (None: no rows yet)
    pub since: Option<u64>,
    pub req: u64,
    /// live changes that came while loading, sent after the snapshot when newer than it
    pub buffer: Vec<(u64, Arc<SharedOp>)>,
    pub buffer_bytes: usize,
}

#[derive(Debug)]
pub(crate) struct PendingAck {
    pub mid: String,
    pub seq: u64,
    pub result: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct Conn<C> {
    pub id: ConnId,
    pub caller: C,
    pub client_id: String,
    pub subs: HashMap<Topic, Sub>,
    pub out: Outbox,
    /// welcome, rejects, notices, resyncs: JSON, sent ahead of every topic
    pub control: Vec<String>,
    /// an ack waits until the watermark passes its seq: its effects go first
    pub acks: Vec<PendingAck>,
    pub windows: HashMap<String, Topic>,
    /// what the socket holds, as the host last reported plus what was written since
    pub buffered: usize,
    /// None: never flushed, or the next flush may go at once
    pub last_flush_at: Option<u64>,
    pub last_write_at: u64,
    pub active: bool,
}

/// A v1 stream: named events only, no topics or cursor.
#[derive(Debug)]
pub(crate) struct V1Conn {
    pub relay: bool,
    pub last_write_at: u64,
}

/// Everything but the connections, so a rule can borrow one connection and the rest at once.
pub(crate) struct Core<C> {
    pub opts: SyncOptions<C>,
    pub head: u64,
    pub oldest: u64,
    pub req: u64,
    pub out: Vec<Output<C>>,
    pub stats: Stats,
}

impl<C> Core<C> {
    pub fn low_water(&self) -> usize {
        self.opts.high_water_bytes / 2
    }

    /// Every change at or below it, on every topic the client holds, has reached the client.
    /// Priorities and folding reorder what goes out, so the newest seq would let a resume skip a
    /// change still queued.
    pub fn watermark(&self, c: &Conn<C>) -> u64 {
        let mut w = self.head;
        if let Some(q) = c.out.oldest_seq() {
            w = w.min(q.saturating_sub(1));
        }
        for sub in c.subs.values() {
            if let (false, Some(since)) = (sub.state == SubState::Live, sub.since) {
                w = w.min(since);
            }
        }
        w
    }

    pub fn pending(&self, c: &Conn<C>) -> bool {
        !c.control.is_empty()
            || !c.out.is_empty()
            || (!c.acks.is_empty() && c.acks.iter().any(|a| a.seq <= self.watermark(c)))
    }

    pub fn deny(c: &mut Conn<C>, topic: &str, code: &str) {
        c.control.push(json(&wisp_protocol::Notice {
            t: wisp_protocol::tag::Notice,
            kind: "denied".into(),
            data: serde_json::json!({ "topic": topic, "code": code }),
        }));
    }
}

/// A message as JSON. Wire types are plain data, so this can't fail; an empty string would only
/// make the client drop that frame and resync.
pub(crate) fn json<T: serde::Serialize>(m: &T) -> String {
    serde_json::to_string(m).unwrap_or_default()
}
