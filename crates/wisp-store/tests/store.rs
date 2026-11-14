//! The write path, the change feed, queries, topics, built-in kinds, meta and the epoch (ported from the
//! TypeScript reference's store.test.ts, one test per behaviour).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty, clippy::unnecessary_wraps)]

mod common;

use std::sync::{Arc, Mutex};

use common::{EVENT, SESSION, event, ids, open, open_disk, session, session_with};
use serde_json::{Value, json};
use wisp_kernel::Code;
use wisp_store::{ChangeOp, ChangeRow, Col, Cond, EntityDef, PatchOp, Query, Row, StoreError, row};

fn heard(store: &wisp_store::Store) -> (Arc<Mutex<Vec<Vec<ChangeRow>>>>, wisp_store::Subscription) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let sub = store.on_commit(move |c| s.lock().unwrap().push(c.to_vec()));
    (seen, sub)
}

#[test]
fn upsert_of_a_new_row_writes_it_and_an_upsert_change_on_every_topic() {
    let f = open();
    let (seen, _sub) = heard(&f.store);
    let row = f.store.write_blocking(|w| w.upsert("session", session_with("a", json!({"extra": {"tags": ["x"]}})))).unwrap();
    assert_eq!(f.store.get("session", "a").unwrap(), Some(row.clone()));
    assert_eq!(row["extra"], json!({"tags": ["x"]}));
    assert_eq!(row["archived"], json!(false));
    let feed = f.store.changes_since(0, None, 100).unwrap();
    let c = &feed[0];
    assert_eq!((c.op, c.topic.as_str()), (ChangeOp::Upsert, "list"));
    assert_eq!(c.topics, vec!["list", "session:a"]);
    assert_eq!(c.patch, Value::Object(row));
    assert_eq!(*seen.lock().unwrap(), vec![feed.clone()]);
}

#[test]
fn upsert_of_an_existing_row_records_the_diff_and_an_identical_upsert_nothing() {
    let f = open();
    f.store.write_blocking(|w| w.upsert("session", session("a"))).unwrap();
    f.store.write_blocking(|w| w.upsert("session", row!({"id": "a", "title": "renamed"}))).unwrap();
    f.store.write_blocking(|w| w.upsert("session", session_with("a", json!({"title": "renamed"})))).unwrap();
    let feed = f.store.changes_since(0, None, 100).unwrap();
    assert_eq!(feed.len(), 2);
    assert_eq!(feed[1].op, ChangeOp::Patch);
    assert_eq!(feed[1].patch, json!([{"op": "replace", "path": "/title", "value": "renamed"}]));
    assert_eq!(f.store.get("session", "a").unwrap().unwrap()["state"], json!("idle"), "columns left out keep their value");
}

#[test]
fn patch_applies_ops_inside_json_columns_and_records_the_net_diff_in_column_order() {
    let f = open();
    f.store.write_blocking(|w| w.upsert("session", session_with("a", json!({"extra": {"tags": []}})))).unwrap();
    let next = f
        .store
        .write_blocking(|w| {
            w.patch(
                "session",
                "a",
                &[
                    PatchOp::add(&["extra", "tags", "-"], json!("x")),
                    PatchOp::replace(&["title"], json!("one")),
                    PatchOp::replace(&["title"], json!("two")),
                ],
            )
        })
        .unwrap();
    assert_eq!(next["extra"], json!({"tags": ["x"]}));
    assert_eq!(next["title"], json!("two"));
    let c = &f.store.changes_since(1, None, 100).unwrap()[0];
    assert_eq!(c.patch, json!([{"op": "replace", "path": "/title", "value": "two"}, {"op": "add", "path": "/extra/tags/-", "value": "x"}]));
}

fn code(r: Result<impl Sized, StoreError>) -> Code {
    r.err().map_or(Code::Internal, |e| e.code())
}

