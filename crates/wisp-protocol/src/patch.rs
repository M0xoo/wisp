//! JSON Patch (RFC 6902), the subset wisp emits, plus a diff that produces it: the Rust twin of
//! packages/protocol/src/json-patch.ts. The store diffs a row's old and new value into
//! `change.patch`, the sync outbox folds patches, and every client applies them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::ProtocolError;

/// RFC 6902, the subset wisp emits. Paths are JSON Pointers into the entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PatchOp {
    Add {
        path: String,
        #[ts(type = "unknown")]
        value: Value,
    },
    Replace {
        path: String,
        #[ts(type = "unknown")]
        value: Value,
    },
    Remove {
        path: String,
    },
    Test {
        path: String,
        #[ts(type = "unknown")]
        value: Value,
    },
}

impl PatchOp {
    pub fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Replace { path, .. } | Self::Remove { path } | Self::Test { path, .. } => path,
        }
    }
}

pub fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

pub fn parse_pointer(path: &str) -> Result<Vec<String>, ProtocolError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(ProtocolError::Pointer(path.to_owned()));
    };
    Ok(rest.split('/').map(|s| s.replace("~1", "/").replace("~0", "~")).collect())
}

/// Ops that turn `a` into `b`. Arrays that only grew get `/-` appends; others are replaced whole.
pub fn diff(a: &Value, b: &Value) -> Vec<PatchOp> {
    let mut out = Vec::new();
    diff_into(a, b, "", &mut out);
    out
}

fn diff_into(a: &Value, b: &Value, path: &str, out: &mut Vec<PatchOp>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(was), Value::Object(now)) => {
            for k in was.keys().filter(|k| !now.contains_key(*k)) {
                out.push(PatchOp::Remove { path: format!("{path}/{}", escape_pointer(k)) });
            }
            for (k, v) in now {
                let p = format!("{path}/{}", escape_pointer(k));
                match was.get(k) {
                    None => out.push(PatchOp::Add { path: p, value: v.clone() }),
                    Some(old) => diff_into(old, v, &p, out),
                }
            }
        }
        (Value::Array(was), Value::Array(now)) if now.len() > was.len() && was.iter().zip(now).all(|(p, q)| p == q) => {
            for v in &now[was.len()..] {
                out.push(PatchOp::Add { path: format!("{path}/-"), value: v.clone() });
            }
        }
        _ => out.push(PatchOp::Replace { path: path.to_owned(), value: b.clone() }),
    }
}

/// Applies ops to `doc` in place. Fails on a `test` that doesn't hold or a path that doesn't exist;
/// on failure `doc` may hold the ops before the failing one (callers apply to a copy they can drop).
pub fn apply_patch(doc: &mut Value, ops: &[PatchOp]) -> Result<(), ProtocolError> {
    for op in ops {
        let keys = parse_pointer(op.path())?;
        apply_one(doc, &keys, op)?;
    }
    Ok(())
}

/// `apply_patch` on a copy: `doc` is untouched when the patch fails.
pub fn patched(doc: &Value, ops: &[PatchOp]) -> Result<Value, ProtocolError> {
    let mut out = doc.clone();
    apply_patch(&mut out, ops)?;
    Ok(out)
}

fn fail(op: &PatchOp, why: &'static str) -> ProtocolError {
    ProtocolError::Patch { path: op.path().to_owned(), why }
}

fn apply_one(doc: &mut Value, keys: &[String], op: &PatchOp) -> Result<(), ProtocolError> {
    let Some((last, parents)) = keys.split_last() else {
        return match op {
            PatchOp::Remove { .. } => Err(fail(op, "cannot remove the root")),
            PatchOp::Test { value, .. } => {
                if doc == value {
                    Ok(())
                } else {
                    Err(fail(op, "test failed"))
                }
            }
            PatchOp::Add { value, .. } | PatchOp::Replace { value, .. } => {
                *doc = value.clone();
                Ok(())
            }
        };
    };
    let mut target = doc;
    for k in parents {
        target = match target {
            Value::Object(m) => m.get_mut(k).ok_or_else(|| fail(op, "no path"))?,
            Value::Array(a) => index(k, a.len()).and_then(|i| a.get_mut(i)).ok_or_else(|| fail(op, "no index"))?,
            _ => return Err(fail(op, "no parent")),
        };
    }
    match target {
        Value::Array(a) => apply_in_array(a, last, op),
        Value::Object(m) => apply_in_object(m, last, op),
        _ => Err(fail(op, "no parent")),
    }
}

