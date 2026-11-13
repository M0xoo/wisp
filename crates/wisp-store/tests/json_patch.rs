//! JSON Patch: diff and apply agree with `@wisp/protocol`'s json-patch.ts, op for op.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

use serde_json::Value;
use serde_json::json;
use wisp_store::json_patch::{PatchOp, apply, deep_equal, diff};

#[test]
fn diff_matches_the_typescript_twin() {
    assert_eq!(
        diff(&json!({"a": [1]}), &json!({"a": [1, 2, 3]})),
        vec![PatchOp::add(&["a", "-"], json!(2)), PatchOp::add(&["a", "-"], json!(3))]
    );
    assert_eq!(diff(&json!({"a": [1, 2]}), &json!({"a": [2]})), vec![PatchOp::replace(&["a"], json!([2]))]);
    assert_eq!(
        diff(&json!({"a": 1, "b": 2}), &json!({"b": 3, "c": 4})),
        vec![PatchOp::remove(&["a"]), PatchOp::replace(&["b"], json!(3)), PatchOp::add(&["c"], json!(4))]
    );
    assert_eq!(diff(&json!({"a/b~": 1}), &json!({"a/b~": 2})), vec![PatchOp::Replace { path: "/a~1b~0".into(), value: json!(2) }]);
    assert_eq!(diff(&json!({"n": 1}), &json!({"n": 1.0})), vec![]);
    assert_eq!(diff(&json!(1), &json!("x")), vec![PatchOp::Replace { path: String::new(), value: json!("x") }]);
}

#[test]
fn apply_follows_rfc_6902() {
    let doc = json!({"t": [1], "o": {"k": 1}});
    let out = apply(
        &doc,
        &[
            PatchOp::add(&["t", "-"], json!(2)),
            PatchOp::add(&["t", "0"], json!(0)),
            PatchOp::remove(&["o", "k"]),
            PatchOp::replace(&["n"], json!(5)),
        ],
    );
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
