//! Folding queued entity ops (plan §4.4). `fold(queued, next)` gives ops with the same effect on any
//! client state as `queued` then `next`, usually fewer of them:
//!
//!   upsert wins · a del drops what was queued · appends join · patches compose
//!
//! A fold that can't be proven equal keeps both ops in order: folding is an optimisation, never a
//! change of meaning (tests/fold.rs checks it on random histories).

use wisp_protocol::{Change, EntityOp, PatchOp, parse_pointer, patched};

/// Whether `next` replaces everything queued for its entity.
pub(crate) fn replaces(next: &Change) -> bool {
    matches!(next, Change::Upsert { .. } | Change::Del)
}

/// Whether `next` can fold into `prev` (cheap: decides before anything is cloned).
pub(crate) fn may_fold(prev: &Change, next: &Change) -> bool {
    match (prev, next) {
        (Change::Upsert { .. } | Change::Patch { .. }, Change::Patch { .. }) | (Change::Append { .. }, Change::Append { .. }) => true,
        (Change::Upsert { v }, Change::Append { .. }) => v.is_array(),
        _ => false,
    }
}

/// Folds `next` into `prev` in place. False (and `prev` unchanged) when it can't.
pub(crate) fn fold_into(prev: &mut Change, next: &Change) -> bool {
    match (prev, next) {
        (Change::Upsert { v }, Change::Patch { ops }) => match patched(v, ops) {
            Ok(nv) => {
                *v = nv;
                true
            }
            Err(_) => false, // a patch that doesn't apply is the client's to report, unchanged
        },
        (Change::Patch { ops: a }, Change::Patch { ops: b }) => {
            compose(a, b);
            true
        }
        (Change::Append { v: a } | Change::Upsert { v: serde_json::Value::Array(a) }, Change::Append { v: b }) => {
            a.extend(b.iter().cloned());
            true
        }
        _ => false,
    }
}

/// The pure form, on whole ops (tests and the TS twin's semantics).
pub fn fold(queued: &[EntityOp], next: &EntityOp) -> Vec<EntityOp> {
    if replaces(&next.change) {
        return vec![next.clone()];
    }
    let mut out = queued.to_vec();
    let folded = out.last_mut().is_some_and(|last| may_fold(&last.change, &next.change) && fold_into(&mut last.change, &next.change));
    if !folded {
        out.push(next.clone());
    }
    out
}

/// `a` then `b`, into `a`, dropping ops of `a` that a later replace or remove in `b` makes dead.
pub fn compose(a: &mut Vec<PatchOp>, b: &[PatchOp]) {
    for op in b {
        let target = object_path(op);
        let whole = matches!(op, PatchOp::Replace { .. } | PatchOp::Remove { .. } | PatchOp::Add { .. });
        let Some(target) = target.filter(|_| whole) else {
            a.push(op.clone());
            continue;
        };
        let mut next = op.clone();
        let mut i = a.len();
        while i > 0 {
            i -= 1;
            let keys = parse_pointer(a[i].path()).unwrap_or_default();
            if is_prefix(&keys, &target, true) {
                break; // an ancestor changed: order matters
            }
            if !is_prefix(&target, &keys, false) {
                continue;
            }
            if matches!(a[i], PatchOp::Test { .. }) {
                break;
            }
            // a[i] writes inside what `op` overwrites whole
            if matches!(a[i], PatchOp::Add { .. }) && keys.len() == target.len() {
                match op {
                    PatchOp::Remove { .. } => break, // the key may not have existed before the add
                    PatchOp::Replace { path, value } => next = PatchOp::Add { path: path.clone(), value: value.clone() },
                    _ => {}
                }
            }
            a.remove(i);
        }
        a.push(next);
    }
}

/// The path's keys when every segment is an object key; arrays shift indexes, so they never fold.
fn object_path(op: &PatchOp) -> Option<Vec<String>> {
    let keys = parse_pointer(op.path()).ok()?;
    if keys.is_empty() || keys.iter().any(|k| k == "-" || (!k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))) {
        return None;
    }
    Some(keys)
}

/// `p` is a prefix of `q` (strictly shorter when `strict`).
fn is_prefix(p: &[String], q: &[String], strict: bool) -> bool {
    if p.len() > q.len() || (strict && p.len() == q.len()) {
        return false;
    }
    p.iter().zip(q).all(|(a, b)| a == b)
}
