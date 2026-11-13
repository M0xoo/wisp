//! SSE framing (WHATWG "server-sent events"). One wisp frame is one SSE event: `id:` is the cursor
//! the client may resume from, `event: sync`, and `data:` the frame's messages as one line of JSON
//! (`serde_json` escapes every CR and LF, so a message can never break the framing). A quiet stream
//! gets comment lines, which proxies see as traffic and `EventSource` ignores.
//!
//! The parser is the peer side (a wisp subscribing to another, and the tests): chunks may split
//! anywhere, inside a line, between CR and LF, or inside a UTF-8 sequence.

use wisp_protocol::ServerMessage;

/// The SSE `event:` of a wisp frame.
pub const EVENT: &str = "sync";

/// A comment line: proxies and the tunnel see traffic, `EventSource` ignores it.
pub const HEARTBEAT: &str = ": hb\n\n";

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// One frame from messages already encoded as JSON objects.
pub fn encode_frame<S: AsRef<str>>(id: Option<u64>, messages: &[S]) -> String {
    let len: usize = messages.iter().map(|m| m.as_ref().len() + 1).sum();
    let mut s = String::with_capacity(len + 40);
    if let Some(id) = id {
        s.push_str("id: ");
        s.push_str(&id.to_string());
        s.push('\n');
    }
    s.push_str("event: ");
    s.push_str(EVENT);
    s.push_str("\ndata: [");
    for (i, m) in messages.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(m.as_ref());
    }
    s.push_str("]\n\n");
    s
}

/// `retry:` tells a browser's `EventSource` how long to wait before it reconnects by itself.
pub fn retry_field(ms: u64) -> String {
    format!("retry: {ms}\n\n")
}

/// One dispatched SSE event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// the last `id:` seen on the stream so far (it persists across events, per the spec)
    pub id: Option<String>,
    pub event: String,
    pub data: String,
}

/// Decodes an SSE byte stream into events. LF, CR and CRLF all end a line; a leading BOM is skipped.
#[derive(Debug, Default)]
pub struct SseParser {
    /// bytes of a line not yet ended (it may end inside a UTF-8 sequence)
    line: Vec<u8>,
    pending_cr: bool,
    started: bool,
    event: String,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_event_id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    /// The last `retry:` the server sent, in ms.
    pub fn retry(&self) -> Option<u64> {
        self.retry
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        if self.started {
            return self.push_started(chunk);
        }
        // the BOM may itself be split, so it is only stripped once whole
        let mut head = std::mem::take(&mut self.line);
        head.extend_from_slice(chunk);
        if head.len() < BOM.len() && BOM.starts_with(&head) {
            self.line = head;
            return Vec::new();
        }
        self.started = true;
        let start = if head.starts_with(BOM) { BOM.len() } else { 0 };
        self.push_started(&head[start..])
    }

    fn push_started(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\n' && self.pending_cr {
                self.pending_cr = false; // the LF of a CRLF
                continue;
            }
            self.pending_cr = b == b'\r';
            if b == b'\n' || b == b'\r' {
                let line = std::mem::take(&mut self.line);
                self.on_line(&String::from_utf8_lossy(&line), &mut out);
            } else {
                self.line.push(b);
            }
        }
        out
    }

    fn on_line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                let event = if self.event.is_empty() { "message".to_owned() } else { std::mem::take(&mut self.event) };
                out.push(SseEvent { id: self.id.clone(), event, data: self.data.join("\n") });
            }
            self.data.clear();
            self.event.clear();
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "data" => self.data.push(value.to_owned()),
            "event" => value.clone_into(&mut self.event),
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                self.retry = value.parse().ok();
            }
            _ => {}
        }
    }
}

/// A decoded wisp frame: its cursor and messages. None when the event isn't a wisp frame.
/// Messages this build doesn't know are skipped (a newer peer may send more kinds).
pub fn decode_frame(ev: &SseEvent) -> Option<(Option<u64>, Vec<ServerMessage>)> {
    if ev.event != EVENT {
        return None;
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&ev.data).ok()?;
    let messages = parsed.into_iter().filter_map(|m| serde_json::from_value(m).ok()).collect();
    let id = ev.id.as_deref().and_then(|s| s.parse::<u64>().ok());
    Some((id, messages))
}