#[test]
fn patch_refuses_a_missing_row_a_key_change_an_unknown_column_and_a_failed_test() {
    let f = open();
    f.store.write_blocking(|w| w.upsert("session", session("a"))).unwrap();
    let s = &f.store;
    assert_eq!(code(s.write_blocking(|w| w.patch("session", "zz", &[PatchOp::replace(&["title"], json!("x"))]))), Code::NotFound);
    assert_eq!(code(s.write_blocking(|w| w.patch("session", "a", &[PatchOp::replace(&["id"], json!("b"))]))), Code::Invalid);
    assert_eq!(code(s.write_blocking(|w| w.patch("session", "a", &[PatchOp::add(&["nope"], json!(1))]))), Code::Invalid);
    assert_eq!(
        code(s.write_blocking(|w| w.patch("session", "a", &[PatchOp::Test { path: "/title".into(), value: json!("other") }]))),
        Code::Invalid
    );
    assert_eq!(code(s.write_blocking(|w| w.upsert("session", row!({"id": "b", "bogus": 1})))), Code::Invalid);
    assert_eq!(code(s.write_blocking(|w| w.upsert("session", row!({"id": "b", "archived": "yes"})))), Code::Invalid);
    assert_eq!(code(s.write_blocking(|w| w.upsert("session", row!({"id": "b", "updated_at": 1.5})))), Code::Invalid);
    assert_eq!(s.head_seq().unwrap(), 1);
}

#[test]
fn del_removes_the_row_and_records_a_del_on_the_old_rows_topics_and_a_second_del_is_a_no_op() {
    let f = open();
    f.store.write_blocking(|w| w.upsert("session", session("a"))).unwrap();
    assert!(f.store.write_blocking(|w| w.del("session", "a")).unwrap());
    assert!(!f.store.write_blocking(|w| w.del("session", "a")).unwrap());
    assert_eq!(f.store.get("session", "a").unwrap(), None);
    let del = f.store.changes_since(1, None, 100).unwrap();
    assert_eq!(del.len(), 1);
    assert_eq!((del[0].op, &del[0].patch, &del[0].topics), (ChangeOp::Del, &Value::Null, &vec!["list".to_owned(), "session:a".to_owned()]));
}

#[test]
fn append_fills_in_integer_keys_and_groups_a_batch_under_its_parent() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session("a"))?;
            w.upsert("session", session("b"))
        })
        .unwrap();
    let rows = f
        .store
        .write_blocking(|w| {
            w.append(
                "event",
                vec![event("a", 1, "text", json!({"t": "hi"})), event("b", 1, "text", Value::Null), event("a", 2, "tool", json!({"n": 1}))],
            )
        })
        .unwrap();
    assert_eq!(ids(&rows), vec!["1", "2", "3"]);
    let feed = f.store.changes_since(2, None, 100).unwrap();
    let shape: Vec<_> = feed.iter().map(|c| (c.op, c.id.clone(), c.patch.as_array().map_or(0, Vec::len))).collect();
    assert_eq!(shape, vec![(ChangeOp::Append, "a".into(), 2), (ChangeOp::Append, "b".into(), 1)]);
    assert_eq!(f.store.get("event", 3).unwrap().unwrap()["body"], json!({"n": 1}));
    assert_eq!(f.store.get("event", "3").unwrap().unwrap()["body"], json!({"n": 1}), "an int key given as text");
}

#[test]
fn a_duplicate_append_is_a_conflict_and_rolls_back_the_whole_batch() {
    let f = open();
    f.store.write_blocking(|w| w.upsert("session", session("a"))).unwrap();
    f.store.write_blocking(|w| w.append("event", vec![event("a", 1, "x", Value::Null)])).unwrap();
    let err =
        f.store.write_blocking(|w| w.append("event", vec![event("a", 2, "x", Value::Null), event("a", 1, "x", Value::Null)])).unwrap_err();
    assert_eq!(err.code(), Code::Conflict);
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 1);
    assert_eq!(f.store.head_seq().unwrap(), 2);
}

#[test]
fn crash_safety_an_error_mid_tx_leaves_no_rows_no_change_and_publishes_nothing() {
    let f = open();
    let (seen, _sub) = heard(&f.store);
    let out: Result<(), _> = f.store.write_blocking(|w| {
        w.upsert("session", session("a"))?;
        w.append("event", vec![event("a", 1, "x", Value::Null)])?;
        Err(StoreError::Internal("harness died".into()))
    });
    assert!(out.is_err());
    assert_eq!(f.store.get("session", "a").unwrap(), None);
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 0);
    assert_eq!(f.store.changes_since(0, None, 100).unwrap(), vec![]);
    assert_eq!(f.store.head_seq().unwrap(), 0);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn a_panic_mid_tx_rolls_back_and_the_writer_keeps_working() {
    let f = open();
    let out: Result<(), _> = f.store.write_blocking(|w| {
        w.upsert("session", session("a"))?;
        panic!("a bug in a plugin");
    });
    assert_eq!(out.unwrap_err().code(), Code::Internal);
    assert_eq!(f.store.get("session", "a").unwrap(), None);
    f.store.write_blocking(|w| w.upsert("session", session("b"))).unwrap();
    assert_eq!(f.store.head_seq().unwrap(), 1);
}

