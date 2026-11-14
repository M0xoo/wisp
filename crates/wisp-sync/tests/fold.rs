//! Folding is an optimisation, never a change of meaning: on random histories, the folded ops have
//! the same effect as the history (the TS reference's fold.test.ts).
// tests may panic, and their helpers trade pedantry for reading like the TS twins
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::missing_panics_doc,
    clippy::assert_is_empty,
    clippy::doc_markdown,
    clippy::type_complexity,
    clippy::range_plus_one,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::collapsible_if,
    clippy::semicolon_if_nothing_returned
)]

mod support;

use serde_json::{Map, Value, json};
use support::{EntityMap, Rng, apply_entity_ops, topic};
use wisp_protocol::{Change, EntityOp, PatchOp, diff};
use wisp_sync::{compose, fold};

fn op(change: Change) -> EntityOp {
    EntityOp { topic: topic("list"), e: "row".into(), id: "r1".into(), change }
}

fn obj(r: &mut Rng, depth: u32) -> Value {
    let mut out = Map::new();
    for k in ["a", "b", "c", "d/e", "0"] {
        let x = r.next();
        if x < 0.3 {
            continue;
        }
        let v = if x < 0.5 && depth < 2 {
            obj(r, depth + 1)
        } else if x < 0.65 {
            Value::Array((0..r.below(3)).map(|i| json!(i)).collect())
        } else {
            json!(r.below(4))
        };
        out.insert(k.into(), v);
    }
    Value::Object(out)
}

/// A random history for one entity, valid against the true state at every step.
fn history(r: &mut Rng, n: usize) -> Vec<EntityOp> {
    let (mut ops, mut cur, mut list): (Vec<EntityOp>, Option<Value>, Option<Vec<Value>>) = (vec![], None, None);
    for i in 0..n {
        let k = r.next();
        if k < 0.15 {
            ops.push(op(Change::Del));
            (cur, list) = (None, None);
        } else if k < 0.3 || (cur.is_none() && list.is_none()) {
            if r.next() < 0.3 {
                list = Some(vec![json!(i)]);
                cur = None;
                ops.push(op(Change::Upsert { v: json!([i]) }));
            } else {
                let v = obj(r, 0);
                (cur, list) = (Some(v.clone()), None);
                ops.push(op(Change::Upsert { v }));
            }
        } else if let Some(l) = &mut list {
            let add: Vec<Value> = [json!(i), json!(i + 1)][..1 + r.below(2)].to_vec();
            l.extend(add.iter().cloned());
            ops.push(op(Change::Append { v: add }));
        } else if let Some(c) = &cur {
            let next = obj(r, 0);
            let p = diff(c, &next);
            if p.is_empty() {
                continue;
            }
            ops.push(op(Change::Patch { ops: p }));
            cur = Some(next);
        }
    }
    ops
}

fn apply(ops: &[EntityOp], start: Option<EntityMap>) -> EntityMap {
    let mut m = start.unwrap_or_default();
    assert!(apply_entity_ops(&mut m, ops).is_empty(), "{ops:?}");
    m
}

#[test]
fn folding_a_history_one_op_at_a_time_has_the_same_effect_as_the_history() {
    let mut r = Rng::new(5);
    let (mut total, mut folded) = (0, 0);
    for _ in 0..3000 {
        let n = 1 + r.below(12);
        let h = history(&mut r, n);
        let mut queued: Vec<EntityOp> = vec![];
        for o in &h {
            queued = fold(&queued, o);
        }
        assert_eq!(apply(&queued, None), apply(&h, None));
        total += h.len();
        folded += queued.len();
    }
    assert!(folded < total / 2, "folding should at least halve the ops ({folded} of {total})");
}

#[test]
fn folding_after_the_client_already_holds_a_value_is_still_equal() {
    let mut r = Rng::new(11);
    for _ in 0..2000 {
        let n = 2 + r.below(10);
        let h = history(&mut r, n);
        let split = 1 + r.below(h.len() - 1);
        let base = apply(&h[..split], None);
        let mut queued: Vec<EntityOp> = vec![];
        for o in &h[split..] {
            queued = fold(&queued, o);
        }
        assert_eq!(apply(&queued, Some(base.clone())), apply(&h[split..], Some(base)));
    }
}

#[test]
fn the_rules_by_name() {
    let up = |v: Value| op(Change::Upsert { v });
    let patch = |ops: Vec<PatchOp>| op(Change::Patch { ops });
    let app = |v: Vec<Value>| op(Change::Append { v });
    let rep = |p: &str, v: Value| PatchOp::Replace { path: p.into(), value: v };
    assert_eq!(fold(&[patch(vec![rep("/a", json!(1))])], &up(json!({"a": 2}))), vec![up(json!({"a": 2}))], "upsert wins");
    assert_eq!(fold(&[up(json!({"a": 1})), app(vec![json!(1)])], &op(Change::Del)), vec![op(Change::Del)], "a del drops what was queued");
    assert_eq!(fold(&[app(vec![json!(1)])], &app(vec![json!(2), json!(3)])), vec![app(vec![json!(1), json!(2), json!(3)])], "appends join");
    assert_eq!(fold(&[up(json!([1]))], &app(vec![json!(2)])), vec![up(json!([1, 2]))], "an append onto a queued list");
    assert_eq!(fold(&[up(json!({"a": 1}))], &patch(vec![rep("/a", json!(2))])), vec![up(json!({"a": 2}))], "a patch folds into an upsert");
    assert_eq!(
        fold(&[patch(vec![rep("/live", json!("Reading"))])], &patch(vec![rep("/live", json!("Editing"))])),
        vec![patch(vec![rep("/live", json!("Editing"))])],
        "a newer value replaces an older one"
    );
    let bad = patch(vec![PatchOp::Remove { path: "/nope".into() }]);
    assert_eq!(
        fold(&[up(json!({}))], &bad),
        vec![up(json!({})), bad.clone()],
        "a patch that doesn't apply stays, for the client to report"
    );
}

#[test]
fn compose_keeps_order_where_it_matters() {
    let add = PatchOp::Add { path: "/x".into(), value: json!(1) };
    let run = |a: &[PatchOp], b: &[PatchOp]| {
        let mut out = a.to_vec();
        compose(&mut out, b);
        out
    };
    let rm = |p: &str| PatchOp::Remove { path: p.into() };
    let rep = |p: &str, v: Value| PatchOp::Replace { path: p.into(), value: v };
    // the key may not have existed before the add: the remove can't stand alone
    assert_eq!(run(std::slice::from_ref(&add), &[rm("/x")]), vec![add.clone(), rm("/x")]);
    // an add then a replace of the same key is one add
    assert_eq!(run(&[add], &[rep("/x", json!(2))]), vec![PatchOp::Add { path: "/x".into(), value: json!(2) }]);
    // array indexes shift: never folded
    assert_eq!(run(&[PatchOp::Add { path: "/l/0".into(), value: json!(1) }], &[rep("/l/0", json!(2))]).len(), 2);
    // a parent replaced in between: the child op stays behind it
    let seq = vec![rep("/a/b", json!(1)), rep("/a", json!({"b": 0}))];
    let mut want = seq.clone();
    want.push(rep("/a/b", json!(2)));
    assert_eq!(run(&seq, &[rep("/a/b", json!(2))]), want);
    // a whole object replaced drops the writes inside it
    assert_eq!(
        run(&[rep("/a/b", json!(1)), PatchOp::Add { path: "/a/c/-".into(), value: json!(1) }], &[rep("/a", json!(3))]),
        vec![rep("/a", json!(3))]
    );
}
