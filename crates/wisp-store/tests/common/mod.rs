//! A small owner for the tests: sessions (plain rows) and their events (an append-only log), with the
//! migrations a plugin would ship.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use wisp_store::{Col, EntityDef, Location, ManualClock, Migration, Row, Store, StoreOptions, row};

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE t_session (id TEXT PRIMARY KEY, title TEXT, state TEXT, archived INTEGER, updated_at INTEGER, extra TEXT) STRICT;
     CREATE INDEX t_session_list ON t_session (archived, updated_at);
     CREATE TABLE t_event (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES t_session (id), seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT) STRICT;
     CREATE UNIQUE INDEX t_event_seq ON t_event (session_id, seq);",
)];

fn session_topics(r: &Row) -> Vec<String> {
    vec!["list".into(), format!("session:{}", r["id"].as_str().unwrap_or(""))]
}
fn event_topics(r: &Row) -> Vec<String> {
    vec![format!("session:{}", r["session_id"].as_str().unwrap_or(""))]
}

pub const SESSION: EntityDef = EntityDef {
    kind: "session",
    table: "t_session",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("title", Col::Text),
        ("state", Col::Text),
        ("archived", Col::Bool),
        ("updated_at", Col::Int),
        ("extra", Col::Text),
    ],
    json_columns: &["extra"],
    parent: None,
    seq: None,
    topics: session_topics,
};

pub const EVENT: EntityDef = EntityDef {
    kind: "event",
    table: "t_event",
    key: "id",
    columns: &[("id", Col::Int), ("session_id", Col::Text), ("seq", Col::Int), ("kind", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: Some("session_id"),
    seq: Some("seq"),
    topics: event_topics,
};

pub struct Fixture {
    pub store: Store,
    pub clock: Arc<ManualClock>,
    pub home: Option<PathBuf>,
}

pub fn tmp_home() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wisp-store-{}", uuid::Uuid::now_v7().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn options(location: Location, clock: Arc<ManualClock>) -> StoreOptions {
    let mut o = StoreOptions::new(location, clock);
    o.epoch = Arc::new(|| "epoch-1".to_owned());
    o
}

pub fn open_with(o: StoreOptions, clock: Arc<ManualClock>, home: Option<PathBuf>) -> Fixture {
    let store = Store::open_with(o).unwrap();
    store.migrate("test", MIGRATIONS).unwrap();
    store.define_entity(SESSION).unwrap();
    store.define_entity(EVENT).unwrap();
    Fixture { store, clock, home }
}

pub fn open() -> Fixture {
    let clock = Arc::new(ManualClock::new(1_000_000));
    open_with(options(Location::Memory, clock.clone()), clock, None)
}

pub fn open_disk(home: Option<PathBuf>) -> Fixture {
    let home = home.unwrap_or_else(tmp_home);
    let clock = Arc::new(ManualClock::new(1_000_000));
    open_with(options(Location::Path(home.join("wisp.db")), clock.clone()), clock, Some(home))
}

pub fn session(id: &str) -> Row {
    row!({"id": id, "title": format!("task {id}"), "state": "idle", "archived": false, "updated_at": 1, "extra": null})
}

pub fn session_with(id: &str, over: Value) -> Row {
    let mut r = session(id);
    if let Value::Object(m) = over {
        r.extend(m);
    }
    r
}

#[allow(clippy::needless_pass_by_value)] // callers build bodies inline with json!
pub fn event(session: &str, seq: i64, kind: &str, body: Value) -> Row {
    row!({"session_id": session, "seq": seq, "kind": kind, "body": body})
}

pub fn ids(rows: &[Row]) -> Vec<String> {
    rows.iter()
        .map(|r| match &r["id"] {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        })
        .collect()
}
