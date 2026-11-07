//! The wire: one JSON object per line on stdin (requests) and stdout (events). See PROTOCOL.md;
//! the TS mirror is packages/native/src/protocol.ts. Unknown fields are ignored so a newer server
//! can talk to an older helper.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Bumped only for a change an older peer would misread; additions don't bump it.
pub const PROTOCOL: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Spawn(Spawn),
    /// Bytes for the child's stdin (or the terminal), base64.
    Data { id: String, data: String },
    /// Close the child's stdin.
    Eof { id: String },
    Resize { id: String, cols: u16, rows: u16 },
    /// Send a signal and return at once.
    Signal {
        id: String,
        signal: String,
        #[serde(default)]
        tree: bool,
    },
    /// Signal, wait up to `grace_ms` for the tree to go, then SIGKILL what is left; answers `killed`.
    Kill {
        id: String,
        #[serde(default = "yes")]
        tree: bool,
        signal: Option<String>,
        grace_ms: Option<u64>,
        #[serde(rename = "ref")]
        reference: Option<String>,
    },
    List {
        #[serde(rename = "ref")]
        reference: Option<String>,
    },
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawn {
    pub id: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// The complete environment; absent means "inherit the helper's".
    pub env: Option<BTreeMap<String, String>>,
    pub pty: Option<Size>,
    /// Windows only: pass `args` as written (already quoted for cmd.exe).
    #[serde(default)]
    #[cfg_attr(not(windows), allow(dead_code, reason = "read on Windows only"))]
    pub verbatim: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub pid: u32,
    pub pty: bool,
    pub exited: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    Hello { protocol: u32, version: &'static str, pid: u32, platform: &'static str, arch: &'static str },
    Started { id: String, pid: u32 },
    Data { id: String, stream: Stream, data: String },
    /// The last event for an id. `code` is null when a signal ended it.
    Exit { id: String, code: Option<i32>, signal: Option<String> },
    Killed {
        id: String,
        #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
        /// Processes the tree held when the kill began.
        signalled: usize,
        /// Processes still running after SIGKILL (0 is the promise).
        survivors: usize,
    },
    List {
        #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
        items: Vec<Item>,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
        code: &'static str,
        message: String,
        retry: bool,
    },
}

impl Event {
    pub fn hello() -> Event {
        Event::Hello {
            protocol: PROTOCOL,
            version: env!("CARGO_PKG_VERSION"),
            pid: std::process::id(),
            platform: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }

    pub fn error(id: Option<String>, reference: Option<String>, e: &crate::error::Error) -> Event {
        Event::Error { id, reference, code: e.code(), message: e.to_string(), retry: e.retry() }
    }
}

impl Request {
    /// For tracing spans.
    pub fn op(&self) -> &'static str {
        match self {
            Request::Spawn(_) => "spawn",
            Request::Data { .. } => "data",
            Request::Eof { .. } => "eof",
            Request::Resize { .. } => "resize",
            Request::Signal { .. } => "signal",
            Request::Kill { .. } => "kill",
            Request::List { .. } => "list",
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Request::Spawn(s) => Some(&s.id),
            Request::Data { id, .. }
            | Request::Eof { id }
            | Request::Resize { id, .. }
            | Request::Signal { id, .. }
            | Request::Kill { id, .. } => Some(id),
            Request::List { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_with_defaults_and_unknown_fields() {
        let r: Request = serde_json::from_str(r#"{"type":"spawn","id":"a","cmd":"sh","future":1}"#).unwrap();
        let Request::Spawn(s) = r else { panic!("not a spawn") };
        assert!(s.args.is_empty() && s.pty.is_none() && s.env.is_none() && !s.verbatim);
        let r: Request = serde_json::from_str(r#"{"type":"kill","id":"a","graceMs":5,"ref":"r1"}"#).unwrap();
        let Request::Kill { tree, grace_ms, reference, .. } = r else { panic!("not a kill") };
        assert!(tree);
        assert_eq!(grace_ms, Some(5));
        assert_eq!(reference.as_deref(), Some("r1"));
        assert!(serde_json::from_str::<Request>(r#"{"type":"nope"}"#).is_err());
    }

    #[test]
    fn events_serialize_as_documented() {
        let e = Event::Exit { id: "a".into(), code: None, signal: Some("SIGTERM".into()) };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"exit","id":"a","code":null,"signal":"SIGTERM"}"#);
        let e = Event::Data { id: "a".into(), stream: Stream::Stdout, data: "aGk=".into() };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"data","id":"a","stream":"stdout","data":"aGk="}"#);
        let e = Event::Killed { id: "a".into(), reference: None, signalled: 3, survivors: 0 };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"killed","id":"a","signalled":3,"survivors":0}"#);
    }
}
