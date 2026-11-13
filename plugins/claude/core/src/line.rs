//! One stream-json line, read once. Only the keys the parser looks at are kept, as raw JSON values
//! (absent and `null` stay apart: v1 copied a `null` but not a missing key); everything else is
//! skipped without being built, which is most of a line's bytes in a long run. Objects whose key
//! order v1 kept (`modelUsage`, `unifiedWindows`) are read in order.

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::msg::{Lenient, Msg};

/// `null` for a missing key: what `msg[k]` is in JavaScript for our purposes.
pub static NULL: Value = Value::Null;

/// A field that is `Some` whenever the key is there, `null` included.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// A JSON object's entries in the order they came (JavaScript's `Object.entries`); anything that
/// isn't an object reads as no entries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entries(pub Vec<(String, Value)>);

impl Entries {
    pub fn get(&self, key: &str) -> &Value {
        self.0.iter().find(|(k, _)| k == key).map_or(&NULL, |(_, v)| v)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<'de> Deserialize<'de> for Entries {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Entries;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Entries, A::Error> {
                let mut out: Vec<(String, Value)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Value>()? {
                    // A repeated key keeps its first place and its last value, as JSON.parse does.
                    match out.iter_mut().find(|(have, _)| *have == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(Entries(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Entries, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Entries::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Entries, E> {
                Ok(Entries::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Entries, E> {
                Ok(Entries::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Entries, E> {
                Ok(Entries::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Entries, E> {
                Ok(Entries::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<Entries, E> {
                Ok(Entries::default())
            }
            fn visit_unit<E>(self) -> Result<Entries, E> {
                Ok(Entries::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// The two keys of an Agent call's `tool_use_result` the tally reads; the rest (the subagent's whole
/// answer) is skipped. Anything that isn't an object reads as neither.
#[derive(Debug, Default)]
pub struct ToolUseResult {
    pub resolved_model: Value,
    pub usage: Value,
}

impl<'de> Deserialize<'de> for ToolUseResult {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ToolUseResult;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ToolUseResult, A::Error> {
                let mut out = ToolUseResult::default();
                while let Some(k) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    match &*k {
                        "resolvedModel" => out.resolved_model = map.next_value()?,
                        "usage" => out.usage = map.next_value()?,
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<ToolUseResult, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(ToolUseResult::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
            fn visit_unit<E>(self) -> Result<ToolUseResult, E> {
                Ok(ToolUseResult::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// `rate_limit_info`, with `unifiedWindows` in order.
#[derive(Debug, Default, Deserialize)]
pub struct RateLimitInfo {
    #[serde(rename = "unifiedWindows", default)]
    pub unified_windows: Entries,
    #[serde(rename = "isUsingOverage", default)]
    pub is_using_overage: Value,
    #[serde(default)]
    pub status: Value,
    #[serde(rename = "rateLimitType", default)]
    pub rate_limit_type: Value,
    #[serde(default, deserialize_with = "present")]
    pub utilization: Option<Value>,
    #[serde(rename = "resetsAt", default)]
    pub resets_at: Value,
}

macro_rules! line_fields {
    ($( $(#[$m:meta])* $name:ident : $ty:ty ),* $(,)?) => {
        /// The keys of a stream-json line the parser reads. `message` stays raw JSON, borrowed from
        /// the line: it is read part by part (crate::msg), and only a tool call's input becomes a Value.
        #[derive(Debug, Default, Deserialize)]
        pub struct Line<'a> {
            $( $(#[$m])* #[serde(default)] pub $name: $ty, )*
        }
    };
}

line_fields! {
    #[serde(rename = "type", borrow)] ty: Option<&'a RawValue>,
    #[serde(borrow)] subtype: Option<&'a RawValue>,
    #[serde(borrow)] session_id: Option<&'a RawValue>,
    #[serde(borrow)] message: Lenient<Msg<'a>>,
    #[serde(borrow)] parent_tool_use_id: Option<&'a RawValue>,
    #[serde(borrow)] error: Option<&'a RawValue>,
    tool_use_result: Option<ToolUseResult>,
    #[serde(borrow)] rate_limit_info: Option<&'a RawValue>,
    #[serde(rename = "apiKeySource", borrow)] api_key_source: Option<&'a RawValue>,
    #[serde(borrow)] tools: Option<&'a RawValue>,
    #[serde(borrow)] claude_code_version: Option<&'a RawValue>,
    /// the main thread's model (system init): its modelUsage `contextWindow` is the task's (v1 #785)
    #[serde(borrow)] model: Option<&'a RawValue>,
    #[serde(borrow)] compact_metadata: Option<&'a RawValue>,
    #[serde(borrow)] compact_result: Option<&'a RawValue>,
    #[serde(borrow)] compact_error: Option<&'a RawValue>,
    #[serde(borrow)] task_type: Option<&'a RawValue>,
    #[serde(borrow)] tool_use_id: Option<&'a RawValue>,
    #[serde(borrow)] subagent_type: Option<&'a RawValue>,
    #[serde(borrow)] tasks: Option<&'a RawValue>,
    #[serde(borrow)] is_backgrounded: Option<&'a RawValue>,
    #[serde(borrow)] task_id: Option<&'a RawValue>,
    #[serde(borrow)] description: Option<&'a RawValue>,
    #[serde(deserialize_with = "present")] result: Option<Value>,
    #[serde(borrow)] is_error: Option<&'a RawValue>,
    #[serde(deserialize_with = "present")] duration_ms: Option<Value>,
    #[serde(borrow)] duration_api_ms: Option<&'a RawValue>,
    #[serde(deserialize_with = "present")] num_turns: Option<Value>,
    #[serde(deserialize_with = "present")] total_cost_usd: Option<Value>,
    usage: Value,
    /// null is falsy in v1 (`if (msg.modelUsage)`): Option reads it as None
    #[serde(rename = "modelUsage")] model_usage: Option<Entries>,
    permission_denials: Value,
    stop_reason: Value,
    local_command: Value,
}

impl RateLimitInfo {
    /// None unless it is an object (v1: `if (!raw || typeof raw !== 'object') return null`).
    pub fn parse(raw: &RawValue) -> Option<Self> {
        serde_json::from_str(raw.get()).ok()
    }
}

impl<'a> Line<'a> {
    /// The line, or None for a blank or non-JSON line (v1 skipped both) or one that isn't an object.
    pub fn parse(text: &'a str) -> Option<Self> {
        if !wisp_harness_kit::js::has_text(text) {
            return None;
        }
        serde_json::from_str(text).ok()
    }
}

/// `x ?? null` for a present-or-missing field.
pub fn or_null(v: &Option<Value>) -> &Value {
    v.as_ref().unwrap_or(&NULL)
}
