//! Benches (`#[ignore]`: run in release). Gate G1 (plan §9.1) and the write-amplification budget (plan §8).
//!   cargo test -p wisp-store --release --test bench -- --ignored --nocapture --test-threads=1
//!   `G1_EVENTS=200000` shrinks G1 for a quick run.
// bench-only style: timing closures read better without trailing semicolons
#![allow(clippy::semicolon_if_nothing_returned, clippy::manual_is_multiple_of)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

mod common;

use std::sync::Arc;
use std::time::Instant;

use serde_json::json;
use wisp_store::{Col, EntityDef, Location, Migration, PatchOp, Query, Row, Store, StoreOptions, SystemClock, row};

const G1_SCHEMA: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, crew_id TEXT, title TEXT, state TEXT,
       agent TEXT, model TEXT, mode TEXT, cwd TEXT, branch TEXT, archived INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER, updated_at INTEGER, last_seq INTEGER, rev INTEGER, extra TEXT) STRICT;
     CREATE INDEX session_list ON session (archived, updated_at DESC);
     CREATE TABLE event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT,
       t INTEGER, kind TEXT, body TEXT, v INTEGER) STRICT;
     CREATE UNIQUE INDEX event_seq ON event (session_id, seq);",
)];

fn s_topics(r: &Row) -> Vec<String> {
    vec!["list".into(), format!("session:{}", r["id"].as_str().unwrap_or(""))]
}
fn e_topics(r: &Row) -> Vec<String> {
    vec![format!("session:{}", r["session_id"].as_str().unwrap_or(""))]
}

const SESSION: EntityDef = EntityDef {
    kind: "session",
    table: "session",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("project_id", Col::Text),
        ("parent_id", Col::Text),
        ("crew_id", Col::Text),
        ("title", Col::Text),
        ("state", Col::Text),
        ("agent", Col::Text),
        ("model", Col::Text),
        ("mode", Col::Text),
        ("cwd", Col::Text),
        ("branch", Col::Text),
        ("archived", Col::Bool),
        ("created_at", Col::Int),
        ("updated_at", Col::Int),
        ("last_seq", Col::Int),
        ("rev", Col::Int),
        ("extra", Col::Text),
    ],
    json_columns: &["extra"],
    parent: None,
    seq: None,
    topics: s_topics,
};
const EVENT: EntityDef = EntityDef {
    kind: "event",
    table: "event",
    key: "id",
    columns: &[
        ("id", Col::Int),
        ("session_id", Col::Text),
        ("seq", Col::Int),
        ("turn_id", Col::Text),
        ("t", Col::Int),
        ("kind", Col::Text),
        ("body", Col::Text),
        ("v", Col::Int),
    ],
    json_columns: &["body"],
    parent: Some("session_id"),
    seq: Some("seq"),
    topics: e_topics,
};

fn sid(i: usize) -> String {
    format!("0193{i:08}-7000-7000-8000-000000000000")
}

fn events(next: &mut [i64], s: usize, n: usize) -> Vec<Row> {
    let id = sid(s);
    let seq0 = next[s];
    next[s] += n as i64;
    (0..n as i64)
        .map(|i| {
            let seq = seq0 + i;
            row!({"session_id": id, "seq": seq, "turn_id": format!("{id}:t{}", seq / 50), "t": 1_700_000_000_000_i64 + seq, "kind": if i % 3 == 0 { "text" } else { "tool" },
                  "body": {"text": "Reading server/store.js to see how sessions are written", "tool": "Read", "input": {"file_path": "/Users/x/wisp/server/store.js"}}, "v": 1})
        })
        .collect()
}

