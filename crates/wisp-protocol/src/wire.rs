//! The sync messages (plan §4.3), carried as SSE events on `GET /api/events` and by `POST /api/cmd`.
//!
//! Compatibility (plan §7.3.2): adding a field, message, command or topic is fine; removing or
//! changing one needs `PROTO + 1`. Each message is a struct tagged by `t`, so a TypeScript client can
//! name one (`Welcome`) and narrow a union on `m.t`.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::{PatchOp, Topic, tag};

/// One entity change inside a patch frame. `e` is the entity kind (`session`, `turn`, `event`, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EntityOp {
    pub topic: Topic,
    pub e: String,
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub change: Change,
}

/// What happened to the entity: replaced whole, patched (RFC 6902), deleted, or appended to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Upsert {
        #[ts(type = "unknown")]
        v: Value,
    },
    Patch {
        ops: Vec<PatchOp>,
    },
    Del,
    Append {
        #[ts(type = "unknown[]")]
        v: Vec<Value>,
    },
}

/// A row as a snapshot, a delta or a window carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Row {
    pub e: String,
    pub id: String,
    #[ts(type = "unknown")]
    pub v: Value,
}

/// One plugin a peer runs: features come from the peer, not from its version number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PeerPlugin {
    pub id: String,
    pub version: String,
    pub commands: Vec<String>,
    pub topics: Vec<String>,
    pub blocks: Vec<String>,
}

/// Who answers on the other end of a stream, and the protocol window it speaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PeerInfo {
    pub peer: String,
    pub name: String,
    pub build: String,
    pub version: String,
    pub proto_min: u32,
    pub proto_max: u32,
    pub plugins: Vec<PeerPlugin>,
}

// ---------- client → server ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Hello {
    #[ts(type = "'hello'")]
    pub t: tag::Hello,
    pub proto_min: u32,
    pub proto_max: u32,
    pub client_id: String,
    pub build: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Sub {
    #[ts(type = "'sub'")]
    pub t: tag::Sub,
    pub topic: Topic,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub since: Option<u64>,
    /// a passive subscription never counts as use of a box (plan §7.2.3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub passive: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Unsub {
    #[ts(type = "'unsub'")]
    pub t: tag::Unsub,
    pub topic: Topic,
}

/// Page a transcript backwards: rows with seq < `before_seq`, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Window {
    #[ts(type = "'window'")]
    pub t: tag::Window,
    pub req: String,
    pub topic: Topic,
    pub before_seq: u64,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Mutate {
    #[ts(type = "'mutate'")]
    pub t: tag::Mutate,
    /// uuidv7, the idempotency key
    pub mid: String,
    /// `session.followUp`
    pub cmd: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum ClientMessage {
    Hello(Hello),
    Sub(Sub),
    Unsub(Unsub),
    Window(Window),
    Mutate(Mutate),
}

// ---------- server → client ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Welcome {
    #[ts(type = "'welcome'")]
    pub t: tag::Welcome,
    pub epoch: String,
    pub head_seq: u64,
    pub oldest_seq: u64,
    /// false: the client must drop its caches for this peer and take snapshots
    pub resume: bool,
    pub proto: u32,
    pub peer: PeerInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Snapshot {
    #[ts(type = "'snapshot'")]
    pub t: tag::Snapshot,
    pub topic: Topic,
    pub seq: u64,
    pub rows: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub more: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Patch {
    #[ts(type = "'patch'")]
    pub t: tag::Patch,
    pub seq: u64,
    pub ops: Vec<EntityOp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Rows {
    #[ts(type = "'rows'")]
    pub t: tag::Rows,
    pub req: String,
    pub rows: Vec<Row>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Ack {
    #[ts(type = "'ack'")]
    pub t: tag::Ack,
    pub mid: String,
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Reject {
    #[ts(type = "'reject'")]
    pub t: tag::Reject,
    pub mid: String,
    pub code: String,
    pub message: String,
}

/// Outbox overflow: re-subscribe the topic from the cursor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Resync {
    #[ts(type = "'resync'")]
    pub t: tag::Resync,
    pub topic: Topic,
}

/// Ephemeral: toasts, finished, reminders, denied topics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Notice {
    #[ts(type = "'notice'")]
    pub t: tag::Notice,
    /// `toast` · `finished` · `reminder` · `denied` · plugin-defined
    pub kind: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum ServerMessage {
    Welcome(Welcome),
    Snapshot(Snapshot),
    Patch(Patch),
    Rows(Rows),
    Ack(Ack),
    Reject(Reject),
    Resync(Resync),
    Notice(Notice),
}

// ---------- commands over HTTP ----------

/// The HTTP fallback of a command: `POST /api/cmd {cmd, args}` with an `Idempotency-Key`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct CommandRequest {
    pub cmd: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub args: Value,
}

/// The error half of a command response: the kernel's `WireError` on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum CommandResponse {
    Ok {
        #[ts(type = "true")]
        ok: bool,
        seq: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "unknown")]
        result: Option<Value>,
    },
    Err {
        #[ts(type = "false")]
        ok: bool,
        error: CommandError,
    },
}

