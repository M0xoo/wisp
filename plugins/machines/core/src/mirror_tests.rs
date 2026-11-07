use serde_json::json;

use super::*;

fn ops(v: Value) -> Vec<EntityOp> {
    serde_json::from_value(v).unwrap_or_default()
}

fn rows(v: Value) -> Vec<Row> {
    serde_json::from_value(v).unwrap_or_default()
}

#[test]
fn a_snapshot_replaces_and_touches_only_what_differs() {
    let mut m = Mirror::new();
    let t = m.snapshot("p", &Topic::list(), rows(json!([{"e": "session", "id": "a", "v": {"t": 1}}, {"e": "session", "id": "b", "v": {"t": 2}}])));
    assert_eq!(t.len(), 2);
    m.take_dirty();
    let t = m.snapshot("p", &Topic::list(), rows(json!([{"e": "session", "id": "a", "v": {"t": 1}}, {"e": "session", "id": "c", "v": {"t": 3}}])));
    assert_eq!(t, [Touched { peer: "p".into(), op: RemoteOp::Del, id: "b".into() }, Touched { peer: "p".into(), op: RemoteOp::Upsert, id: "c".into() }]);
    let d = m.take_dirty();
    assert_eq!(d, [("p".into(), "session".into(), "b".into(), None), ("p".into(), "session".into(), "c".into(), Some(json!({"t": 3})))]);
    assert!(m.take_dirty().is_empty(), "one write per flush, not one per change");
}

#[test]
fn ops_apply_in_order_and_a_patch_that_misses_drifts_the_topic() {
    let mut m = Mirror::new();
    let (t, drift) = m.apply("p", ops(json!([
        {"topic": "list", "e": "session", "id": "a", "op": "upsert", "v": {"state": "running", "n": 1}},
        {"topic": "list", "e": "session", "id": "a", "op": "patch", "ops": [{"op": "replace", "path": "/n", "value": 2}]},
        {"topic": "list", "e": "session", "id": "zz", "op": "patch", "ops": [{"op": "replace", "path": "/n", "value": 2}]},
        {"topic": "session:a", "e": "event", "id": "e1", "op": "append", "v": [1]},
        {"topic": "session:a", "e": "event", "id": "e1", "op": "append", "v": [2]}
    ])));
    assert_eq!(t.len(), 2);
    assert_eq!(drift, [Topic::list()]);
    assert_eq!(m.get("p", "session", "a"), Some(&json!({"state": "running", "n": 2})));
    assert_eq!(m.working("p"), 1);
    let (t, _) = m.apply("p", ops(json!([{"topic": "list", "e": "session", "id": "a", "op": "del"}])));
    assert_eq!(t[0].op, RemoteOp::Del);
    assert_eq!(m.len("p"), 0);
}

#[test]
fn the_relay_puts_rows_and_a_reset_drops_a_peer() {
    let mut m = Mirror::new();
    m.put("m1", "s1", json!({"id": "s1"}));
    m.put("m2", "s9", json!({"id": "s9"}));
    assert_eq!(m.rows(Some("m1")).len(), 1);
    assert_eq!(m.rows(None).len(), 2);
    assert!(m.del("m1", "nope").is_none());
    let gone = m.reset("m1");
    assert_eq!(gone.len(), 1);
    assert!(m.rows(Some("m1")).is_empty());
    m.load("m3", "session", "x", json!({}));
    assert_eq!(m.len("m3"), 1);
    assert!(!m.is_empty());
}
