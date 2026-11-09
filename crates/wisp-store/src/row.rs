//! Row-level helpers: the key type, topic validation (`isTopic`), and typed rows via serde.

use std::fmt;

use serde_json::Value;

use crate::entity::Row;
use crate::error::{Result, invalid};

/// A row's key: text or integer. An integer key given as text (`"42"`) is matched as 42.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Id {
    Text(String),
    Int(i64),
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(s) => f.write_str(s),
            Self::Int(n) => write!(f, "{n}"),
        }
    }
}

impl From<&str> for Id {
    fn from(s: &str) -> Self {
        Self::Text(s.to_owned())
    }
}
impl From<String> for Id {
    fn from(s: String) -> Self {
        Self::Text(s)
    }
}
impl From<&String> for Id {
    fn from(s: &String) -> Self {
        Self::Text(s.clone())
    }
}
impl From<i64> for Id {
    fn from(n: i64) -> Self {
        Self::Int(n)
    }
}

/// A value as the change row's `id` text: strings bare, everything else as JSON.
pub(crate) fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `list`, `config`, `crew`, `machines`, `stuff`, `session:<id>`, `plugin:<id>:<name>` (`isTopic`).
pub fn is_topic(t: &str) -> bool {
    if matches!(t, "list" | "config" | "crew" | "machines" | "stuff") {
        return true;
    }
    if let Some(id) = t.strip_prefix("session:") {
        return !id.is_empty() && !id.chars().any(char::is_whitespace);
    }
    if t.starts_with("events:") {
        return wisp_protocol_like_events(t);
    }
    if let Some((id, name)) = t.strip_prefix("plugin:").and_then(|r| r.split_once(':')) {
        let ok = |s: &str, extra: &[u8]| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(&c))
        };
        return ok(id, b".-") && ok(name, b"._-");
    }
    false
}

/// `events:*`, `events:<area>.*`, `events:<type>` (ADR-0044; the same grammar as wisp-protocol's).
fn wisp_protocol_like_events(t: &str) -> bool {
    let rest = &t["events:".len()..];
    if rest == "*" {
        return true;
    }
    let body = rest.strip_suffix(".*").unwrap_or(rest);
    !body.is_empty() && !body.starts_with('.') && body.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-' | b'@'))
}

/// A typed row: any `Serialize` struct whose fields are the kind's columns.
pub fn to_row<T: serde::Serialize>(value: &T) -> Result<Row> {
    match serde_json::to_value(value)? {
        Value::Object(m) => Ok(m),
        other => Err(invalid(format!("a row must be an object, got {other}"))),
    }
}

pub fn from_row<T: serde::de::DeserializeOwned>(row: Row) -> Result<T> {
    Ok(serde_json::from_value(Value::Object(row))?)
}
