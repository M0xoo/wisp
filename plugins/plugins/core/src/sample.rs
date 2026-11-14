//! A sample of a data source's answer (`wisp_plugin_data`): its shape kept, its bulk cut, so an agent writing a
//! plugin reads the real field names without a whole list in its context.

use serde_json::{Map, Value};

/// Items kept of a list, characters of a string, levels of nesting.
pub const ITEMS: usize = 3;
pub const CHARS: usize = 200;
pub const DEPTH: usize = 6;

/// `v` with lists cut to `ITEMS` (a last string says how many more), strings to `CHARS`, nesting past `DEPTH` to `"…"`.
pub fn sample(v: &Value) -> Value {
    cut(v, 0)
}

fn cut(v: &Value, depth: usize) -> Value {
    if depth > DEPTH && (v.is_array() || v.is_object()) {
        return Value::String("…".into());
    }
    match v {
        Value::String(s) if s.chars().count() > CHARS => Value::String(format!("{}…", s.chars().take(CHARS).collect::<String>())),
        Value::Array(a) => {
            let mut out: Vec<Value> = a.iter().take(ITEMS).map(|x| cut(x, depth + 1)).collect();
            if a.len() > ITEMS {
                out.push(Value::String(format!("… {} more", a.len() - ITEMS)));
            }
            Value::Array(out)
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), cut(x, depth + 1))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

/// What the answer is, in words: `a list of 57`, `an object (id, version, state)`, `a string`.
pub fn shape(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("a list of {}", a.len()),
        Value::Object(o) => format!("an object ({})", o.keys().map(String::as_str).collect::<Vec<_>>().join(", ")),
        Value::String(_) => "a string".into(),
        Value::Number(_) => "a number".into(),
        Value::Bool(_) => "true or false".into(),
        Value::Null => "nothing (null)".into(),
    }
}

/// The tool's answer: the command, its shape, the permission a plugin needs to call it, the sample.
pub fn text(command: &str, permission: &str, v: &Value) -> String {
    let body = serde_json::to_string_pretty(&sample(v)).unwrap_or_default();
    format!(
        "{command} answered {}. A plugin calling it with wisp.call('{command}', args) needs \"{permission}\" in its permissions.\n\n```json\n{body}\n```",
        shape(v)
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_sample_keeps_the_shape_and_cuts_the_rest() {
        let long = "x".repeat(500);
        let v = json!([{ "id": "a", "note": long, "deep": [[[[[[[[1]]]]]]]] }, { "id": "b" }, { "id": "c" }, { "id": "d" }, { "id": "e" }]);
        let s = sample(&v);
        let a = s.as_array().unwrap();
        assert_eq!(a.len(), ITEMS + 1, "three items and how many more");
        assert_eq!(a[ITEMS], json!("… 2 more"));
        assert_eq!(a[1], json!({ "id": "b" }), "an item's fields as they are");
        assert_eq!(a[0]["note"].as_str().unwrap().chars().count(), CHARS + 1);
        assert!(a[0]["deep"].to_string().contains("\"…\""), "nesting cut: {}", a[0]["deep"]);
        assert_eq!(shape(&v), "a list of 5");
        assert_eq!(shape(&json!({ "id": 1, "state": "on" })), "an object (id, state)");
        let t = text("plugins.list", "plugins:read", &v);
        assert!(t.starts_with("plugins.list answered a list of 5.") && t.contains("\"plugins:read\""), "{t}");
    }
}