impl CommandResponse {
    pub fn ok(seq: u64, result: Option<Value>) -> Self {
        Self::Ok { ok: true, seq, result }
    }

    pub fn err(error: CommandError) -> Self {
        Self::Err { ok: false, error }
    }
}

// ---------- unions decoded by their tag ----------

/// The `t` (or `ok`) of a tagged object, and the object.
fn tagged<'de, D: Deserializer<'de>>(d: D, tag: &str) -> Result<(Value, Value), D::Error> {
    let v = Value::deserialize(d)?;
    let t = v.get(tag).cloned().ok_or_else(|| D::Error::custom(format!("no `{tag}`")))?;
    Ok((t, v))
}

fn as_<'de, T: serde::de::DeserializeOwned, D: Deserializer<'de>>(v: Value) -> Result<T, D::Error> {
    serde_json::from_value(v).map_err(D::Error::custom)
}

impl<'de> Deserialize<'de> for ClientMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (t, v) = tagged(d, "t")?;
        Ok(match t.as_str() {
            Some("hello") => Self::Hello(as_::<_, D>(v)?),
            Some("sub") => Self::Sub(as_::<_, D>(v)?),
            Some("unsub") => Self::Unsub(as_::<_, D>(v)?),
            Some("window") => Self::Window(as_::<_, D>(v)?),
            Some("mutate") => Self::Mutate(as_::<_, D>(v)?),
            _ => return Err(D::Error::custom(format!("unknown client message {t}"))),
        })
    }
}

impl<'de> Deserialize<'de> for ServerMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let (t, v) = tagged(d, "t")?;
        Ok(match t.as_str() {
            Some("welcome") => Self::Welcome(as_::<_, D>(v)?),
            Some("snapshot") => Self::Snapshot(as_::<_, D>(v)?),
            Some("patch") => Self::Patch(as_::<_, D>(v)?),
            Some("rows") => Self::Rows(as_::<_, D>(v)?),
            Some("ack") => Self::Ack(as_::<_, D>(v)?),
            Some("reject") => Self::Reject(as_::<_, D>(v)?),
            Some("resync") => Self::Resync(as_::<_, D>(v)?),
            Some("notice") => Self::Notice(as_::<_, D>(v)?),
            _ => return Err(D::Error::custom(format!("unknown server message {t}"))),
        })
    }
}

impl<'de> Deserialize<'de> for CommandResponse {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct OkBody {
            seq: u64,
            #[serde(default)]
            result: Option<Value>,
        }
        #[derive(Deserialize)]
        struct ErrBody {
            error: CommandError,
        }
        let (ok, v) = tagged(d, "ok")?;
        match ok.as_bool() {
            Some(true) => as_::<OkBody, D>(v).map(|b| Self::ok(b.seq, b.result)),
            Some(false) => as_::<ErrBody, D>(v).map(|b| Self::err(b.error)),
            None => Err(D::Error::custom("`ok` is not a boolean")),
        }
    }
}