fn index(k: &str, len: usize) -> Option<usize> {
    if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    k.parse::<usize>().ok().filter(|i| *i < len)
}

fn apply_in_array(a: &mut Vec<Value>, k: &str, op: &PatchOp) -> Result<(), ProtocolError> {
    if let PatchOp::Add { value, .. } = op {
        let i = if k == "-" { Some(a.len()) } else { index(k, a.len() + 1) };
        let i = i.ok_or_else(|| fail(op, "bad index"))?;
        a.insert(i, value.clone());
        return Ok(());
    }
    let i = index(k, a.len()).ok_or_else(|| fail(op, "no index"))?;
    match op {
        PatchOp::Remove { .. } => {
            a.remove(i);
            Ok(())
        }
        PatchOp::Replace { value, .. } => {
            a[i] = value.clone();
            Ok(())
        }
        PatchOp::Test { value, .. } => {
            if &a[i] == value {
                Ok(())
            } else {
                Err(fail(op, "test failed"))
            }
        }
        PatchOp::Add { .. } => Ok(()), // handled above
    }
}

fn apply_in_object(m: &mut Map<String, Value>, k: &str, op: &PatchOp) -> Result<(), ProtocolError> {
    match op {
        PatchOp::Remove { .. } => m.remove(k).map(drop).ok_or_else(|| fail(op, "nothing to remove")),
        // the TS twin lets replace create a key; peers must agree, so this one does too
        PatchOp::Add { value, .. } | PatchOp::Replace { value, .. } => {
            m.insert(k.to_owned(), value.clone());
            Ok(())
        }
        PatchOp::Test { value, .. } => {
            if m.get(k) == Some(value) {
                Ok(())
            } else {
                Err(fail(op, "test failed"))
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diff_then_apply_gives_the_new_value() {
        let cases = [
            (json!({"a": 1, "b": [1]}), json!({"a": 2, "b": [1, 2], "c": {"d/e": "~"}})),
            (json!({"x": {"y": 1}}), json!({})),
            (json!([1, 2]), json!([2])),
            (json!(null), json!({"a": 1})),
            (json!({"t": "a"}), json!({"t": "a"})),
        ];
        for (a, b) in cases {
            let ops = diff(&a, &b);
            assert_eq!(patched(&a, &ops).unwrap(), b, "{ops:?}");
        }
        assert_eq!(diff(&json!({"l": [1]}), &json!({"l": [1, 2]})), vec![PatchOp::Add { path: "/l/-".into(), value: json!(2) }]);
    }

    #[test]
    fn pointers_escape_and_bad_paths_fail() {
        assert_eq!(parse_pointer("/a~1b/c~0d").unwrap(), vec!["a/b", "c~d"]);
        assert_eq!(escape_pointer("a/b~"), "a~1b~0");
        assert!(parse_pointer("x").is_err());
        let doc = json!({"a": {"b": 1}, "l": [0]});
        for bad in [
            PatchOp::Remove { path: "/nope".into() },
            PatchOp::Add { path: "/x/y".into(), value: json!(1) },
            PatchOp::Test { path: "/a/b".into(), value: json!(2) },
            PatchOp::Replace { path: "/l/5".into(), value: json!(1) },
            PatchOp::Add { path: "/l/01".into(), value: json!(1) },
        ] {
            assert!(patched(&doc, std::slice::from_ref(&bad)).is_err(), "{bad:?}");
        }
        let ok =
            patched(&doc, &[PatchOp::Add { path: "/l/0".into(), value: json!(9) }, PatchOp::Test { path: "/l/1".into(), value: json!(0) }])
                .unwrap();
        assert_eq!(ok, json!({"a": {"b": 1}, "l": [9, 0]}));
    }

    #[test]
    fn the_wire_shape_matches_rfc_6902() {
        let op: PatchOp = serde_json::from_str(r#"{"op":"replace","path":"/title","value":"x"}"#).unwrap();
        assert_eq!(op, PatchOp::Replace { path: "/title".into(), value: json!("x") });
        assert_eq!(serde_json::to_string(&PatchOp::Remove { path: "/a".into() }).unwrap(), r#"{"op":"remove","path":"/a"}"#);
    }
}
