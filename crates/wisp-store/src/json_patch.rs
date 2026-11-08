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
            Self::Add { path, .. }
            | Self::Replace { path, .. }
            | Self::Remove { path }
            | Self::Test { path, .. } => path,
        }
    }
    /// `replace` at a pointer built from plain keys: `PatchOp::replace(&["title"], json!("x"))`
    pub fn replace(keys: &[&str], value: Value) -> Self {
        Self::Replace {
            path: pointer(keys),
            value,
        }
    }
    pub fn add(keys: &[&str], value: Value) -> Self {
        Self::Add {
            path: pointer(keys),
            value,
        }
    }
    pub fn remove(keys: &[&str]) -> Self {
        Self::Remove {
            path: pointer(keys),
        }
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
    Ok(rest
        .split('/')
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// JSON equality: numbers by value (`1 == 1.0`), objects by key set, arrays by position.
pub fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y || x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w)))
        }
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
        (Value::Array(x), Value::Array(y))
            if y.len() > x.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q)) =>
        {
            let at = format!("{path}/-");
            ops.extend(y[x.len()..].iter().map(|v| PatchOp::Add {
                path: at.clone(),
                value: v.clone(),
            }));
        }
        _ => ops.push(PatchOp::Replace {
            path: path.clone(),
            value: b.clone(),
        }),
    }
}

fn diff_objects(
    x: &Map<String, Value>,
    y: &Map<String, Value>,
    path: &mut String,
    ops: &mut Vec<PatchOp>,
) {
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
            None => ops.push(PatchOp::Add {
                path: path.clone(),
                value: v.clone(),
            }),
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
    if deep_equal(have, want) {
        Ok(())
    } else {
        Err(PatchError(format!("test failed at {path}")))
    }
}

fn step<'v>(target: &'v mut Value, key: &str, op: &PatchOp) -> Result<&'v mut Value, PatchError> {
    match target {
        Value::Array(list) => {
            let len = list.len();
            index(key)
                .filter(|i| *i < len)
                .and_then(|i| list.get_mut(i))
                .ok_or_else(|| PatchError(format!("no index at {}", op.path())))
        }
        Value::Object(map) => map
            .get_mut(key)
            .ok_or_else(|| PatchError(format!("no path at {}", op.path()))),
        _ => Err(PatchError(format!("no parent at {}", op.path()))),
    }
}

fn index(key: &str) -> Option<usize> {
    // RFC 6901: no leading zeros, no sign; JS's Number() is laxer but wisp never emits those.
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse().ok()
}

fn at_leaf(target: &mut Value, key: &str, op: &PatchOp) -> Result<(), PatchError> {
    let path = op.path();
    match target {
        Value::Array(list) => {
            if let PatchOp::Add { value, .. } = op {
                let i = if key == "-" {
                    Some(list.len())
                } else {
                    index(key)
                };
                let i = i
                    .filter(|i| *i <= list.len())
                    .ok_or_else(|| PatchError(format!("bad index at {path}")))?;
                list.insert(i, value.clone());
                return Ok(());
            }
            let i = index(key)
                .filter(|i| *i < list.len())
                .ok_or_else(|| PatchError(format!("no index at {path}")))?;
            match op {
                PatchOp::Remove { .. } => {
                    list.remove(i);
                }
                PatchOp::Test { value, .. } => test(&list[i], value, path)?,
                PatchOp::Replace { value, .. } | PatchOp::Add { value, .. } => {
                    list[i] = value.clone();
                }
            }
            Ok(())
        }
        Value::Object(map) => {
            match op {
                PatchOp::Remove { .. } => {
                    map.remove(key)
                        .ok_or_else(|| PatchError(format!("nothing to remove at {path}")))?;
                }
                PatchOp::Test { value, .. } => {
                    test(map.get(key).unwrap_or(&Value::Null), value, path).and_then(|()| {
                        // a missing key is `undefined` in the TypeScript twin, which equals nothing
                        if map.contains_key(key) {
                            Ok(())
                        } else {
                            Err(PatchError(format!("test failed at {path}")))
                        }
                    })?;
                }
                PatchOp::Add { value, .. } | PatchOp::Replace { value, .. } => {
                    map.insert(key.to_owned(), value.clone());
                }
            }
            Ok(())
        }
        _ => Err(PatchError(format!("no parent at {path}"))),
    }
}
