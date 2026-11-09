//! wisp.runtime's tables (plan §4.1): a session row with a cached list row, turn heads, the append-only
//! event log (one row per step, `UNIQUE (session_id, seq)`, not WITHOUT ROWID: ~400 B rows), and the
//! follow-up queue. Forward-only migrations, owner `runtime` (plan §4.2).
//!
//! Search (FTS5): session titles, turn prompts and answers. The event log is not indexed: it is most of
//! the bytes, and indexing it would double the write amplification for a search nobody runs on tool calls.

use wisp_runtime_api::session_topic;
use wisp_store::{Col, EntityDef, Migration, Row};

pub const OWNER: &str = "runtime";

pub const MIGRATIONS: &[Migration] = &[
    Migration::sql(
    1,
    "CREATE TABLE runtime_session (
       id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL, agent TEXT NOT NULL,
       archived INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
       body TEXT NOT NULL, summary TEXT) STRICT;
     CREATE INDEX runtime_session_list ON runtime_session (archived, updated_at);
     CREATE INDEX runtime_session_parent ON runtime_session (parent_id);
     CREATE TABLE runtime_turn (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES runtime_session (id) ON DELETE CASCADE,
       idx INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
       prompt TEXT NOT NULL, answer TEXT, body TEXT NOT NULL) STRICT;
     CREATE UNIQUE INDEX runtime_turn_idx ON runtime_turn (session_id, idx);
     CREATE TABLE runtime_event (
       id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES runtime_session (id) ON DELETE CASCADE,
       seq INTEGER NOT NULL, turn_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
       v INTEGER NOT NULL) STRICT;
     CREATE UNIQUE INDEX runtime_event_seq ON runtime_event (session_id, seq);
     CREATE INDEX runtime_event_turn ON runtime_event (turn_id, seq);
     CREATE TABLE runtime_queue_item (
       id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES runtime_session (id) ON DELETE CASCADE,
       pos INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX runtime_queue_session ON runtime_queue_item (session_id, pos);",
    ),
    // ADR-0027 / ADR-0029: named agent profiles, and the effective formula each task ran with (by hash)
    Migration::sql(
        2,
        "CREATE TABLE runtime_profile (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
         CREATE TABLE runtime_formula (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;",
    ),
    // ADR-0029: what each task had (skills, MCP servers and their tools, permissions), recorded at its first run
    Migration::sql(3, "CREATE TABLE runtime_setup (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;"),
];

fn session_of(r: &Row, key: &str) -> String {
    r.get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn session_topics(r: &Row) -> Vec<String> {
    vec![
        wisp_runtime_api::TOPIC_LIST.into(),
        session_topic(&session_of(r, "id")),
    ]
}

fn child_topics(r: &Row) -> Vec<String> {
    vec![session_topic(&session_of(r, "session_id"))]
}

pub const SESSION: EntityDef = EntityDef {
    kind: "session",
    table: "runtime_session",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("parent_id", Col::Text),
        ("title", Col::Text),
        ("state", Col::Text),
        ("agent", Col::Text),
        ("archived", Col::Bool),
        ("unread", Col::Bool),
        ("created_at", Col::Int),
        ("updated_at", Col::Int),
        ("rev", Col::Int),
        ("body", Col::Text),
        ("summary", Col::Text),
    ],
    json_columns: &["body", "summary"],
    parent: None,
    seq: None,
    topics: session_topics,
};

pub const TURN: EntityDef = EntityDef {
    kind: "turn",
    table: "runtime_turn",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("session_id", Col::Text),
        ("idx", Col::Int),
        ("status", Col::Text),
        ("started_at", Col::Int),
        ("ended_at", Col::Int),
        ("prompt", Col::Text),
        ("answer", Col::Text),
        ("body", Col::Text),
    ],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: child_topics,
};

pub const EVENT: EntityDef = EntityDef {
    kind: "event",
    table: "runtime_event",
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
    topics: child_topics,
};

pub const QUEUE_ITEM: EntityDef = EntityDef {
    kind: "queue_item",
    table: "runtime_queue_item",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("session_id", Col::Text),
        ("pos", Col::Int),
        ("body", Col::Text),
    ],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: child_topics,
};

fn profile_topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.runtime:profiles".into()]
}

fn formula_topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.runtime:formulas".into()]
}

pub const PROFILE: EntityDef = EntityDef {
    kind: "profile",
    table: "runtime_profile",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: profile_topics,
};

/// Snapshots are referenced by tasks (a task's spec names its hash); written once, never changed.
pub const FORMULA: EntityDef = EntityDef {
    kind: "formula_snapshot",
    table: "runtime_formula",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text), ("created_at", Col::Int)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: formula_topics,
};

fn setup_topics(r: &Row) -> Vec<String> {
    vec![session_topic(&session_of(r, "id"))]
}

/// A task's recorded setup, by session id (ADR-0029).
pub const SETUP: EntityDef = EntityDef {
    kind: "task_setup",
    table: "runtime_setup",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: setup_topics,
};

/// Runs the migrations and registers the kinds and the search index. At start, before any command.
pub fn install(store: &wisp_store::Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [SESSION, TURN, EVENT, QUEUE_ITEM, PROFILE, FORMULA, SETUP] {
        store.define_entity(def)?;
    }
    store.define_search("session", &["title"])?;
    store.define_search("turn", &["prompt", "answer"])?;
    Ok(())
}
