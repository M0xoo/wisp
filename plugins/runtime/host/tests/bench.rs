//! Benches (`#[ignore]`; run in release: `cargo test -p wisp-runtime --release --test bench -- --ignored
//! --nocapture`). Plan §8 budgets: write amplification ≤ 15× for one 2 MB session streamed in 5,000 events,
//! and the list ≤ 5 ms on 5k sessions. Measured through the runtime's real path (fake CLI → driver → head
//! → Coalescer → store), the WAL pinned by an open read so every byte written stays counted (as
//! wisp-store's own bench does).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::cast_precision_loss,
    clippy::print_stdout
)] // a bench prints its numbers

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use wisp_proc::Exit;
use wisp_proc::sim::{SimIo, SimProc};
use wisp_runtime::{Recorder, Runtime, repo::Repo, schema};
use wisp_runtime_api::commands::{ListArgs, StartArgs};
use wisp_runtime_api::model::{Session, TurnStatus};
use wisp_store::{Location, Store, StoreOptions, SystemClock};

const EVENTS: usize = 5000;
/// one text event's JSON line ≈ 419 B, so 5,000 of them are 2 MB
fn text() -> String {
    "x".repeat(2 * 1024 * 1024 / EVENTS - 31)
}

/// Prints 5,000 text events, in bursts of `burst` every 25 ms (a CLI streaming steadily), then a result.
fn streamer(
    burst: usize,
) -> impl Fn(SimIo) -> std::pin::Pin<Box<dyn std::future::Future<Output = Exit> + Send>>
+ Send
+ Sync
+ 'static {
    move |io: SimIo| {
        Box::pin(async move {
            io.print(b"{\"type\":\"session\",\"id\":\"c\"}\n").await;
            let t = text();
            for i in 0..EVENTS {
                io.print(
                    format!("{}\n", json!({"type":"text","text": format!("{t}{i:05}")})).as_bytes(),
                )
                .await;
                if (i + 1) % burst == 0 {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
            io.print(b"{\"type\":\"result\",\"text\":\"done\",\"isError\":false}\n")
                .await;
            Exit {
                code: Some(0),
                signal: None,
            }
        })
    }
}

fn tmp_home() -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("wisp-runtime-bench-{}", wisp_kernel::ids::uuid7()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn size(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map_or(0, |m| m.len())
}

async fn amplification(burst: usize) -> (f64, u64, u64, u64, usize) {
    let home = tmp_home();
    let file = home.join("wisp.db");
    let store = Store::open_with(StoreOptions::new(
        Location::Path(file.clone()),
        Arc::new(SystemClock),
    ))
    .unwrap();
    schema::install(&store).unwrap();
    let sim = SimProc::new().program("fake", streamer(burst));
    let host = Arc::new(Recorder {
        harnesses: vec![common::Fake::harness()],
        ..Recorder::default()
    });
    let rt = Runtime::new(
        Repo::new(store.clone()),
        host.clone(),
        Arc::new(sim),
        Arc::new(SystemClock),
    );
    rt.start().await.unwrap();
    let reader = wisp_store::rusqlite::Connection::open(&file).unwrap();
    reader
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); BEGIN;")
        .unwrap();
    let _: i64 = reader
        .query_row("SELECT count(*) FROM runtime_session", [], |r| r.get(0))
        .unwrap();
    let before = size(&file);
    let id = rt
        .create(StartArgs {
            prompt: "stream".into(),
            cwd: Some("/tmp".into()),
            ..StartArgs::default()
        })
        .await
        .unwrap()
        .id
        .0;
    for _ in 0..12_000 {
        if rt
            .turns(&id, None, Some(1))
            .await
            .unwrap()
            .pop()
            .is_some_and(|t| t.status == TurnStatus::Done)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let payload: u64 = rt
        .activity(&rt.turns(&id, None, Some(1)).await.unwrap()[0].id.0, None)
        .await
        .unwrap()
        .items
        .iter()
        .map(|s| serde_json::to_string(&s.activity).unwrap().len() as u64)
        .sum();
    let batches = host
        .names()
        .iter()
        .filter(|n| **n == "turn.activity")
        .count();
    let wal = size(&home.join("wisp.db-wal"));
    reader.execute_batch("COMMIT").unwrap();
    store.close();
    drop(store);
    reader
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(reader);
    let db = size(&file).saturating_sub(before);
    let _ = std::fs::remove_dir_all(&home);
    (
        (wal + db) as f64 / payload as f64,
        payload,
        wal,
        db,
        batches,
    )
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "bench: run in release"]
async fn write_amplification_2mb_session_in_5000_events() {
    for burst in [10, 100] {
        let (x, payload, wal, db, chunks) = amplification(burst).await;
        println!(
            "bursts of {burst:>3} per 25 ms: payload {:.2} MB, WAL {:.2} MB, db +{:.2} MB → {x:.1}× ({chunks} activity chunks)",
            payload as f64 / 1e6,
            wal as f64 / 1e6,
            db as f64 / 1e6
        );
        assert!(x <= 15.0, "write amplification {x:.1}× > 15×");
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "bench: run in release"]
async fn list_on_5k_sessions() {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    schema::install(&store).unwrap();
    store
        .write_blocking(|w| {
            for i in 0..5000 {
                let s = Session {
                    id: format!("s{i:05}").as_str().into(),
                    title: format!("Task {i}"),
                    agent: "claude".into(),
                    cwd: "/repo".into(),
                    updated_at: i,
                    created_at: i,
                    ..Session::default()
                };
                let sum = wisp_runtime_core::summary::summarize(
                    &s,
                    &wisp_runtime_core::summary::RowFacts::default(),
                    std::collections::BTreeMap::new(),
                );
                wisp_runtime::repo::save_session(w, &s, &sum)
                    .map_err(|e| wisp_store::StoreError::Internal(e.to_string()))?;
            }
            Ok(())
        })
        .unwrap();
    let rt = Runtime::new(
        Repo::new(store.clone()),
        Arc::new(Recorder::default()),
        Arc::new(SimProc::new()),
        Arc::new(SystemClock),
    );
    let t0 = Instant::now();
    rt.start().await.unwrap();
    let cold = t0.elapsed();
    let pct = |mut v: Vec<Duration>| {
        v.sort();
        (v[v.len() / 2], v[v.len() * 95 / 100])
    };
    let list: Vec<Duration> = (0..500)
        .map(|_| {
            let t = Instant::now();
            let rows = rt.list(&ListArgs {
                archived: Some(false),
                limit: None,
            });
            assert_eq!(rows.len(), 5000);
            t.elapsed()
        })
        .collect();
    let json: Vec<Duration> = (0..100)
        .map(|_| {
            let t = Instant::now();
            let rows = rt.list(&ListArgs {
                archived: Some(false),
                limit: None,
            });
            let body = serde_json::to_vec(&rows.iter().map(|r| &**r).collect::<Vec<_>>()).unwrap();
            assert!(body.len() > 5000);
            t.elapsed()
        })
        .collect();
    let ((p50, p95), (j50, j95)) = (pct(list), pct(json));
    println!(
        "list of 5,000 tasks: start (load the list) {cold:?}; list p50 {p50:?} p95 {p95:?}; list + JSON body p50 {j50:?} p95 {j95:?}"
    );
    assert!(p95 <= Duration::from_millis(5), "list p95 {p95:?} > 5 ms");
}
