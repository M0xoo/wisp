//! JSON Patch (RFC 6902), the subset wisp emits, and the diff that produces it. It matches
//! `@wisp/protocol`'s `json-patch.ts` op for op: the store diffs a row's old and new value into
//! `change.patch`, and every client applies the result with the TypeScript twin, so both must agree.
//!
//! - `diff`: objects recurse (removes first, then adds and changes); an array that only grew gets one
//!   `add …/-` per new item (a streamed list stays cheap); anything else is a whole `replace`.
//! - `apply`: works on a copy; a failed `test`, a missing path or a bad index fails the whole patch.
//! - equality is JSON's: `1` and `1.0` are the same number, key order never matters.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PatchOp {
    Add { path: String, value: Value },
    Replace { path: String, value: Value },
    Remove { path: String },
    Test { path: String, value: Value },
}

impl PatchOp {
    pub fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Replace { path, .. } | Self::Remove { path } | Self::Test { path, .. } => path,
        }
    }
    /// `replace` at a pointer built from plain keys: `PatchOp::replace(&["title"], json!("x"))`
    pub fn replace(keys: &[&str], value: Value) -> Self {
        Self::Replace { path: pointer(keys), value }
    }
    pub fn add(keys: &[&str], value: Value) -> Self {
        Self::Add { path: pointer(keys), value }
    }
    pub fn remove(keys: &[&str]) -> Self {
        Self::Remove { path: pointer(keys) }
    }
}

/// Why a patch did not apply; the message names the path.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PatchError(pub String);

pub fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

pub fn pointer(keys: &[&str]) -> String {
    keys.iter().fold(String::new(), |mut s, k| {
        s.push('/');
        s.push_str(&escape_pointer(k));
        s
    })
}

pub fn parse_pointer(path: &str) -> Result<Vec<String>, PatchError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(PatchError(format!("bad JSON pointer: {path}")));
    };
    Ok(rest.split('/').map(|s| s.replace("~1", "/").replace("~0", "~")).collect())
}

/// JSON equality: numbers by value (`1 == 1.0`), objects by key set, arrays by position.
pub fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y || x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w))),
        _ => a == b,
    }
}

/// Ops that turn `a` into `b`.
pub fn diff(a: &Value, b: &Value) -> Vec<PatchOp> {
    let mut ops = Vec::new();
    diff_into(a, b, &mut String::new(), &mut ops);
    ops
}

pub(crate) fn diff_into(a: &Value, b: &Value, path: &mut String, ops: &mut Vec<PatchOp>) {
    if deep_equal(a, b) {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => diff_objects(x, y, path, ops),
        (Value::Array(x), Value::Array(y)) if y.len() > x.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q)) => {
            let at = format!("{path}/-");
            ops.extend(y[x.len()..].iter().map(|v| PatchOp::Add { path: at.clone(), value: v.clone() }));
        }
        _ => ops.push(PatchOp::Replace { path: path.clone(), value: b.clone() }),
    }
}

fn diff_objects(x: &Map<String, Value>, y: &Map<String, Value>, path: &mut String, ops: &mut Vec<PatchOp>) {
    let base = path.len();
    for k in x.keys().filter(|k| !y.contains_key(*k)) {
        path.push('/');
        path.push_str(&escape_pointer(k));
        ops.push(PatchOp::Remove { path: path.clone() });
        path.truncate(base);
    }
    for (k, v) in y {
        path.push('/');
        path.push_str(&escape_pointer(k));
        match x.get(k) {
            None => ops.push(PatchOp::Add { path: path.clone(), value: v.clone() }),
            Some(old) => diff_into(old, v, path, ops),
        }
        path.truncate(base);
    }
}

/// Applies `ops` to a copy of `doc`. Fails on a failed `test` or a path that doesn't exist.
pub fn apply(doc: &Value, ops: &[PatchOp]) -> Result<Value, PatchError> {
    let mut out = doc.clone();
    for op in ops {
        apply_one(&mut out, op)?;
    }
    Ok(out)
}

