//! Inputs and outputs of the sans-IO sync server (plan §3.1 rule 3). The machine never reads a clock
//! or a socket: the host feeds it `handle(input, now_ms)` and carries out what it returns.

use std::fmt;

use serde_json::Value;
use wisp_protocol::{Change, Notice, PeerInfo, Row, Topic};


/// One connection (one `GET /api/events` stream), numbered by the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnId(pub u64);

impl fmt::Display for ConnId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "conn{}", self.0)
    }
}

/// One row of the store's `change` feed, as its commit hook reports it (plan §4.1).
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeRow {
    pub seq: u64,
    pub topic: Topic,
    pub entity: String,
    pub id: String,
    pub change: Change,
    pub at: u64,
}

/// What `GET /api/events` carried: the hello flattened into query parameters. Values are raw: the
/// server checks them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectQuery {
    pub proto_min: Option<String>,
    pub proto_max: Option<String>,
    pub client_id: Option<String>,
    pub build: Option<String>,
    pub epoch: Option<String>,
    /// the client's cursor; `Last-Event-ID` is used when this is missing
    pub cursor: Option<String>,
    pub last_event_id: Option<String>,
    /// comma-separated topics the client holds as of `cursor`: resumed from it
    pub topics: Option<String>,
    /// comma-separated topics the client has no rows for yet: always a full snapshot
    pub fresh: Option<String>,
    /// `1`: every topic of this hello is passive (plan §7.2.3); else a comma-separated list of them
    pub passive: Option<String>,
}

/// A row a delta no longer has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gone {
    pub e: String,
    pub id: String,
}

/// The host's answer to an `Output::SnapshotRequest`.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotAnswer {
    pub conn: ConnId,
    pub topic: Topic,
    /// the request's `req`: an answer to a request since replaced is ignored
    pub req: u64,
    /// the head seq the rows were read at
    pub seq: u64,
    pub rows: Vec<Row>,
    /// true: `rows` is the whole topic. false: only rows changed since the request's `since`, with
    /// `deleted` for those gone. A since-request may be answered full (the host's call, e.g. when
    /// the delta would be larger), a full one never as a delta; it must be full once retention has
    /// dropped changes after `since`.
    pub full: bool,
    pub deleted: Vec<Gone>,
    /// more pages of the same snapshot follow, at the same seq
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandOutcome {
    Ok { seq: u64, result: Option<Value> },
    Err { code: String, message: String },
}

#[derive(Debug)]
pub enum Input<C> {
    /// A stream opened. A v1 query (`ConnectQuery::is_v1`) gets v1's named events instead.
    Connect {
        conn: ConnId,
        caller: C,
        query: ConnectQuery,
    },
    /// A message the client posted to its stream (sub, unsub, window, mutate), as parsed JSON.
    Message {
        conn: ConnId,
        message: Value,
    },
    /// Rows the store committed, in one transaction or several.
    Committed {
        rows: Vec<ChangeRow>,
    },
    SnapshotRows(SnapshotAnswer),
    WindowRows {
        conn: ConnId,
        req: String,
        rows: Vec<Row>,
        done: bool,
    },
    CommandResult {
        conn: ConnId,
        mid: String,
        outcome: CommandOutcome,
    },
    /// An ephemeral notice, for every stream or only those holding `topic`.
    Notice {
        notice: Notice,
        topic: Option<Topic>,
    },
    /// Retention moved: cursors at or above this seq can still resume.
    Retained {
        oldest_seq: u64,
    },
    Tick,
    /// What the socket still holds after a write: the backpressure signal.
    Drained {
        conn: ConnId,
        buffered_bytes: usize,
    },
    Close {
        conn: ConnId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// the same client opened a new stream
    Replaced,
    /// the client's protocol window doesn't meet ours: it got the welcome, then the close
    Incompatible,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Output<C> {
    /// Write `frame` to the connection as is: one SSE event, or a heartbeat comment (`id` None).
    Send {
        conn: ConnId,
        frame: String,
        id: Option<u64>,
    },
    /// Read `topic` and answer with `Input::SnapshotRows`: `since` None is a full snapshot, else a delta.
    SnapshotRequest {
        conn: ConnId,
        topic: Topic,
        since: Option<u64>,
        req: u64,
    },
    /// Read events with seq < `before_seq`, newest first, at most `limit`; answer with `Input::WindowRows`.
    WindowRequest {
        conn: ConnId,
        req: String,
        topic: Topic,
        before_seq: u64,
        limit: u32,
    },
    /// Run it (idempotent by `mid`) and answer with `Input::CommandResult`.
    Command {
        conn: ConnId,
        caller: C,
        mid: String,
        cmd: String,
        args: Value,
        base_seq: Option<u64>,
    },
    /// The connection started or stopped counting as use of this box (any non-passive sub).
    Activity {
        conn: ConnId,
        active: bool,
    },
    Close {
        conn: ConnId,
        reason: CloseReason,
    },
}

/// Who may read which topic (plan §6.5): the caller's capability set decides.
pub type CanRead<C> = Box<dyn Fn(&C, &Topic) -> bool + Send + Sync>;

pub struct SyncOptions<C> {
    pub epoch: String,
    pub peer: PeerInfo,
    pub head_seq: u64,
    /// the lowest cursor that can still resume: every change with seq > `oldest_seq` is kept
    pub oldest_seq: u64,
    pub can_read: CanRead<C>,
    /// a connection's outbox flushes this often at most (plan §4.4)
    pub flush_ms: u64,
    /// past this many bytes buffered on a socket, its busy topics are dropped and resynced
    pub high_water_bytes: usize,
    /// a quiet stream gets a comment this often, so proxies and the tunnel keep it open
    pub heartbeat_ms: u64,
    /// a loading topic buffers live changes up to this; past it the snapshot is asked again
    pub load_buffer_bytes: usize,
}

impl<C> SyncOptions<C> {
    /// The plan's numbers: flush 50 ms, high water 1 MB, heartbeat 15 s, load buffer 4 MB, v1 ping 25 s.
    pub fn new(
        epoch: impl Into<String>,
        peer: PeerInfo,
        head_seq: u64,
        oldest_seq: u64,
        can_read: CanRead<C>,
    ) -> Self {
        Self {
            epoch: epoch.into(),
            peer,
            head_seq,
            oldest_seq,
            can_read,
            flush_ms: 50,
            high_water_bytes: 1 << 20,
            heartbeat_ms: 15_000,
            load_buffer_bytes: 4 << 20,
        }
    }
}

impl<C> fmt::Debug for SyncOptions<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SyncOptions")
            .field("epoch", &self.epoch)
            .field("head_seq", &self.head_seq)
            .field("oldest_seq", &self.oldest_seq)
            .field("flush_ms", &self.flush_ms)
            .finish_non_exhaustive()
    }
}

/// Frames and bytes sent: gate G3 and the status pane read these.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub frames: u64,
    pub bytes: u64,
    pub heartbeats: u64,
    pub resyncs: u64,
}
