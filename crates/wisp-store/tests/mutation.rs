//! Idempotent mutations (plan §4.5) and retention (plan §4.1), ported from mutation.test.ts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::unnecessary_wraps
)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use common::{open, open_with, options, session};
use serde_json::{Value, json};
use wisp_store::{
    Location, ManualClock, MutationResult, PatchOp, PruneResult, Retention, StoreError,
};

const DAY: i64 = 24 * 3600 * 1000;

#[tokio::test]
async fn a_mutation_runs_once_and_a_retry_gets_the_recorded_result() {
    let f = open();
    let runs = Arc::new(AtomicU32::new(0));
    let run = || {
        let runs = runs.clone();
        f.store.record_mutation("phone", "mid-1", move |w| {
            runs.fetch_add(1, Ordering::SeqCst);
            w.upsert("session", session("a"))?;
            Ok(json!({"id": "a"}))
        })
    };
    assert_eq!(
        run().await.unwrap(),
        MutationResult {
            result: json!({"id": "a"}),
            seq: 1,
            replayed: false
        }
    );
    assert_eq!(
        run().await.unwrap(),
        MutationResult {
            result: json!({"id": "a"}),
            seq: 1,
            replayed: true
        }
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(f.store.head_seq().unwrap(), 1, "the retry wrote nothing");
}

#[tokio::test]
async fn mids_are_per_client_a_unit_result_replays_and_seq_is_the_head_at_commit() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    let a = f
        .store
        .record_mutation("laptop", "m", |_| Ok(()))
        .await
        .unwrap();
    let b = f
        .store
        .record_mutation("phone", "m", |w| {
            Ok(
                w.patch("session", "a", &[PatchOp::replace(&["title"], json!("x"))])?["title"]
                    .clone(),
            )
        })
        .await
        .unwrap();
    assert_eq!((a.seq, a.replayed), (1, false));
    assert_eq!((b.result, b.seq), (json!("x"), 2));
    let again = f
        .store
        .record_mutation("laptop", "m", |_| Ok(Value::from("never")))
        .await
        .unwrap();
    assert_eq!(
        (again.result, again.seq, again.replayed),
        (Value::Null, 1, true)
    );
}

#[tokio::test]
async fn a_mutation_that_fails_records_nothing_so_a_retry_runs_it_again() {
    let f = open();
    let attempt = |fail: bool| {
        f.store.record_mutation("c", "m", move |w| {
            w.upsert("session", session("a"))?;
            if fail {
                return Err(StoreError::Internal("tunnel dropped".into()));
            }
            Ok("ok".to_owned())
        })
    };
    assert!(attempt(true).await.is_err());
    assert_eq!(f.store.get("session", "a").unwrap(), None);
    assert_eq!(
        attempt(false).await.unwrap(),
        MutationResult {
            result: "ok".into(),
            seq: 1,
            replayed: false
        }
    );
}

#[test]
fn a_mutation_inside_an_outer_transaction_that_rolls_back_is_forgotten_with_it() {
    let f = open();
    let out: Result<(), _> = f.store.write_blocking(|w| {
        w.mutation("c", "m", |_| Ok(1))?;
        Err(StoreError::Internal("outer".into()))
    });
    assert!(out.is_err());
    assert!(
        !f.store
            .write_blocking(|w| w.mutation("c", "m", |_| Ok(2)))
            .unwrap()
            .replayed
    );
}

#[tokio::test]
async fn retention_drops_changes_past_7_days_and_mutations_past_24_hours() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("old")))
        .await
        .unwrap();
    f.store
        .record_mutation("c", "old", |_| Ok(1))
        .await
        .unwrap();
    f.clock.advance(2 * DAY);
    f.store
        .write(|w| w.upsert("session", session("mid")))
        .await
        .unwrap();
    f.store
        .record_mutation("c", "new", |_| Ok(1))
        .await
        .unwrap();
    f.clock.advance(6 * DAY);
    f.store
        .write(|w| w.upsert("session", session("new")))
        .await
        .unwrap();
    assert_eq!(
        f.store.prune().await.unwrap(),
        PruneResult {
            changes: 1,
            mutations: 2
        }
    );
    let ids: Vec<_> = f
        .store
        .changes_since(0, None, 100)
        .unwrap()
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, vec!["mid", "new"]);
    assert_eq!(f.store.oldest_seq().unwrap(), 2);
    assert!(
        !f.store.can_resume(0).unwrap(),
        "a cursor before the oldest kept change must take a snapshot"
    );
    assert!(f.store.can_resume(1).unwrap());
    assert_eq!(f.store.changed_since("list", 0).unwrap(), None);
    assert!(
        !f.store
            .record_mutation("c", "old", |_| Ok(2))
            .await
            .unwrap()
            .replayed
    );
}

#[tokio::test]
async fn the_row_cap_wins_when_it_keeps_fewer_and_seqs_are_never_reused() {
    let clock = Arc::new(ManualClock::new(1_000_000));
    let mut o = options(Location::Memory, clock.clone());
    o.retention = Retention {
        change_rows: 3,
        ..wisp_store::DEFAULT_RETENTION
    };
    let f = open_with(o, clock, None);
    f.store
        .write(|w| {
            (0..10).try_for_each(|i| w.upsert("session", session(&format!("s{i}"))).map(|_| ()))
        })
        .await
        .unwrap();
    assert_eq!(
        f.store.prune().await.unwrap(),
        PruneResult {
            changes: 7,
            mutations: 0
        }
    );
    let seqs: Vec<_> = f
        .store
        .changes_since(0, None, 100)
        .unwrap()
        .into_iter()
        .map(|c| c.seq)
        .collect();
    assert_eq!(seqs, vec![8, 9, 10]);
    f.clock.advance(8 * DAY);
    f.store.prune().await.unwrap();
    assert_eq!(
        (f.store.head_seq().unwrap(), f.store.oldest_seq().unwrap()),
        (10, 11)
    );
    assert!(
        f.store.can_resume(10).unwrap(),
        "a client that saw everything still resumes"
    );
    f.store
        .write(|w| w.upsert("session", session("after")))
        .await
        .unwrap();
    assert_eq!(f.store.head_seq().unwrap(), 11);
}

#[tokio::test]
async fn pruned_changes_take_their_extra_topics_with_them() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    f.clock.advance(8 * DAY);
    f.store.prune().await.unwrap();
    f.store
        .write(|w| w.upsert("session", session("b")))
        .await
        .unwrap();
    assert!(
        f.store
            .changes_since(0, Some(&["session:a"]), 100)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.store.changes_since(0, Some(&["session:b"]), 100).unwrap()[0].topics,
        vec!["list", "session:b"]
    );
    let left: i64 = f
        .store
        .read(|r| {
            r.count("session", &wisp_store::Query::new())
                .map(|n| i64::try_from(n).unwrap_or(0))
        })
        .unwrap();
    assert_eq!(left, 2, "retention never touches entity rows");
}