#[test]
fn a_failed_op_dooms_the_transaction_even_when_the_closure_swallows_the_error() {
    let f = open();
    let (seen, _sub) = heard(&f.store);
    let out = f.store.write_blocking(|w| {
        w.upsert("session", session("c"))?;
        let _ignored = w.patch("session", "ghost", &[PatchOp::replace(&["title"], json!("x"))]);
        assert!(w.upsert("session", session("d")).is_err(), "later ops refuse");
        Ok(())
    });
    assert!(out.unwrap_err().to_string().contains("rolled back"));
    assert_eq!(f.store.get("session", "c").unwrap(), None);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn reads_through_the_store_inside_a_write_are_refused() {
    let f = open();
    let store = f.store.clone();
    let out = f.store.write_blocking(move |w| {
        w.upsert("session", session("a"))?;
        assert!(store.get("session", "a").is_err());
        Ok(w.get("session", "a")?.is_some())
    });
    assert!(out.unwrap(), "the writer sees its own uncommitted row");
}

#[test]
fn a_panicking_listener_is_contained_and_the_others_still_hear_the_commit() {
    let f = open();
    let _bad = f.store.on_commit(|_| panic!("bad listener"));
    let (seen, sub) = heard(&f.store);
    f.store.write_blocking(|w| w.upsert("session", session("a"))).unwrap();
    drop(sub);
    f.store.write_blocking(|w| w.upsert("session", session("b"))).unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1, "a dropped subscription hears nothing more");
}

#[test]
fn query_where_order_limit_offset_with_names_checked_and_values_bound() {
    let f = open();
    f.store
        .write_blocking(|w| {
            for i in 0..10 {
                w.upsert(
                    "session",
                    session_with(
                        &format!("s{i}"),
                        json!({"archived": i % 3 == 0, "updated_at": i, "state": if i == 4 { Value::Null } else { json!("idle") }}),
                    ),
                )?;
            }
            Ok(())
        })
        .unwrap();
    let q = |q: Query| ids(&f.store.query("session", &q).unwrap());
    assert_eq!(q(Query::new().eq("archived", false).desc("updated_at").limit(3)), vec!["s8", "s7", "s5"]);
    assert_eq!(q(Query::new().cond("updated_at", Cond::Gte(json!(2))).cond("updated_at", Cond::Lt(json!(4))).asc("id")), vec!["s2", "s3"]);
    assert_eq!(q(Query::new().any_of("id", vec![json!("s1"), json!("s2"), json!("x' OR 1=1 --")]).asc("id")), vec!["s1", "s2"]);
    assert_eq!(q(Query::new().eq("state", Value::Null)), vec!["s4"]);
    assert_eq!(q(Query::new().cond("state", Cond::NotNull)).len(), 9);
    assert_eq!(q(Query::new().cond("title", Cond::Like("task s1%".into()))), vec!["s1"]);
    assert!(q(Query::new().any_of("id", vec![])).is_empty());
    assert_eq!(q(Query::new().asc("updated_at").limit(2).offset(8)), vec!["s8", "s9"]);
    assert_eq!(f.store.count("session", &Query::new().eq("archived", true)).unwrap(), 4);
    assert!(f.store.query("session", &Query::new().eq("id; DROP TABLE t_session", 1)).unwrap_err().to_string().contains("unknown column"));
    assert!(f.store.query("session", &Query::new().asc("nope")).unwrap_err().to_string().contains("unknown column"));
    assert!(f.store.query("session", &Query::new().offset(1)).is_err(), "offset needs a limit");
}

