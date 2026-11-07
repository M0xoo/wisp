//! The proxy's wire rules (v1 mcp-connector.js), sans-IO: lines in, lines out, an SSE decoder, and
//! what a failed request answers so the harness never waits on it until its timeout.

use serde_json::{Value, json};

/// Bytes → complete lines (`\r\n` or `\n`), empty ones skipped. Holds a partial line between pushes.
#[derive(Debug, Default)]
pub struct Lines {
    buf: Vec<u8>,
}

impl Lines {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            let text = String::from_utf8_lossy(&line[..i]);
            let text = text.trim();
            if !text.is_empty() {
                out.push(text.to_owned());
            }
        }
        out
    }
}

/// One server-sent event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// SSE: `data:` lines up to a blank line make one event (`event:` names it, `message` by default).
#[derive(Debug)]
pub struct Sse {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl Default for Sse {
    fn default() -> Self {
        Self { buf: Vec::new(), event: "message".into(), data: Vec::new() }
    }
}

impl Sse {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=i).collect();
            let end = if i > 0 && raw[i - 1] == b'\r' { i - 1 } else { i };
            let line = String::from_utf8_lossy(&raw[..end]).into_owned();
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(SseEvent { event: std::mem::replace(&mut self.event, "message".into()), data: self.data.join("\n") });
                    self.data.clear();
                }
                self.event = "message".into();
            } else if let Some(d) = line.strip_prefix("data:") {
                self.data.push(d.strip_prefix(' ').unwrap_or(d).to_owned());
            } else if let Some(e) = line.strip_prefix("event:") {
                e.trim().clone_into(&mut self.event);
            }
        }
        out
    }
}

/// The 2024 transport: a URL ending in `/sse` streams the replies and names where to POST.
pub fn is_legacy(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| {
        let p = u.path();
        p.ends_with("/sse") || p.ends_with("/sse/")
    })
}

/// initialize's reply says which protocol version later requests carry (a batch: its first answer).
pub fn protocol_version(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let one = |m: &Value| m.get("result")?.get("protocolVersion")?.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    match &v {
        Value::Array(a) => a.iter().find_map(one),
        m => one(m),
    }
}

/// A reply as the lines the harness reads: a JSON batch is split into its messages.
pub fn reply_lines(text: &str) -> Result<Vec<String>, String> {
    if !text.starts_with('[') {
        return Ok(vec![text.to_owned()]);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(a)) => Ok(a.iter().map(Value::to_string).collect()),
        Ok(other) => Ok(vec![other.to_string()]),
        Err(e) => Err(e.to_string()),
    }
}

/// A request (an id and a method) gets an answer; anything else is said on stderr.
pub fn is_request(msg: &Value) -> bool {
    msg.get("id").is_some_and(|i| !i.is_null()) && msg.get("method").is_some_and(|m| !m.is_null() && m != "")
}

/// What a failed message turns into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failed {
    /// a JSON-RPC error line for stdout
    Reply(String),
    /// a line for stderr
    Log(String),
}

/// A request that failed still needs an answer, or the harness waits for it until its timeout.
pub fn failed(msg: &Value, name: &str, text: &str) -> Failed {
    if is_request(msg) {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        Failed::Reply(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": format!("{name}: {text}") } }).to_string())
    } else {
        Failed::Log(format!("wisp: {name}: {text}"))
    }
}

/// A 401 or 403 the proxy couldn't get past.
pub fn refusal(status: u16, signed_in: bool) -> String {
    let what = if signed_in { "Sign in again" } else { "Sign in, or check its headers," };
    format!("needs sign-in (HTTP {status}). {what} in Settings → Connectors")
}

/// A remote's reply status: what the proxy does with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// refused: one fresh token, then the request again (if signed in and not retried yet)
    Refused,
    Failed,
    /// accepted with nothing to say (a notification's 202)
    Accepted,
    Body,
}

pub fn status(code: u16) -> Status {
    match code {
        401 | 403 => Status::Refused,
        202 => Status::Accepted,
        200..=299 => Status::Body,
        _ => Status::Failed,
    }
}

/// The text of an HTTP failure (v1 `HTTP ${status} ${statusText}`).
pub fn http_failure(code: u16, reason: &str) -> String {
    format!("HTTP {code} {reason}").trim().to_owned()
}

/// The `initialize` line a probe sends first.
pub fn initialize(version: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": crate::oauth::PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "wisp", "version": version } } }).to_string()
}
