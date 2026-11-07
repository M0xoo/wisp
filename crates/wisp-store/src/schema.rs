//! The kernel tables (plan §4.1), owned by the migration owner `kernel`; no plugin writes them directly.
//! Forward-only: never edit a shipped migration, add the next one. Also the kernel's own entity kinds,
//! `setting` and `plugin`, both on the `config` topic.

use crate::entity::{Col, EntityDef, Row};
use crate::migrate::Migration;

pub const KERNEL_OWNER: &str = "kernel";

pub const KERNEL_MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    r"
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

    -- AUTOINCREMENT: a seq is never reused, even after retention empties the table, so a cursor
    -- always means the same point in the feed for the life of an epoch.
    CREATE TABLE change (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      entity TEXT NOT NULL,
      id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert', 'patch', 'del', 'append')),
      patch TEXT,
      at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX change_topic_seq ON change (topic, seq);
    CREATE INDEX change_at ON change (at);

    -- the second and later topics of a change (a session row is on 'list' and 'session:<id>')
    CREATE TABLE change_topic (
      topic TEXT NOT NULL,
      seq INTEGER NOT NULL REFERENCES change (seq) ON DELETE CASCADE,
      PRIMARY KEY (topic, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX change_topic_by_seq ON change_topic (seq);

    CREATE TABLE mutation (
      client_id TEXT NOT NULL,
      mid TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (client_id, mid)
    ) STRICT;
    CREATE INDEX mutation_at ON mutation (at);

    CREATE TABLE blob (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      codec TEXT NOT NULL,
      data BLOB,
      at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE blob_ref (
      hash TEXT NOT NULL REFERENCES blob (hash),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      PRIMARY KEY (hash, owner_kind, owner_id)
    ) STRICT;
    CREATE INDEX blob_ref_owner ON blob_ref (owner_kind, owner_id);

    CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT, locked_by TEXT) STRICT;

    CREATE TABLE plugin (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      grants TEXT
    ) STRICT;

    -- search: a stable integer per (kind, id) for the FTS5 rowid; entity rowids may change on VACUUM
    CREATE TABLE search_doc (
      rid INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      UNIQUE (kind, id)
    ) STRICT;
    ",
)];

fn config_topic(_: &Row) -> Vec<String> {
    vec!["config".to_owned()]
}

/// `setting(key, value JSON, locked_by)`: `locked_by` is the plugin whose `setSettings` pins the value.
pub const SETTING: EntityDef = EntityDef {
    kind: "setting",
    table: "setting",
    key: "key",
    columns: &[("key", Col::Text), ("value", Col::Text), ("locked_by", Col::Text)],
    json_columns: &["value"],
    parent: None,
    seq: None,
    topics: config_topic,
};

/// `plugin(id, version, enabled, config JSON, grants JSON)`: installed plugins.
pub const PLUGIN: EntityDef = EntityDef {
    kind: "plugin",
    table: "plugin",
    key: "id",
    columns: &[("id", Col::Text), ("version", Col::Text), ("enabled", Col::Bool), ("config", Col::Text), ("grants", Col::Text)],
    json_columns: &["config", "grants"],
    parent: None,
    seq: None,
    topics: config_topic,
};