fn timeit(name: &str, runs: usize, mut f: impl FnMut()) -> f64 {
    for _ in 0..20 {
        f();
    }
    let mut ms: Vec<f64> = (0..runs)
        .map(|_| {
            let a = Instant::now();
            f();
            a.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    let (p50, p95) = (ms[runs / 2], ms[runs * 95 / 100]);
    println!("  {name}: p50 {p50:.2} ms, p95 {p95:.2} ms");
    p95
}

fn session_row(i: usize) -> Row {
    row!({"id": sid(i), "project_id": format!("p{}", i % 12), "parent_id": null, "crew_id": null, "title": format!("Task number {i}: fix the thing in module {}", i % 97),
        "state": "idle", "agent": "claude", "model": "opus", "mode": "auto", "cwd": format!("/Users/x/code/p{}", i % 12), "branch": format!("wisp/task-{i}"),
        "archived": i % 5 == 0, "created_at": i, "updated_at": 1_700_000_000_000_i64 + i as i64 * 1000, "last_seq": 0, "rev": 1, "extra": {"cost": i as f64 / 100.0, "tags": ["a"]}})
}

fn load(store: &Store, sessions: usize, total: usize, next: &mut [i64]) -> f64 {
    for b in (0..sessions).step_by(500) {
        store
            .write_blocking(move |w| (b..(b + 500).min(sessions)).try_for_each(|i| w.upsert("session", session_row(i)).map(|_| ())))
            .unwrap();
    }
    // bulk: transactions of 1,000 events, 10 sessions × 100 (an import's shape)
    let (mut s, mut written, t0) = (0, 0, Instant::now());
    while written < total {
        let n = 1000.min(total - written);
        let batches: Vec<Vec<Row>> = (0..n)
            .step_by(100)
            .map(|k| {
                s += 1;
                events(next, (s - 1) % sessions, 100.min(n - k))
            })
            .collect();
        store.write_blocking(move |w| batches.into_iter().try_for_each(|b| w.append("event", b).map(|_| ()))).unwrap();
        written += n;
    }
    let rate = total as f64 / t0.elapsed().as_secs_f64();
    println!("  bulk append (tx per 1,000): {rate:.0} events/s ({:.1} s)", t0.elapsed().as_secs_f64());
    rate
}

fn stream(store: &Store, next: &mut [i64], per_tx: usize, txs: usize) -> f64 {
    let t0 = Instant::now();
    for i in 0..txs {
        let b = events(next, i % 10, per_tx);
        store.write_blocking(move |w| w.append("event", b).map(|_| ())).unwrap();
    }
    let rate = (txs * per_tx) as f64 / t0.elapsed().as_secs_f64();
    println!("  streaming append (tx per {per_tx} events, 10 sessions round-robin): {rate:.0} events/s");
    rate
}

#[test]
#[ignore = "bench: run in release with --ignored"]
fn g1_5k_sessions_2m_events() {
    let sessions = 5000;
    let total: usize = std::env::var("G1_EVENTS").ok().and_then(|v| v.parse().ok()).unwrap_or(2_000_000);
    let home = common::tmp_home();
    let store = Store::open_with(StoreOptions::new(Location::Path(home.join("wisp.db")), Arc::new(SystemClock))).unwrap();
    store.migrate("bench", G1_SCHEMA).unwrap();
    store.define_entity(SESSION).unwrap();
    store.define_entity(EVENT).unwrap();
    println!("G1: {sessions} sessions, {total} events");
    let mut next = vec![0i64; sessions];
    let bulk = load(&store, sessions, total, &mut next);
    let streamed = stream(&store, &mut next, 10, 10_000);
    stream(&store, &mut next, 1, 10_000);

    let list_cols = ["id", "project_id", "parent_id", "crew_id", "title", "state", "agent", "archived", "updated_at", "branch"];
    let q_list = Query::new().select(&list_cols).eq("archived", false).desc("updated_at");
    let rows = store.query("session", &q_list).unwrap().len();
    let rows_ms = timeit(&format!("list query as Rows, every live session ({rows} rows, list columns)"), 200, || {
        drop(store.query("session", &q_list).unwrap());
    });
    let list = timeit(&format!("list query as JSON, every live session ({rows} rows, list columns)"), 200, || {
        drop(store.query_json("session", &q_list).unwrap());
    });
    let q_all = Query::new().eq("archived", false).desc("updated_at");
    let full = timeit("list query, every live session (all 17 columns)", 200, || drop(store.query("session", &q_all).unwrap()));
    let q_page = Query::new().eq("archived", false).desc("updated_at").limit(200);
    let page = timeit("list query, first 200 rows (all columns)", 500, || drop(store.query("session", &q_page).unwrap()));
    timeit("window: last 100 events of one session", 500, || drop(store.window("event", &sid(1234), None, 100).unwrap()));
    let head = store.head_seq().unwrap();
    let topic = format!("session:{}", sid(3));
    timeit("changes_since(head - 1000) on one session topic", 200, || {
        drop(store.changes_since(head - 1000, Some(&[topic.as_str()]), 1000).unwrap())
    });
    timeit("get one session", 2000, || drop(store.get("session", sid(4321).as_str()).unwrap()));
    let size =
        std::fs::metadata(home.join("wisp.db")).map_or(0, |m| m.len()) + std::fs::metadata(home.join("wisp.db-wal")).map_or(0, |m| m.len());
    println!("  db size: {} MB, change rows: {head}", size / 1_000_000);
    let pass = list <= 5.0 && bulk >= 20_000.0 && streamed >= 20_000.0;
    println!(
        "G1 {}: list p95 {list:.2} ms as JSON ({rows_ms:.2} ms as Rows, all columns {full:.2} ms, first 200 {page:.2} ms) ≤ 5 ms, append {bulk:.0} / {streamed:.0} ev/s ≥ 20,000",
        if pass { "PASS" } else { "FAIL" }
    );
    store.close();
    let _ = std::fs::remove_dir_all(&home);
    assert!(pass);
}

const WA_SCHEMA: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, state TEXT, updated_at INTEGER, last_seq INTEGER, extra TEXT) STRICT;
     CREATE TABLE event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT, body TEXT, v INTEGER) STRICT;
     CREATE UNIQUE INDEX event_seq ON event (session_id, seq);",
)];
const WA_SESSION: EntityDef = EntityDef {
    kind: "session",
    table: "session",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("title", Col::Text),
        ("state", Col::Text),
        ("updated_at", Col::Int),
        ("last_seq", Col::Int),
        ("extra", Col::Text),
    ],
    json_columns: &["extra"],
    parent: None,
    seq: None,
    topics: s_topics,
};
const WA_EVENT: EntityDef = EntityDef {
    kind: "event",
    table: "event",
    key: "id",
    columns: &[("id", Col::Int), ("session_id", Col::Text), ("seq", Col::Int), ("kind", Col::Text), ("body", Col::Text), ("v", Col::Int)],
    json_columns: &["body"],
    parent: Some("session_id"),
    seq: Some("seq"),
    topics: e_topics,
};

