//! Event-body upcasters (plan §4.2): every row of the event log carries the version `v` of its body's
//! shape, and old shapes are read through these, so history is never rewritten.
//!
//! - v0: a v1 activity item, as v1 kept it in the session file (`{t, kind, label, file, detail, call,
//!   output, by}`, `kind` a tool kind, `text`, `error`, or one of wisp's own notes: `check`, `answer`, …).
//! - v1: `wisp_runtime_api::model::Activity`, serde's shape (`kind` the variant).

use serde_json::Value;
use wisp_runtime_api::model::{Activity, Tone, ToolKind};

/// The shape new rows are written in.
pub const EVENT_V: u32 = 1;

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn tool_kind(k: &str) -> Option<ToolKind> {
    serde_json::from_value(Value::String(k.to_owned())).ok()
}

/// A v1 activity item as a step. None: nothing a transcript shows.
pub fn from_v0(item: &Value) -> Option<Activity> {
    let kind = item.get("kind").and_then(Value::as_str)?;
    let label = s(item, "label").unwrap_or_default();
    Some(match kind {
        "text" => Activity::Text { text: label },
        "error" => {
            // v1 wrote `<name> failed: <text>`
            let (name, text) = label
                .split_once(" failed: ")
                .map_or(("Tool".to_owned(), label.clone()), |(n, t)| {
                    (n.to_owned(), t.to_owned())
                });
            Activity::ToolError { name, text }
        }
        k => match tool_kind(k) {
            Some(tool) => Activity::Tool {
                tool,
                label,
                file: s(item, "file"),
                detail: s(item, "detail"),
                call_id: s(item, "call"),
                output: s(item, "output"),
            },
            // wisp's own lines (Auto's check, a repair, a hand-over, a side's refusal)
            None => Activity::Notice {
                text: label,
                tone: (k == "warn").then_some(Tone::Warn),
            },
        },
    })
}

/// A stored body of version `v` as a step.
pub fn read(v: u32, body: &Value) -> Option<Activity> {
    match v {
        0 => from_v0(body),
        _ => serde_json::from_value(body.clone()).ok(),
    }
}

/// A step as v1 clients read it (the v1 HTTP routes, the dual-written file): v1's item shape; the caller
/// adds `t`.
pub fn to_v0(a: &Activity) -> Value {
    let mut o = serde_json::Map::new();
    let mut put = |k: &str, v: Option<&str>| {
        if let Some(v) = v {
            o.insert(k.to_owned(), Value::String(v.to_owned()));
        }
    };
    match a {
        Activity::Text { text } => {
            put("kind", Some("text"));
            put("label", Some(text));
        }
        Activity::Thinking { text } => {
            put("kind", Some("thinking"));
            put("label", text.as_deref());
        }
        Activity::Tool {
            tool,
            label,
            file,
            detail,
            call_id,
            output,
        } => {
            let k = serde_json::to_value(tool)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            put("kind", Some(&k));
            put("label", Some(label));
            put("file", file.as_deref());
            put("detail", detail.as_deref());
            put("call", call_id.as_deref());
            put("output", output.as_deref());
        }
        Activity::ToolOutput { call_id, text } => {
            put("kind", Some("output"));
            put("call", Some(call_id));
            put("output", Some(text));
        }
        Activity::ToolError { name, text } => {
            put("kind", Some("error"));
            put("label", Some(&format!("{name} failed: {text}")));
        }
        Activity::Blocked { tool, detail, .. } => {
            put("kind", Some("blocked"));
            put("label", Some(&format!("{tool}: {detail}")));
        }
        Activity::Notice { text, .. } => {
            put("kind", Some("check"));
            put("label", Some(text));
            put("by", Some("wisp"));
        }
    }
    Value::Object(o)
}
