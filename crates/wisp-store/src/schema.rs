//! The kernel tables (plan §4.1), owned by the migration owner `kernel`; no plugin writes them directly.
//! Forward-only: never edit a shipped migration, add the next one. Also the kernel's own entity kinds,
//! `setting` and `plugin`, both on the `config` topic.

use crate::entity::{Col, EntityDef, Row};
use crate::migrate::Migration;

pub const KERNEL_OWNER: &str = "kernel";

pub const KERNEL_MIGRATIONS: &[Migration] = &[
    Migration::sql(
        1,
        r"
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

    -- AUTOINCREMENT: a seq is never reused, even after retention empties the table, so a cursor
    -- always means the same point in the feed for the life of an epoch.
    -- `more`: the second and later topics, space-separated (a topic never holds whitespace).
    -- No index besides the rowid: every b-tree a write touches costs a 4 KB WAL page per transaction
    -- (measured: three indexes here took streaming from 13× to 17× payload). Age retention scans
    -- from the oldest seq, which is also the order rows are deleted in.
    CREATE TABLE change (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      more TEXT,
      entity TEXT NOT NULL,
      id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert', 'patch', 'del', 'append')),
      patch TEXT,
      at INTEGER NOT NULL
    ) STRICT;

    -- every topic of every change, first included: the one index topic filtering reads
    CREATE TABLE change_topic (
      topic TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (topic, seq)
    ) STRICT, WITHOUT ROWID;

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
    ),
    // the durable event log (ADR-0044)
    Migration::sql(2, crate::events::SQL),
    // a setting's own value under another plugin's lock (`value` is what's in force, what clients read)
    Migration::sql(3, "ALTER TABLE setting ADD COLUMN saved TEXT;"),
];

fn config_topic(_: &Row) -> Vec<String> {
    vec!["config".to_owned()]
}

/// `setting(key, value JSON, locked_by, saved JSON)`: one row per server setting that isn't at its default.
/// `value` is what's in force (what clients read), `locked_by` the plugin whose `setSettings` pins it, `saved`
/// the user's own value (kept under a lock, read back at start).
pub const SETTING: EntityDef = EntityDef {
    kind: "setting",
    table: "setting",
    key: "key",
    columns: &[("key", Col::Text), ("value", Col::Text), ("locked_by", Col::Text), ("saved", Col::Text)],
    json_columns: &["value", "saved"],
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