/// In place: on an error, `doc` may hold the ops before the failing one (use `apply` for a copy).
pub fn apply_in_place(doc: &mut Value, ops: &[PatchOp]) -> Result<(), PatchError> {
    for op in ops {
        apply_one(doc, op)?;
    }
    Ok(())
}

fn apply_one(doc: &mut Value, op: &PatchOp) -> Result<(), PatchError> {
    let keys = parse_pointer(op.path())?;
    let Some((last, parents)) = keys.split_last() else {
        return at_root(doc, op);
    };
    let mut target = doc;
    for key in parents {
        target = step(target, key, op)?;
    }
    at_leaf(target, last, op)
}

fn at_root(doc: &mut Value, op: &PatchOp) -> Result<(), PatchError> {
    match op {
        PatchOp::Remove { .. } => *doc = Value::Null,
        PatchOp::Test { value, path } => test(doc, value, path)?,
        PatchOp::Add { value, .. } | PatchOp::Replace { value, .. } => *doc = value.clone(),
    }
    Ok(())
}

fn test(have: &Value, want: &Value, path: &str) -> Result<(), PatchError> {
    if deep_equal(have, want) { Ok(()) } else { Err(PatchError(format!("test failed at {path}"))) }
}

fn step<'v>(target: &'v mut Value, key: &str, op: &PatchOp) -> Result<&'v mut Value, PatchError> {
    match target {
        Value::Array(list) => {
            let len = list.len();
            index(key).filter(|i| *i < len).and_then(|i| list.get_mut(i)).ok_or_else(|| PatchError(format!("no index at {}", op.path())))
        }
        Value::Object(map) => map.get_mut(key).ok_or_else(|| PatchError(format!("no path at {}", op.path()))),
        _ => Err(PatchError(format!("no parent at {}", op.path()))),
    }
}

fn index(key: &str) -> Option<usize> {
    // RFC 6901: no leading zeros, no sign; JS's Number() is laxer but wisp never emits those.
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse().ok()
}

