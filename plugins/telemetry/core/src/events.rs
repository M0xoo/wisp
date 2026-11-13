//! What an event is on the wire (`PostHog`'s batch format, v1 unchanged): `{event, timestamp, properties}`,
//! with what every event carries (`$lib`, `$process_person_profile`, version, os, …) under the caller's
//! props and the install's `distinct_id` last. Names are `PostHog`'s dashboards: they never change.

use serde_json::{Map, Value, json};

use crate::scrub::{ScrubOptions, frames, scrub};
use crate::text::iso;

/// Fixed values about an event. A field that's absent is left out (v1 dropped `undefined`).
pub type Props = Map<String, Value>;

/// What every event carries (v1 `Telemetry.common`). `node` is the launcher's Node version, when wisp was
/// started through it (the Rust binary has none of its own).
#[derive(Debug, Clone, Default)]
pub struct Common {
    pub version: String,
    pub os: String,
    pub os_release: Option<String>,
    pub arch: String,
    pub node: Option<String>,
    pub shell: String,
}

impl Common {
    pub fn props(&self) -> Props {
        let mut p = Props::new();
        p.insert("$lib".into(), json!("wisp"));
        p.insert("$process_person_profile".into(), json!(false)); // anonymous events: no person profiles
        p.insert("version".into(), json!(self.version));
        p.insert("os".into(), json!(self.os));
        set_opt(&mut p, "osRelease", self.os_release.as_deref());
        p.insert("arch".into(), json!(self.arch));
        set_opt(&mut p, "node", self.node.as_deref());
        p.insert("shell".into(), json!(self.shell));
        p
    }
}

/// Sets `k` unless `v` is None (v1's `undefined`).
pub fn set_opt<V: Into<Value>>(p: &mut Props, k: &str, v: Option<V>) {
    if let Some(v) = v {
        p.insert(k.to_owned(), v.into());
    }
}

/// `{event, timestamp, properties: {...common, ...props, distinct_id}}`. A `null` prop stays (v1 kept it).
pub fn event(name: &str, now_ms: i64, common: &Props, props: Props, distinct_id: &str) -> Value {
    let mut p = common.clone();
    p.extend(props);
    p.insert("distinct_id".into(), json!(distinct_id));
    json!({ "event": name, "timestamp": iso(now_ms), "properties": p })
}

/// An error as plain data: a panic or an `Err` crosses a service boundary as its parts.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ErrorInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// `PostHog`'s error tracking format (`$exception`): the props as given, plus `$exception_list`. `type`
/// and `handled` in `props` say the exception's type (else the error's name, else `Error`) and whether it
/// was handled (else true).
pub fn exception_props(err: &ErrorInfo, mut props: Props, o: &ScrubOptions) -> Props {
    let ty = props.get("type").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned);
    let ty = ty.or_else(|| err.name.clone().filter(|n| !n.is_empty())).unwrap_or_else(|| "Error".into());
    let handled = props.get("handled").and_then(Value::as_bool).unwrap_or(true);
    let list = json!([{
        "type": ty,
        "value": scrub(&err.message, o),
        "mechanism": { "handled": handled, "synthetic": false },
        "stacktrace": { "type": "raw", "frames": frames(err.stack.as_deref().unwrap_or(""), o) },
    }]);
    props.insert("$exception_list".into(), list);
    props
}

/// A prop a page event may carry, and its allowed values.
pub type AllowedProp = (&'static str, &'static [&'static str]);

/// Events the page may send (POST /api/telemetry/event), each with the only props it may carry and their
/// allowed values. Anything else is dropped: the page can't send free text.
pub const PAGE_EVENTS: &[(&str, &[AllowedProp])] =
    &[("getapp_opened", &[("from", &["button", "search"])]), ("getapp_clicked", &[]), ("getapp_hidden", &[])];

/// The allowed part of a page event, or None when the page may not send it.
pub fn page_event(event: &Value, props: &Value) -> Option<Props> {
    let name = event.as_str()?;
    let (_, allowed) = PAGE_EVENTS.iter().find(|(n, _)| *n == name)?;
    let mut out = Props::new();
    for (k, values) in *allowed {
        if let Some(v) = props.get(*k).and_then(Value::as_str).filter(|v| values.contains(v)) {
            out.insert((*k).to_owned(), json!(v));
        }
    }
    Some(out)
}