#[test]
fn query_select_reads_and_decodes_only_the_columns_asked_for() {
    let f = open();
    f.store
        .write_blocking(|w| w.upsert("session", session_with("a", json!({"archived": true, "extra": {"big": "x".repeat(1000)}}))))
        .unwrap();
    let rows = f.store.query("session", &Query::new().select(&["id", "archived"]).eq("archived", true)).unwrap();
    assert_eq!(rows, vec![row!({"id": "a", "archived": true})]);
    assert!(f.store.query("session", &Query::new().select(&["id", "nope"])).is_err());
}

#[test]
fn changes_since_filters_by_topic_delivers_a_two_topic_change_once_and_pages() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session("a"))?;
            w.upsert("session", session("b"))?;
            w.append("event", vec![event("a", 1, "x", Value::Null)])
        })
        .unwrap();
    let seqs = |since, topics: Option<&[&str]>, limit| {
        f.store.changes_since(since, topics, limit).unwrap().iter().map(|c| c.seq).collect::<Vec<_>>()
    };
    assert_eq!(seqs(0, Some(&["session:a"]), 100), vec![1, 3]);
    assert_eq!(seqs(0, Some(&["list", "session:a"]), 100), vec![1, 2, 3]);
    assert_eq!(seqs(0, None, 2), vec![1, 2]);
    assert!(seqs(0, Some(&[]), 100).is_empty());
    assert!(seqs(3, None, 100).is_empty());
    assert_eq!(f.store.changes_since(0, Some(&["session:b"]), 100).unwrap()[0].topics, vec!["list", "session:b"]);
    assert!(f.store.changes_since(-1, None, 100).is_err());
    assert!(f.store.changes_since(0, None, 0).is_err());
}

fn no_topics(_: &Row) -> Vec<String> {
    Vec::new()
}
fn bad_topic(_: &Row) -> Vec<String> {
    vec!["nope".into()]
}
const BARE: EntityDef = EntityDef {
    kind: "bad",
    table: "t_session",
    key: "id",
    columns: &[("id", Col::Text)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics: no_topics,
};

#[test]
fn topics_are_validated_none_or_a_malformed_one_is_refused() {
    let f = open();
    f.store.define_entity(BARE).unwrap();
    f.store.define_entity(EntityDef { kind: "worse", topics: bad_topic, ..BARE }).unwrap();
    assert!(f.store.write_blocking(|w| w.upsert("bad", row!({"id": "x"}))).unwrap_err().to_string().contains("at least one topic"));
    assert!(f.store.write_blocking(|w| w.upsert("worse", row!({"id": "x"}))).unwrap_err().to_string().contains("bad topic"));
    assert_eq!(f.store.get("session", "x").unwrap(), None);
}

#[test]
fn entity_definitions_are_checked_and_a_kind_cannot_be_registered_twice() {
    let f = open();
    let err = |d: EntityDef| f.store.define_entity(d).unwrap_err().to_string();
    assert!(err(EntityDef { kind: "Bad Kind", ..BARE }).contains("bad entity kind"));
    assert!(err(EntityDef { kind: "k", table: "t; drop", ..BARE }).contains("bad table"));
    assert!(err(EntityDef { kind: "k", key: "nope", ..BARE }).contains("not a column"));
    assert!(err(EntityDef { kind: "k", columns: &[("id", Col::Int)], json_columns: &["id"], ..BARE }).contains("json column must be text"));
    assert!(err(EntityDef { kind: "session", ..BARE }).contains("already registered"));
    f.store.define_entity(SESSION).unwrap(); // the same definition again is fine
    assert!(f.store.get("ghost", "x").unwrap_err().to_string().contains("unknown entity kind"));
}

#[test]
fn built_in_setting_and_plugin_kinds_write_the_kernel_tables_on_the_config_topic() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("setting", row!({"key": "claude.model", "value": {"name": "opus"}, "locked_by": null}))?;
            w.upsert("plugin", row!({"id": "wisp.claude", "version": "1.0.0", "enabled": true, "config": {}, "grants": ["proc"]}))
        })
        .unwrap();
    assert_eq!(f.store.get("setting", "claude.model").unwrap().unwrap()["value"], json!({"name": "opus"}));
    assert_eq!(f.store.get("plugin", "wisp.claude").unwrap().unwrap()["enabled"], json!(true));
    let topics: Vec<_> = f.store.changes_since(0, None, 100).unwrap().into_iter().map(|c| c.topic).collect();
    assert_eq!(topics, vec!["config", "config"]);
}