/// One 2 MB session streamed as 5,000 events, the session head patched in the same tx (as the runtime
/// does). Bytes written = every WAL frame (a reader pins the WAL so it only grows) + the database file
/// after the final checkpoint. Payload = the events' JSON.
fn amplification(batch: usize) -> (f64, u64, u64, u64) {
    const EVENTS: usize = 5000;
    let home = common::tmp_home();
    let file = home.join("wisp.db");
    let store = Store::open_with(StoreOptions::new(Location::Path(file.clone()), Arc::new(SystemClock))).unwrap();
    store.migrate("bench", WA_SCHEMA).unwrap();
    store.define_entity(WA_SESSION).unwrap();
    store.define_entity(WA_EVENT).unwrap();
    store
        .write_blocking(|w| {
            w.upsert(
                "session",
                row!({"id": "s1", "title": "the big one", "state": "running", "updated_at": 0, "last_seq": 0, "extra": {"cost": 0}}),
            )
        })
        .unwrap();
    let reader = wisp_store::rusqlite::Connection::open(&file).unwrap();
    if let Ok(sql) = std::env::var("WA_EXPERIMENT") {
        reader.execute_batch(&sql).unwrap();
    }
    reader.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); BEGIN;").unwrap();
    let _: i64 = reader.query_row("SELECT count(*) FROM session", [], |r| r.get(0)).unwrap();
    let text = "x".repeat(2 * 1024 * 1024 / EVENTS - 31); // {"t":"text","text":…,"n":1234} ≈ 419 B
    let mut payload = 0u64;
    for i in (0..EVENTS).step_by(batch) {
        let rows: Vec<Row> = (i..(i + batch).min(EVENTS))
            .map(|k| {
                let body = json!({"t": "text", "text": text, "n": k});
                payload += body.to_string().len() as u64;
                row!({"session_id": "s1", "seq": k, "kind": "text", "body": body, "v": 1})
            })
            .collect();
        let n = rows.len() + i;
        store
            .write_blocking(move |w| {
                w.append("event", rows)?;
                w.patch("session", "s1", &[PatchOp::replace(&["last_seq"], json!(n)), PatchOp::replace(&["updated_at"], json!(i))])?;
                Ok(())
            })
            .unwrap();
    }
    let wal = std::fs::metadata(home.join("wisp.db-wal")).unwrap().len();
    reader.execute_batch("COMMIT").unwrap();
    store.close();
    drop(store);
    reader.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    drop(reader);
    let db = std::fs::metadata(&file).unwrap().len();
    let _ = std::fs::remove_dir_all(&home);
    ((wal + db) as f64 / payload as f64, payload, wal, db)
}

