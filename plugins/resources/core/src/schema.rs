//! Checking a spec against its kind's JSON Schema (the subset schemars writes: types, required,
//! properties, additionalProperties, items, enum, const, anyOf/oneOf, minimum/maximum, `$ref` into
//! `$defs`), and the whole formula's schema for editors (`wisp schema > wisp.schema.json`).

use serde_json::{Map, Value, json};
use wisp_resources_api::{FORMAT, KindInfo};

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "string" => v.is_string(),
        "integer" => v.as_i64().is_some() || v.as_u64().is_some(),
        "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        "null" => v.is_null(),
        _ => true,
    }
}

fn resolve<'a>(root: &'a Value, s: &'a Value) -> &'a Value {
    let mut s = s;
    for _ in 0..16 {
        let Some(r) = s.get("$ref").and_then(Value::as_str) else { break };
        let Some(name) = r.strip_prefix("#/$defs/").or_else(|| r.strip_prefix("#/definitions/")) else { break };
        match root.get("$defs").or_else(|| root.get("definitions")).and_then(|d| d.get(name)) {
            Some(next) => s = next,
            None => break,
        }
    }
    s
}

fn check(root: &Value, s: &Value, v: &Value, at: &str, out: &mut Vec<String>) {
    let s = resolve(root, s);
    if s == &Value::Bool(false) {
        out.push(format!("{at}: not allowed here"));
        return;
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(alts) = s.get(key).and_then(Value::as_array) {
            if !alts.iter().any(|a| {
                let mut e = Vec::new();
                check(root, a, v, at, &mut e);
                e.is_empty()
            }) {
                out.push(format!("{at}: doesn't match any of its forms"));
            }
            return;
        }
    }
    if let Some(t) = s.get("type") {
        let types: Vec<&str> = match t {
            Value::String(x) => vec![x.as_str()],
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.is_empty() && !types.iter().any(|t| type_ok(t, v)) {
            out.push(format!("{at}: should be {}, not {}", types.join(" or "), crate::plan::short(Some(v))));
            return;
        }
    }
    if let Some(e) = s.get("enum").and_then(Value::as_array)
        && !e.contains(v)
    {
        let opts: Vec<String> = e.iter().map(|x| crate::plan::short(Some(x))).collect();
        out.push(format!("{at}: one of {}, not {}", opts.join(", "), crate::plan::short(Some(v))));
    }
    if let Some(c) = s.get("const")
        && c != v
    {
        out.push(format!("{at}: should be {c}"));
    }
    if let (Some(min), Some(n)) = (s.get("minimum").and_then(Value::as_f64), v.as_f64())
        && n < min
    {
        out.push(format!("{at}: at least {min}"));
    }
    if let (Some(max), Some(n)) = (s.get("maximum").and_then(Value::as_f64), v.as_f64())
        && n > max
    {
        out.push(format!("{at}: at most {max}"));
    }
    if let Value::Object(o) = v {
        for r in s.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !o.contains_key(r) {
                out.push(format!("{at}: needs {r}"));
            }
        }
        let props = s.get("properties").and_then(Value::as_object);
        for (k, x) in o {
            let p = if at.is_empty() { k.clone() } else { format!("{at}.{k}") };
            match (props.and_then(|p| p.get(k)), s.get("additionalProperties")) {
                (Some(ps), _) => check(root, ps, x, &p, out),
                (None, Some(Value::Bool(false))) => {
                    let known: Vec<&String> = props.map(|p| p.keys().collect()).unwrap_or_default();
                    out.push(format!(
                        "{p}: unknown field (fields: {})",
                        known.into_iter().map(String::as_str).collect::<Vec<_>>().join(", ")
                    ));
                }
                (None, Some(more)) if more.is_object() => check(root, more, x, &p, out),
                _ => {}
            }
        }
    }
    if let (Value::Array(a), Some(items)) = (v, s.get("items")) {
        for (i, x) in a.iter().enumerate() {
            check(root, items, x, &format!("{at}[{i}]"), out);
        }
    }
}

