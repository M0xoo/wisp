//! The generic plan (ADR-0026): a desired spec is a patch over the current one (objects merge, the rest is
//! replaced), so a formula that leaves a field out keeps its value, and an export applied back is a no-op.
//! Pure: current and desired in, ops out.

use serde_json::{Map, Value};
use wisp_resources_api::{FieldChange, KindInfo, Op, OpKind, Resource};

/// `desired` over `current`: objects merge key by key, anything else is `desired`.
pub fn merge(current: &Value, desired: &Value) -> Value {
    match (current, desired) {
        (Value::Object(c), Value::Object(d)) => {
            let mut out: Map<String, Value> = c.clone();
            for (k, v) in d {
                let next = c.get(k).map_or_else(|| v.clone(), |had| merge(had, v));
                out.insert(k.clone(), next);
            }
            Value::Object(out)
        }
        _ => desired.clone(),
    }
}

/// The fields that differ between `from` and `to`, by path.
#[allow(clippy::many_single_char_names)]
pub fn diff(from: &Value, to: &Value, path: &str, out: &mut Vec<FieldChange>) {
    match (from, to) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let p = if path.is_empty() { k.clone() } else { format!("{path}/{k}") };
                match (a.get(k), b.get(k)) {
                    (Some(x), Some(y)) => diff(x, y, &p, out),
                    (x, y) => out.push(FieldChange { path: p, from: x.cloned(), to: y.cloned() }),
                }
            }
        }
        (a, b) if a != b => out.push(FieldChange { path: path.to_owned(), from: Some(a.clone()), to: Some(b.clone()) }),
        _ => {}
    }
}

/// One kind's ops: creates and updates in the formula's order, then (with `prune`) deletes of what it
/// doesn't declare. Returns the ops and how many declared resources are already so.
pub fn plan(current: &[Resource], desired: &[Resource], prune: bool) -> (Vec<Op>, usize) {
    let mut ops = Vec::new();
    let mut same = 0;
    for d in desired {
        match current.iter().find(|c| c.name == d.name) {
            None => ops.push(Op { op: OpKind::Create, kind: d.kind.clone(), name: d.name.clone(), spec: d.spec.clone(), id: None, changes: Vec::new() }),
            Some(c) => {
                let next = merge(&c.spec, &d.spec);
                if next == c.spec {
                    same += 1;
                } else {
                    let mut changes = Vec::new();
                    diff(&c.spec, &next, "", &mut changes);
                    ops.push(Op { op: OpKind::Update, kind: d.kind.clone(), name: d.name.clone(), spec: next, id: c.id.clone(), changes });
                }
            }
        }
    }
    if prune {
        for c in current.iter().filter(|c| !desired.iter().any(|d| d.name == c.name)) {
            ops.push(Op { op: OpKind::Delete, kind: c.kind.clone(), name: c.name.clone(), spec: c.spec.clone(), id: c.id.clone(), changes: Vec::new() });
        }
    }
    (ops, same)
}

/// The order ops run in: creates and updates by kind order (projects before crew), deletes after, in
/// reverse (crew before projects).
pub fn order(ops: &mut [Op], kinds: &[KindInfo]) {
    let rank = |k: &str| kinds.iter().find(|x| x.kind == k).map_or(100, |x| x.order);
    ops.sort_by_key(|o| if o.op == OpKind::Delete { (1, -rank(&o.kind)) } else { (0, rank(&o.kind)) });
}

/// A value on one line for a diff (`"opus"`, `4`, `[2 items]`).
pub fn short(v: Option<&Value>) -> String {
    match v {
        None => "—".to_owned(),
        Some(Value::String(s)) if s.chars().count() > 40 => format!("{:?}", format!("{}…", s.chars().take(39).collect::<String>())),
        Some(Value::String(s)) => format!("{s:?}"),
        Some(Value::Array(a)) if a.len() > 3 => format!("[{} items]", a.len()),
        Some(Value::Object(o)) if o.len() > 3 => format!("{{{} fields}}", o.len()),
        Some(other) => other.to_string(),
    }
}

/// The plan as lines: a mark (`+`, `~`, `-`) and the text.
pub fn lines(ops: &[Op]) -> Vec<(char, String)> {
    let mut out = Vec::new();
    for o in ops {
        let what = format!("{}/{}", o.kind, o.name);
        match o.op {
            OpKind::Create => out.push(('+', format!("{what}  (new)"))),
            OpKind::Delete => out.push(('-', format!("{what}  (goes)"))),
            OpKind::Update => {
                out.push(('~', what));
                for c in &o.changes {
                    out.push((' ', format!("    {}: {} → {}", c.path, short(c.from.as_ref()), short(c.to.as_ref()))));
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn r(name: &str, spec: Value) -> Resource {
        Resource::new("agent", name, spec)
    }

    #[test]
    fn a_desired_spec_patches_the_current_one() {
        let cur = [r("reviewer", json!({ "harness": "codex", "model": "gpt-5", "effort": "high" })), r("fixer", json!({ "harness": "claude" }))];
        let want = [r("reviewer", json!({ "model": "gpt-5-pro" })), r("fixer", json!({ "harness": "claude" })), r("writer", json!({ "harness": "claude" }))];
        let (ops, same) = plan(&cur, &want, false);
        assert_eq!(same, 1);
        assert_eq!(ops.iter().map(|o| (o.op, o.name.as_str())).collect::<Vec<_>>(), [(OpKind::Update, "reviewer"), (OpKind::Create, "writer")]);
        assert_eq!(ops[0].spec, json!({ "harness": "codex", "model": "gpt-5-pro", "effort": "high" }), "effort kept: the formula left it out");
        assert_eq!(ops[0].changes, [FieldChange { path: "model".into(), from: Some(json!("gpt-5")), to: Some(json!("gpt-5-pro")) }]);
        let (ops, _) = plan(&cur, &want[..1], true);
        assert!(ops.iter().any(|o| o.op == OpKind::Delete && o.name == "fixer"), "prune deletes what isn't declared");
    }

    #[test]
    fn the_current_state_applied_back_is_a_no_op() {
        let cur = [r("reviewer", json!({ "harness": "codex", "connectors": ["linear"], "limits": { "usd": 5 } }))];
        assert_eq!(plan(&cur, &cur, true), (Vec::new(), 1));
    }

    #[test]
    fn deletes_go_last_and_in_reverse() {
        let kinds = [KindInfo::new("project", "projects", "x", json!({})).order(10), KindInfo::new("crew", "crew", "x", json!({})).order(50)];
        let op = |o: OpKind, k: &str| Op { op: o, kind: k.into(), name: "n".into(), spec: Value::Null, id: None, changes: Vec::new() };
        let mut ops = vec![op(OpKind::Delete, "project"), op(OpKind::Create, "crew"), op(OpKind::Delete, "crew"), op(OpKind::Create, "project")];
        order(&mut ops, &kinds);
        let got: Vec<(OpKind, &str)> = ops.iter().map(|o| (o.op, o.kind.as_str())).collect();
        assert_eq!(got, [(OpKind::Create, "project"), (OpKind::Create, "crew"), (OpKind::Delete, "crew"), (OpKind::Delete, "project")]);
    }
}