#[tokio::test]
async fn meta_keeps_owners_bookkeeping_and_refuses_store_managed_keys() {
    let f = open();
    f.store.set_meta("import:x", Some("1")).await.unwrap();
    assert_eq!(f.store.get_meta("import:x").unwrap().as_deref(), Some("1"));
    f.store.set_meta("import:x", None).await.unwrap();
    assert_eq!(f.store.get_meta("import:x").unwrap(), None);
    assert!(f.store.set_meta("epoch", Some("mine")).await.unwrap_err().to_string().contains("belongs to the store"));
    assert!(f.store.set_meta("schema:test", Some("9")).await.is_err());
}

#[tokio::test]
async fn the_epoch_is_made_once_kept_across_reopen_and_fresh_on_rotate() {
    let f = open_disk(None);
    assert_eq!(f.store.epoch(), "epoch-1");
    let home = f.home.clone();
    f.store.close();
    let clock = Arc::new(wisp_store::ManualClock::new(0));
    let mut o = common::options(wisp_store::Location::Path(home.clone().unwrap().join("wisp.db")), clock.clone());
    o.epoch = Arc::new(|| "epoch-new".to_owned());
    let g = common::open_with(o, clock, home);
    assert_eq!(g.store.epoch(), "epoch-1", "reopening keeps it");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let h = heard.clone();
    let _sub = g.store.on_epoch(move |e| h.lock().unwrap().push(e.to_owned()));
    assert_eq!(g.store.rotate_epoch().await.unwrap(), "epoch-new");
    assert_eq!(g.store.epoch(), "epoch-new");
    assert_eq!(g.store.get_meta("epoch").unwrap().as_deref(), Some("epoch-new"));
    assert_eq!(*heard.lock().unwrap(), vec!["epoch-new"]);
}

#[test]
fn a_file_store_runs_in_wal_with_foreign_keys_on() {
    let f = open_disk(None);
    f.store.write_blocking(|w| w.upsert("setting", row!({"key": "k", "value": 1, "locked_by": null}))).unwrap();
    assert!(f.home.as_ref().unwrap().join("wisp.db-wal").exists());
    let err = f.store.write_blocking(|w| w.append("event", vec![event("ghost", 1, "x", Value::Null)])).unwrap_err();
    assert_eq!(err.code(), Code::Conflict);
}

#[test]
fn head_and_oldest_seq_and_whether_a_cursor_can_resume() {
    let f = open();
    assert_eq!((f.store.head_seq().unwrap(), f.store.oldest_seq().unwrap()), (0, 1));
    assert!(f.store.can_resume(0).unwrap());
    f.store.write_blocking(|w| ["a", "b", "c"].iter().try_for_each(|id| w.upsert("session", session(id)).map(|_| ()))).unwrap();
    assert_eq!((f.store.head_seq().unwrap(), f.store.oldest_seq().unwrap()), (3, 1));
    assert!(f.store.can_resume(0).unwrap());
    assert!(!f.store.can_resume(4).unwrap(), "a cursor from the future (another epoch)");
}

#[test]
fn window_pages_an_event_log_newest_first_before_a_seq() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session("a"))?;
            w.upsert("session", session("b"))?;
            w.append("event", (0..10).map(|i| event("a", i, "x", json!({"i": i}))).collect())?;
            w.append("event", vec![event("b", 0, "x", Value::Null)])
        })
        .unwrap();
    let seqs =
        |before, limit| f.store.window("event", "a", before, limit).unwrap().iter().map(|r| r["seq"].as_i64().unwrap()).collect::<Vec<_>>();
    assert_eq!(seqs(None, 3), vec![9, 8, 7]);
    assert_eq!(seqs(Some(7), 3), vec![6, 5, 4]);
    assert_eq!(seqs(Some(2), 10), vec![1, 0]);
    assert!(seqs(Some(0), 10).is_empty());
    assert!(f.store.window("session", "a", None, 10).is_err(), "only an event log has a window");
}