#[test]
#[ignore = "bench: run in release with --ignored"]
fn write_amplification_2mb_session_in_5000_events() {
    let mb = |n: u64| format!("{:.1} MB", n as f64 / 1e6);
    let mut ten = 0.0;
    for batch in [10, 1] {
        let (x, payload, wal, db) = amplification(batch);
        println!("tx per {batch} events: payload {}, WAL {}, db {} → {x:.1}× payload", mb(payload), mb(wal), mb(db));
        if batch == 10 {
            ten = x;
        }
    }
    println!("write amplification {} at 10 events/tx: {ten:.1}× ≤ 15×", if ten <= 15.0 { "PASS" } else { "FAIL" });
    assert!(ten <= 15.0);
}

/// Where the list query's time goes: SQLite stepping alone, then the store's decode.
#[test]
#[ignore = "bench: run in release with --ignored"]
fn list_profile() {
    let home = common::tmp_home();
    let file = home.join("wisp.db");
    let store = Store::open_with(StoreOptions::new(Location::Path(file.clone()), Arc::new(SystemClock))).unwrap();
    store.migrate("bench", G1_SCHEMA).unwrap();
    store.define_entity(SESSION).unwrap();
    store.define_entity(EVENT).unwrap();
    store.write_blocking(|w| (0..5000).try_for_each(|i| w.upsert("session", session_row(i)).map(|_| ()))).unwrap();
    let raw = wisp_store::rusqlite::Connection::open(&file).unwrap();
    let plan: Vec<String> = raw
        .prepare("EXPLAIN QUERY PLAN SELECT \"id\", \"title\" FROM \"session\" WHERE \"archived\" = 0 ORDER BY \"updated_at\" DESC")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    println!("  plan: {plan:?}");
    let sql = "SELECT \"id\", \"project_id\", \"parent_id\", \"crew_id\", \"title\", \"state\", \"agent\", \"archived\", \"updated_at\", \"branch\" FROM \"session\" WHERE \"archived\" = ? ORDER BY \"updated_at\" DESC";
    timeit("sqlite step only (10 columns, 4000 rows)", 200, || {
        let mut st = raw.prepare_cached(sql).unwrap();
        let mut rows = st.query([0]).unwrap();
        let mut n = 0;
        while let Some(r) = rows.next().unwrap() {
            n += r.get_ref(4).unwrap().as_bytes().map_or(0, <[u8]>::len);
        }
        assert!(n > 0);
    });
    let list_cols = ["id", "project_id", "parent_id", "crew_id", "title", "state", "agent", "archived", "updated_at", "branch"];
    let q = Query::new().select(&list_cols).eq("archived", false).desc("updated_at");
    timeit("store.query (10 columns, decoded rows)", 200, || drop(store.query("session", &q).unwrap()));
    timeit("store.query_json (10 columns, JSON text)", 200, || drop(store.query_json("session", &q).unwrap()));
    timeit("store.read only (begin/commit)", 200, || store.read(|_| Ok(())).unwrap());
    timeit("empty write_blocking (thread hop + BEGIN/COMMIT)", 2000, || store.write_blocking(|_| Ok(())).unwrap());
    let mut next = vec![0i64; 5000];
    timeit("append 10 events (one tx)", 2000, || {
        let b = events(&mut next, 7, 10);
        store.write_blocking(move |w| w.append("event", b).map(|_| ())).unwrap();
    });
    let _ = std::fs::remove_dir_all(&home);
}
