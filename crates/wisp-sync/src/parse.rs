//! Untrusted input from the wire, checked into typed messages. Anything malformed is an error the
//! server drops: the sync stream never fails on what a client sends.

use serde_json::Value;
use wisp_protocol::{ClientMessage, PROTO, PROTO_MIN, Topic};

use crate::{ConnectQuery, SyncError};

/// The longest id, mid, cmd or req a client may send.
const MAX_STR: usize = 256;
/// A window asks for at most this many rows.
const MAX_WINDOW: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Passive {
    All,
    Some(Vec<Topic>),
}

impl Passive {
    pub fn has(&self, t: &Topic) -> bool {
        match self {
            Self::All => true,
            Self::Some(list) => list.contains(t),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHello {
    pub proto_min: u32,
    pub proto_max: u32,
    pub client_id: String,
    pub build: String,
    pub epoch: Option<String>,
    pub cursor: Option<u64>,
    pub topics: Vec<Topic>,
    pub fresh: Vec<Topic>,
    pub invalid: Vec<String>,
    pub passive: Passive,
}

/// Up to 15 digits, as the TS twin reads them (a seq stays far below 2^53).
fn int(s: Option<&String>) -> Option<u64> {
    let s = s?;
    (!s.is_empty() && s.len() <= 15 && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn topic_list(s: Option<&String>, invalid: &mut Vec<String>) -> Vec<Topic> {
    let mut out: Vec<Topic> = Vec::new();
    for t in s
        .map_or("", String::as_str)
        .split(',')
        .filter(|t| !t.is_empty())
    {
        match Topic::parse(t) {
            Some(topic) if !out.contains(&topic) => out.push(topic),
            Some(_) => {}
            None => invalid.push(t.chars().take(MAX_STR).collect()),
        }
    }
    out
}

/// A client that sends no proto window is taken to speak exactly this build's.
pub fn parse_hello(q: &ConnectQuery, fallback_client_id: &str) -> ParsedHello {
    let mut invalid = Vec::new();
    let topics = topic_list(q.topics.as_ref(), &mut invalid);
    let fresh = topic_list(q.fresh.as_ref(), &mut invalid)
        .into_iter()
        .filter(|t| !topics.contains(t))
        .collect();
    let passive = match q.passive.as_deref() {
        Some("1" | "true") => Passive::All,
        _ => Passive::Some(topic_list(q.passive.as_ref(), &mut Vec::new())),
    };
    let clamp = |n: Option<u64>, def: u32| n.map_or(def, |n| u32::try_from(n).unwrap_or(u32::MAX));
    ParsedHello {
        proto_min: clamp(int(q.proto_min.as_ref()), PROTO_MIN),
        proto_max: clamp(int(q.proto_max.as_ref()), PROTO),
        client_id: match q.client_id.as_deref() {
            Some(id) if !id.is_empty() => id.chars().take(128).collect(),
            _ => fallback_client_id.to_owned(),
        },
        build: q.build.clone().unwrap_or_default(),
        epoch: q.epoch.clone().filter(|e| !e.is_empty()),
        cursor: int(q.cursor.as_ref()).or_else(|| int(q.last_event_id.as_ref())),
        topics,
        fresh,
        invalid,
        passive,
    }
}

fn short(s: &str, what: &'static str) -> Result<(), SyncError> {
    if s.is_empty() || s.chars().count() > MAX_STR {
        Err(SyncError::BadMessage(what))
    } else {
        Ok(())
    }
}

/// A message posted to a stream. Strings are bounded, a window is capped at 1000 rows, and only
/// `passive: true` counts as passive.
pub fn parse_client_message(raw: Value) -> Result<ClientMessage, SyncError> {
    let mut m: ClientMessage =
        serde_json::from_value(raw).map_err(|e| SyncError::Decode(e.to_string()))?;
    match &mut m {
        ClientMessage::Sub(s) => s.passive = s.passive.filter(|p| *p),
        ClientMessage::Unsub(_) => {}
        ClientMessage::Window(w) => {
            short(&w.req, "window.req")?;
            w.limit = w.limit.min(MAX_WINDOW);
        }
        ClientMessage::Mutate(x) => {
            short(&x.mid, "mutate.mid")?;
            short(&x.cmd, "mutate.cmd")?;
        }
        ClientMessage::Hello(h) => short(&h.client_id, "hello.client_id")?,
    }
    Ok(m)
}