#[test]
fn changed_since_returns_current_rows_and_deletions_or_none_past_retention() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session("a"))?;
            w.upsert("session", session("b"))?;
            w.upsert("session", session("c"))
        })
        .unwrap();
    let cursor = f.store.head_seq().unwrap();
    f.store
        .write_blocking(|w| {
            w.patch("session", "a", &[PatchOp::replace(&["title"], json!("one"))])?;
            w.patch("session", "a", &[PatchOp::replace(&["title"], json!("two"))])?;
            w.del("session", "b")?;
            w.append("event", vec![event("c", 0, "x", Value::Null)])
        })
        .unwrap();
    let d = f.store.changed_since("list", cursor).unwrap().unwrap();
    assert_eq!(d.rows.len(), 1);
    assert_eq!((d.rows[0].0.as_str(), &d.rows[0].1["title"]), ("session", &json!("two")));
    assert_eq!(d.deleted, vec![("session".to_owned(), "b".to_owned())]);
    assert_eq!(d.head, f.store.head_seq().unwrap());
    let s = f.store.changed_since("session:c", cursor).unwrap().unwrap();
    assert_eq!(s.rows.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec!["event"]);
    assert_eq!(f.store.changed_since("list", 99).unwrap(), None, "a cursor from the future");
}

#[tokio::test]
async fn async_write_and_read_from_a_runtime() {
    let f = open_disk(None);
    let n = f.store.write(|w| w.upsert("session", session("a")).map(|_| 1)).await.unwrap();
    assert_eq!(n, 1);
    let got = f.store.read_async(|r| r.get("session", "a")).await.unwrap();
    assert_eq!(got.unwrap()["title"], json!("task a"));
    assert_eq!(f.store.get("event", 1).unwrap(), None);
    let _ = EVENT;
}

#[test]
fn close_refuses_later_writes() {
    let f = open();
    f.store.close();
    assert!(matches!(f.store.write_blocking(|w| w.upsert("session", session("a"))), Err(StoreError::Closed)));
}

#[test]
fn query_json_is_the_query_as_json_text() {
    let f = open();
    f.store
        .write_blocking(|w| {
            w.upsert("session", session_with("a", json!({"title": "quote \" and \\ é", "extra": {"n": 1.5, "t": [true]}})))?;
            w.upsert("session", session_with("b", json!({"archived": true, "state": null})))
        })
        .unwrap();
    for q in [Query::new().asc("id"), Query::new().select(&["id", "archived", "extra"]).desc("id"), Query::new().eq("id", "zz")] {
        let text = f.store.query_json("session", &q).unwrap();
        let rows: Vec<Value> = f.store.query("session", &q).unwrap().into_iter().map(Value::Object).collect();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), Value::Array(rows), "{text}");
    }
}

/// A column is named as the wire names the field (`usedAt`), so a plugin's rows reach the UI flat with no
/// renaming; two names that differ only in case are one column to SQLite and are refused.
#[test]
fn camel_case_columns_keep_the_wire_names_and_a_case_twin_is_refused() {
    fn topics(_: &Row) -> Vec<String> {
        vec!["plugin:x:y".into()]
    }
    let f = open();
    f.store
        .migrate(
            "x",
            &[wisp_store::Migration::sql(1, "CREATE TABLE x_item (id TEXT PRIMARY KEY, usedAt INTEGER NOT NULL, signedIn TEXT) STRICT;")],
        )
        .unwrap();
    let def = EntityDef {
        kind: "x.item",
        table: "x_item",
        key: "id",
        columns: &[("id", Col::Text), ("usedAt", Col::Int), ("signedIn", Col::Text)],
        json_columns: &["signedIn"],
        parent: None,
        seq: None,
        topics,
    };
    f.store.define_entity(def).unwrap();
    f.store.write_blocking(|w| w.upsert("x.item", row!({ "id": "a", "usedAt": 5, "signedIn": { "at": 1 } }))).unwrap();
    let r = f.store.get("x.item", "a").unwrap().unwrap();
    assert_eq!(r["usedAt"], 5);
    assert_eq!(r["signedIn"]["at"], 1);
    let twin =
        EntityDef { kind: "x.twin", columns: &[("id", Col::Text), ("usedAt", Col::Int), ("usedat", Col::Int)], json_columns: &[], ..def };
    assert_eq!(code(f.store.define_entity(twin)), Code::Invalid);
}