/// The problems of `v` against `schema` (empty: it fits), each with where it is.
pub fn validate(schema: &Value, v: &Value, at: &str) -> Vec<String> {
    let mut out = Vec::new();
    check(schema, schema, v, at, &mut out);
    out
}

/// `#/$defs/X` in a kind's schema → `#/$defs/<kind>.X`, so every kind's definitions sit in one schema.
fn rename(v: &mut Value, kind: &str) {
    match v {
        Value::Object(o) => {
            if let Some(Value::String(r)) = o.get_mut("$ref")
                && let Some(n) = r.strip_prefix("#/$defs/")
            {
                *r = format!("#/$defs/{kind}.{n}");
            }
            o.values_mut().for_each(|x| rename(x, kind));
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rename(x, kind)),
        _ => {}
    }
}

/// The JSON Schema of a whole formula for `kinds`: what a YAML language server checks a `wisp.yml` with.
pub fn formula(kinds: &[KindInfo]) -> Value {
    let mut defs = Map::new();
    let mut props = Map::new();
    props.insert("wisp".into(), json!({ "const": FORMAT, "description": "the formula format" }));
    props.insert("include".into(), json!({ "description": "other formulas read first (paths, URLs)", "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] }));
    let mut sections = Map::new();
    for k in kinds {
        let mut s = k.schema.clone();
        rename(&mut s, &k.kind);
        if let Some(Value::Object(d)) = s.as_object_mut().and_then(|o| o.remove("$defs")) {
            for (n, x) in d {
                defs.insert(format!("{}.{n}", k.kind), x);
            }
        }
        if let Some(o) = s.as_object_mut() {
            o.remove("$schema");
        }
        defs.insert(k.kind.clone(), s);
        let one = json!({ "$ref": format!("#/$defs/{}", k.kind) });
        let section = if k.map_form {
            json!({ "type": "object", "description": k.doc, "additionalProperties": one })
        } else {
            let named =
                json!({ "allOf": [one, { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }] });
            json!({ "description": k.doc, "anyOf": [{ "type": "array", "items": named }, { "type": "object", "additionalProperties": one }] })
        };
        sections.insert(k.section.clone(), section);
    }
    for (k, v) in &sections {
        props.insert(k.clone(), v.clone());
    }
    props.insert("profiles".into(), json!({ "description": "parts picked with --profile NAME", "type": "object", "additionalProperties": { "type": "object", "properties": Value::Object(sections) } }));
    json!({ "$schema": "https://json-schema.org/draft/2020-12/schema", "title": "wisp formula", "type": "object", "required": ["wisp"], "properties": Value::Object(props), "additionalProperties": false, "$defs": Value::Object(defs) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_what_schemars_writes() {
        let s = json!({ "type": "object", "required": ["harness"], "additionalProperties": false,
            "properties": { "harness": { "type": "string" }, "effort": { "$ref": "#/$defs/Effort" }, "n": { "type": ["integer", "null"], "minimum": 0 }, "tags": { "type": "array", "items": { "type": "string" } } },
            "$defs": { "Effort": { "type": "string", "enum": ["low", "high"] } } });
        assert_eq!(
            validate(&s, &json!({ "harness": "codex", "effort": "high", "n": 2, "tags": ["a"] }), "agents.reviewer"),
            Vec::<String>::new()
        );
        let got = validate(&s, &json!({ "effort": "max", "n": -1, "tags": [3], "modle": "x" }), "agents.reviewer");
        assert_eq!(
            got,
            [
                "agents.reviewer: needs harness",
                "agents.reviewer.effort: one of \"low\", \"high\", not \"max\"",
                "agents.reviewer.modle: unknown field (fields: effort, harness, n, tags)",
                "agents.reviewer.n: at least 0",
                "agents.reviewer.tags[0]: should be string, not 3"
            ]
        );
    }
}
