//! JSON-RPC 2.0 as wisp's MCP server speaks it: v1's leniency (no `jsonrpc` check, an unparsable or
//! id-less message gets no answer, `id: null` is an id), plus batches, which v1 dropped and the spec
//! answers. Answers are written as text in v1's key order (`jsonrpc`, `id`, then `result` or `error`),
//! and the id is echoed byte for byte.

use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// v1's protocol version when the client names none.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// One request (with an id) or notification (without) off the wire.
#[derive(Debug, Clone)]
pub struct Message {
    /// `None`: a notification. `Some("null")` is an id like any other: v1 answered it.
    pub id: Option<Box<RawValue>>,
    pub method: Option<Value>,
    pub params: Option<Value>,
}

#[derive(Deserialize)]
struct Wire {
    #[serde(default, deserialize_with = "present")]
    id: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "present_value")]
    method: Option<Value>,
    #[serde(default)]
    params: Option<Value>,
}

// A field that is there, even as null: absent and null are different ids.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(d).map(Some)
}

fn present_value<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// What a line or a request body holds.
#[derive(Debug)]
pub enum Incoming {
    One(Message),
    /// each element, or `None` for one that isn't a message (answered `Invalid Request`, id null)
    Batch(Vec<Option<Message>>),
    /// not JSON, or not an object or array: v1 dropped it without a word
    Nothing,
}

/// Parses one line (stdio) or body (HTTP).
pub fn parse(text: &str) -> Incoming {
    let trimmed = text.trim_start();
    if trimmed.starts_with('[') {
        return match serde_json::from_str::<Vec<Box<RawValue>>>(text) {
            Ok(items) => Incoming::Batch(items.iter().map(|raw| message(raw.get())).collect()),
            Err(_) => Incoming::Nothing,
        };
    }
    message(text).map_or(Incoming::Nothing, Incoming::One)
}

fn message(text: &str) -> Option<Message> {
    let w: Wire = serde_json::from_str(text).ok()?;
    Some(Message { id: w.id, method: w.method, params: w.params })
}

impl Message {
    pub fn method(&self) -> Option<&str> {
        self.method.as_ref().and_then(Value::as_str)
    }

    /// The method as v1 printed it in "Method not found: …" (JavaScript's `String(method)`).
    pub fn method_text(&self) -> String {
        match &self.method {
            None => "undefined".into(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Object(_)) => "[object Object]".into(),
            Some(Value::Array(a)) => {
                a.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect::<Vec<_>>().join(",")
            }
            Some(v) => v.to_string(),
        }
    }

    fn param(&self, key: &str) -> Option<&Value> {
        self.params.as_ref().and_then(|p| p.get(key))
    }

    /// `params.name` of a `tools/call`.
    pub fn tool(&self) -> Option<&str> {
        self.param("name").and_then(Value::as_str)
    }

    /// `params.arguments` when it is an object, else `{}` (v1 read fields off whatever came, finding none).
    pub fn take_arguments(&mut self) -> Map<String, Value> {
        match self.params.as_mut().and_then(|p| p.get_mut("arguments")).map(Value::take) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    /// `params.protocolVersion || '2025-06-18'`, as JSON text.
    pub fn protocol_version(&self) -> String {
        match self.param("protocolVersion") {
            Some(v) if truthy(v) => v.to_string(),
            _ => format!("\"{PROTOCOL_VERSION}\""),
        }
    }
}

/// JavaScript truthiness, for v1's `a || b` defaults.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{"jsonrpc":"2.0","id":…,"result":…}`; `result` is JSON text.
pub fn result(id: &RawValue, result: &str) -> String {
    let mut s = String::with_capacity(32 + id.get().len() + result.len());
    s.push_str("{\"jsonrpc\":\"2.0\",\"id\":");
    s.push_str(id.get());
    s.push_str(",\"result\":");
    s.push_str(result);
    s.push('}');
    s
}

/// `{"jsonrpc":"2.0","id":…,"error":{"code":…,"message":…}}`.
pub fn error(id: &RawValue, code: i64, message: &str) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":{code},\"message\":{}}}}}", id.get(), quote(message))
}

/// The answer to a batch element that isn't a message, or to an empty batch.
pub fn invalid_request() -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":{INVALID_REQUEST},\"message\":\"Invalid Request\"}}}}")
}

/// A batch's answer: every reply in one array, or nothing when all were notifications.
pub fn batch(replies: &[String]) -> Option<String> {
    if replies.is_empty() {
        return None;
    }
    let mut s = String::with_capacity(replies.iter().map(|r| r.len() + 1).sum::<usize>() + 1);
    s.push('[');
    for (i, r) in replies.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(r);
    }
    s.push(']');
    Some(s)
}

/// A tool's result: `{"content":[{"type":"text","text":…}]}`, with `"isError":true` first when it failed.
pub fn tool_text(text: &str, is_error: bool) -> String {
    let head =
        if is_error { "{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":" } else { "{\"content\":[{\"type\":\"text\",\"text\":" };
    let mut s = String::with_capacity(head.len() + text.len() + 8);
    s.push_str(head);
    s.push_str(&quote(text));
    s.push_str("}]}");
    s
}

/// A JSON string literal, escaped as `JSON.stringify` does (non-ASCII left as is).
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}