fn at_leaf(target: &mut Value, key: &str, op: &PatchOp) -> Result<(), PatchError> {
    let path = op.path();
    match target {
        Value::Array(list) => {
            if let PatchOp::Add { value, .. } = op {
                let i = if key == "-" { Some(list.len()) } else { index(key) };
                let i = i.filter(|i| *i <= list.len()).ok_or_else(|| PatchError(format!("bad index at {path}")))?;
                list.insert(i, value.clone());
                return Ok(());
            }
            let i = index(key).filter(|i| *i < list.len()).ok_or_else(|| PatchError(format!("no index at {path}")))?;
            match op {
                PatchOp::Remove { .. } => {
                    list.remove(i);
                }
                PatchOp::Test { value, .. } => test(&list[i], value, path)?,
                PatchOp::Replace { value, .. } | PatchOp::Add { value, .. } => list[i] = value.clone(),
            }
            Ok(())
        }
        Value::Object(map) => {
            match op {
                PatchOp::Remove { .. } => {
                    map.remove(key).ok_or_else(|| PatchError(format!("nothing to remove at {path}")))?;
                }
                PatchOp::Test { value, .. } => test(map.get(key).unwrap_or(&Value::Null), value, path).and_then(|()| {
                    // a missing key is `undefined` in the TypeScript twin, which equals nothing
                    if map.contains_key(key) { Ok(()) } else { Err(PatchError(format!("test failed at {path}"))) }
                })?,
                PatchOp::Add { value, .. } | PatchOp::Replace { value, .. } => {
                    map.insert(key.to_owned(), value.clone());
                }
            }
            Ok(())
        }
        _ => Err(PatchError(format!("no parent at {path}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diff_matches_the_typescript_twin() {
        assert_eq!(diff(&json!({"a": [1]}), &json!({"a": [1, 2, 3]})), vec![PatchOp::add(&["a", "-"], json!(2)), PatchOp::add(&["a", "-"], json!(3))]);
        assert_eq!(diff(&json!({"a": [1, 2]}), &json!({"a": [2]})), vec![PatchOp::replace(&["a"], json!([2]))]);
        assert_eq!(diff(&json!({"a": 1, "b": 2}), &json!({"b": 3, "c": 4})), vec![PatchOp::remove(&["a"]), PatchOp::replace(&["b"], json!(3)), PatchOp::add(&["c"], json!(4))]);
        assert_eq!(diff(&json!({"a/b~": 1}), &json!({"a/b~": 2})), vec![PatchOp::Replace { path: "/a~1b~0".into(), value: json!(2) }]);
        assert!(diff(&json!({"n": 1}), &json!({"n": 1.0})).is_empty());
        assert_eq!(diff(&json!(1), &json!("x")), vec![PatchOp::Replace { path: String::new(), value: json!("x") }]);
    }

    #[test]
    fn apply_follows_rfc_6902() {
        let doc = json!({"t": [1], "o": {"k": 1}});
        let out = apply(&doc, &[PatchOp::add(&["t", "-"], json!(2)), PatchOp::add(&["t", "0"], json!(0)), PatchOp::remove(&["o", "k"]), PatchOp::replace(&["n"], json!(5))]);
        assert_eq!(out, Ok(json!({"t": [0, 1, 2], "o": {}, "n": 5})));
        assert!(apply(&doc, &[PatchOp::remove(&["nope"])]).is_err());
        assert!(apply(&doc, &[PatchOp::add(&["x", "y"], json!(1))]).is_err());
        assert!(apply(&doc, &[PatchOp::add(&["t", "5"], json!(1))]).is_err());
        assert!(apply(&doc, &[PatchOp::Test { path: "/o/k".into(), value: json!(2) }]).is_err());
        assert!(apply(&doc, &[PatchOp::Test { path: "/o/k".into(), value: json!(1.0) }]).is_ok());
        assert!(apply(&doc, &[PatchOp::Test { path: "/o/missing".into(), value: Value::Null }]).is_err());
        assert!(apply(&doc, &[PatchOp::Remove { path: "t".into() }]).is_err(), "a pointer starts with /");
        assert_eq!(doc, json!({"t": [1], "o": {"k": 1}}), "apply never touches its input");
    }

    #[test]
    fn ops_serialise_as_the_wire_shape() {
        let op = PatchOp::add(&["a", "-"], json!(1));
        assert_eq!(serde_json::to_value(&op).ok(), Some(json!({"op": "add", "path": "/a/-", "value": 1})));
        let back: Result<PatchOp, _> = serde_json::from_value(json!({"op": "remove", "path": "/x"}));
        assert_eq!(back.ok(), Some(PatchOp::remove(&["x"])));
    }

    // diff then apply gives the target, for random nested values (a property test with a seeded rng)
    #[test]
    fn diff_then_apply_round_trips() {
        let mut seed = 7u64;
        for _ in 0..500 {
            let a = random_value(&mut seed, 3);
            let b = random_value(&mut seed, 3);
            let ops = diff(&a, &b);
            assert!(apply(&a, &ops).is_ok_and(|got| deep_equal(&got, &b)), "{a} → {b} via {ops:?}");
        }
    }

    fn next(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        *seed >> 33
    }

    fn random_value(seed: &mut u64, depth: u32) -> Value {
        match next(seed) % if depth == 0 { 3 } else { 5 } {
            0 => Value::Null,
            1 => json!(next(seed) % 4),
            2 => json!(["a", "b/", "~c"][usize::try_from(next(seed) % 3).unwrap_or(0)]),
            3 => Value::Array((0..next(seed) % 4).map(|_| random_value(seed, depth - 1)).collect()),
            _ => Value::Object((0..next(seed) % 4).map(|i| (format!("k{}", (i + next(seed)) % 4), random_value(seed, depth - 1))).collect()),
        }
    }
}
