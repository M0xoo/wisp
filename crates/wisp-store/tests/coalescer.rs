//! Coalescing with a fake clock: commits 250 ms after the first write, per step, one tx (coalescer.test.ts).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::unnecessary_wraps
)]

mod common;

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{event, open, session, session_with};
use serde_json::json;
use wisp_store::{Buffered, Coalescer, CoalescerOptions, PatchOp, Query, Subscription};

/// Every commit's size, sent from the listener; waits are bounded in real time, never polled.
fn commits(
    store: &wisp_store::Store,
) -> (tokio::sync::mpsc::UnboundedReceiver<usize>, Subscription) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let sub = store.on_commit(move |c| {
        let _ = tx.send(c.len());
    });
    (rx, sub)
}

async fn next_commit(rx: &mut tokio::sync::mpsc::UnboundedReceiver<usize>) -> usize {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("a commit")
        .expect("open channel")
}

#[tokio::test]
async fn appends_and_patches_commit_together_250_ms_after_the_first_as_one_tx() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session_with("a", json!({"title": ""}))))
        .await
        .unwrap();
    let (mut rx, _sub) = commits(&f.store);
    let c = Coalescer::new(&f.store, CoalescerOptions::default());
    let mut text = String::new();
    for i in 0..20 {
        let _ = write!(text, "t{i}");
        c.patch(
            "session",
            "a",
            vec![PatchOp::replace(&["title"], json!(text))],
        )
        .unwrap();
        c.append("event", vec![event("a", i, "delta", json!({"i": i}))])
            .unwrap();
        f.clock.advance(10);
    }
    assert_eq!(f.clock.pending(), 1, "one timer for the whole burst");
    f.clock.advance(49);
    tokio::task::yield_now().await;
    assert!(rx.try_recv().is_err(), "nothing before 250 ms");
    assert_eq!(c.len(), 2);
    f.clock.advance(1);
    assert_eq!(
        next_commit(&mut rx).await,
        2,
        "one patch change (net diff) and one append change"
    );
    assert_eq!(
        f.store.get("session", "a").unwrap().unwrap()["title"],
        json!(text)
    );
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 20);
    let feed = f.store.changes_since(1, None, 100).unwrap();
    assert_eq!(
        feed[0].patch,
        json!([{"op": "replace", "path": "/title", "value": text}])
    );
    assert_eq!(feed[1].patch.as_array().map(Vec::len), Some(20));
    assert_eq!(f.clock.pending(), 0);
}

#[tokio::test]
async fn step_flushes_at_once_and_an_idle_coalescer_arms_nothing() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    let c = Coalescer::new(
        &f.store,
        CoalescerOptions {
            interval_ms: 100,
            ..CoalescerOptions::default()
        },
    );
    c.step().await;
    assert_eq!(f.clock.pending(), 0);
    c.patch(
        "session",
        "a",
        vec![PatchOp::replace(&["state"], json!("running"))],
    )
    .unwrap();
    assert_eq!(c.len(), 1);
    c.step().await;
    assert!(c.is_empty());
    assert_eq!(
        f.store.get("session", "a").unwrap().unwrap()["state"],
        json!("running")
    );
    let (mut rx, _sub) = commits(&f.store);
    c.patch(
        "session",
        "a",
        vec![PatchOp::replace(&["state"], json!("idle"))],
    )
    .unwrap();
    f.clock.advance(100);
    next_commit(&mut rx).await;
    assert_eq!(
        f.store.get("session", "a").unwrap().unwrap()["state"],
        json!("idle")
    );
}

#[tokio::test]
async fn one_refused_write_is_reported_and_the_rest_of_the_batch_still_commits() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    let refused = Arc::new(Mutex::new(Vec::new()));
    let r = refused.clone();
    let opts = CoalescerOptions {
        on_error: Arc::new(move |_, item| {
            r.lock()
                .unwrap()
                .push(matches!(item, Buffered::Patch { .. }));
        }),
        ..CoalescerOptions::default()
    };
    let c = Coalescer::new(&f.store, opts);
    c.patch(
        "session",
        "gone",
        vec![PatchOp::replace(&["title"], json!("x"))],
    )
    .unwrap();
    c.append("event", vec![event("a", 1, "x", json!(null))])
        .unwrap();
    c.flush().await;
    assert_eq!(*refused.lock().unwrap(), vec![true]);
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 1);
}

#[tokio::test]
async fn close_flushes_what_is_buffered_and_refuses_more() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    let c = Coalescer::new(&f.store, CoalescerOptions::default());
    c.patch(
        "session",
        "a",
        vec![PatchOp::replace(&["title"], json!("last words"))],
    )
    .unwrap();
    c.close().await;
    assert_eq!(
        f.store.get("session", "a").unwrap().unwrap()["title"],
        json!("last words")
    );
    assert!(
        c.patch(
            "session",
            "a",
            vec![PatchOp::replace(&["title"], json!("x"))]
        )
        .is_err()
    );
}

#[tokio::test]
async fn a_dropped_coalescer_still_flushes_on_its_timer() {
    let f = open();
    f.store
        .write(|w| w.upsert("session", session("a")))
        .await
        .unwrap();
    let (mut rx, _sub) = commits(&f.store);
    let c = Coalescer::new(&f.store, CoalescerOptions::default());
    c.append("event", vec![event("a", 1, "x", json!(null))])
        .unwrap();
    drop(c);
    f.clock.advance(250);
    next_commit(&mut rx).await;
    assert_eq!(f.store.count("event", &Query::new()).unwrap(), 1);
}
