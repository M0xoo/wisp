//! Resources written back as a formula (`wisp export`): `wisp: 1` first, sections in the kinds' order,
//! each item's `name` first. YAML is written here (block style, quoted only where YAML would read the
//! text as something else), so an export reads well in review and parses back to the same resources.

use serde_json::{Map, Value};
use wisp_resources_api::{FORMAT, KindInfo, Resource};

use crate::formula::Format;

/// The formula as ordered sections: (section, its value).
pub fn sections(resources: &[Resource], kinds: &[KindInfo]) -> Vec<(String, Value)> {
    let mut ks: Vec<&KindInfo> = kinds.iter().filter(|k| resources.iter().any(|r| r.kind == k.kind)).collect();
    ks.sort_by_key(|k| (k.order, k.kind.clone()));
    ks.into_iter()
        .map(|k| {
            let mine = resources.iter().filter(|r| r.kind == k.kind);
            let v = if k.singleton {
                mine.into_iter().next().map_or(Value::Null, |r| r.spec.clone())
            } else if k.map_form {
                Value::Object(mine.map(|r| (r.name.clone(), r.spec.clone())).collect())
            } else {
                let mut list: Vec<&Resource> = mine.collect();
                list.sort_by(|a, b| a.name.cmp(&b.name));
                Value::Array(
                    list.into_iter()
                        .map(|r| {
                            let mut o = Map::new();
                            o.insert("name".into(), Value::String(r.name.clone()));
                            if let Value::Object(spec) = &r.spec {
                                for (key, x) in spec {
                                    o.insert(key.clone(), x.clone());
                                }
                            }
                            Value::Object(o)
                        })
                        .collect(),
                )
            };
            (k.section.clone(), v)
        })
        .collect()
}

/// The text of the formula in `format`.
pub fn write(resources: &[Resource], kinds: &[KindInfo], format: Format) -> String {
    let secs = sections(resources, kinds);
    match format {
        Format::Yaml => {
            let mut s = format!("wisp: {FORMAT}\n");
            for (name, v) in &secs {
                s.push_str(&key(name));
                s.push(':');
                block(v, 0, &mut s);
            }
            s
        }
        Format::Json | Format::Toml => {
            let mut o = Map::new();
            o.insert("wisp".into(), Value::from(FORMAT));
            for (name, v) in secs {
                o.insert(name, v);
            }
            if format == Format::Json {
                serde_json::to_string_pretty(&Value::Object(o)).unwrap_or_default() + "\n"
            } else {
                toml::to_string(&strip_nulls(Value::Object(o))).unwrap_or_default()
            }
        }
    }
}

/// TOML has no null: a null field is left out.
fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(o.into_iter().filter(|(_, x)| !x.is_null()).map(|(k, x)| (k, strip_nulls(x))).collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}

const RESERVED: [&str; 22] = [
    "true", "false", "yes", "no", "on", "off", "y", "n", "null", "~", "True", "False", "TRUE", "FALSE", "Yes", "No", "YES", "NO", "On",
    "Off", "ON", "OFF",
];

/// Whether `s` must be quoted to read back as this string.
fn needs_quotes(s: &str) -> bool {
    s.is_empty()
        || RESERVED.contains(&s)
        || s.trim() != s
        || s.parse::<f64>().is_ok()
        || s.starts_with(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', '.', '+'])
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':')
        || s.chars().any(char::is_control)
        || s.starts_with("0x")
        || s.starts_with("0o")
}

fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn scalar(s: &str) -> String {
    if needs_quotes(s) { quoted(s) } else { s.to_owned() }
}

fn key(k: &str) -> String {
    scalar(k)
}

fn inline(v: &Value) -> Option<String> {
    match v {
        Value::Null => Some("null".into()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if s.contains('\n') => None,
        Value::String(s) => Some(scalar(s)),
        Value::Array(a) if a.is_empty() => Some("[]".into()),
        Value::Object(o) if o.is_empty() => Some("{}".into()),
        _ => None,
    }
}

/// An object's keys, `name` first (a reader looks for it), then in order.
fn ordered(o: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = o.keys().collect();
    keys.sort_by_key(|k| (k.as_str() != "name", (*k).clone()));
    keys
}

/// `v` after a `key:` (or `-`) at `indent`: inline when it fits on the line, else a block below.
#[allow(clippy::many_single_char_names)]
fn block(v: &Value, indent: usize, s: &mut String) {
    if let Some(x) = inline(v) {
        s.push(' ');
        s.push_str(&x);
        s.push('\n');
        return;
    }
    let pad = " ".repeat(indent + 2);
    match v {
        Value::String(text) => {
            s.push_str(if text.ends_with('\n') { " |\n" } else { " |-\n" });
            for l in text.trim_end_matches('\n').split('\n') {
                if l.is_empty() {
                    s.push('\n');
                } else {
                    s.push_str(&pad);
                    s.push_str(l);
                    s.push('\n');
                }
            }
        }
        Value::Array(a) => {
            s.push('\n');
            for x in a {
                s.push_str(&pad);
                s.push('-');
                match x {
                    Value::Object(o) if !o.is_empty() => {
                        // the first key on the dash's line, the rest under it
                        for (i, k) in ordered(o).into_iter().enumerate() {
                            let y = &o[k];
                            if i > 0 {
                                s.push_str(&pad);
                                s.push_str("  ");
                            } else {
                                s.push(' ');
                            }
                            s.push_str(&key(k));
                            s.push(':');
                            block(y, indent + 4, s);
                        }
                    }
                    other => block(other, indent + 2, s),
                }
            }
        }
        Value::Object(o) => {
            s.push('\n');
            for k in ordered(o) {
                s.push_str(&pad);
                s.push_str(&key(k));
                s.push(':');
                block(&o[k], indent + 2, s);
            }
        }
        _ => {}
    }
}

/// One value as YAML text (for `wisp task spec`, the schema of one kind).
pub fn yaml(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let mut s = String::new();
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by_key(|k| (k.as_str() != "name" && k.as_str() != "wisp", (*k).clone()));
            for k in keys {
                s.push_str(&key(k));
                s.push(':');
                block(&o[k], 0, &mut s);
            }
            s
        }
        other => {
            let mut s = String::new();
            block(other, 0, &mut s);
            s.trim_start().to_owned()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::formula::documents;

    #[test]
    fn yaml_parses_back_to_the_same_value() {
        let v = json!({ "name": "Ada", "on": ["ci", "done"], "n": "no", "cron": "every day at 2", "brief": "line one\nline two\n", "x": { "a": "1.5", "b": 2, "c": null, "d": "-x", "e": "a: b" }, "kit": [{ "name": "k", "body": "hi" }], "empty": [], "obj": {} });
        let text = yaml(&v);
        assert_eq!(documents(&text, Format::Yaml).unwrap(), [v], "{text}");
        assert!(text.starts_with("name: Ada\n"), "{text}");
    }
}
