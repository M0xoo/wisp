//! wisp.crew's tables (ADR-0004: one write path, every row in the change feed): a member per row, where
//! each sits on the Org page, and which tasks are whose jobs. Forward-only migrations, owner `crew`.
//! v1 kept the crew in config.json (`crew`, `crewLayout`): read once by the importer, resumably.
//! Kit files (SKILL.md, AGENTS.md) stay files, as plan §4.8 says.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_crew_api::{Member, TOPIC};
use wisp_crew_api::commands::{Layout, Point};
use wisp_store::{Col, EntityDef, ImportFile, ImportOptions, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "crew";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE crew_member (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE TABLE crew_layout (id TEXT PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL) STRICT;
     CREATE TABLE crew_job (
       session_id TEXT PRIMARY KEY, crew_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
     CREATE INDEX crew_job_member ON crew_job (crew_id, at);",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const MEMBER: EntityDef = EntityDef {
    kind: "crew_member",
    table: "crew_member",
    key: "id",
    columns: &[("id", Col::Text), ("name", Col::Text), ("updated_at", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

pub const LAYOUT: EntityDef = EntityDef {
    kind: "crew_layout",
    table: "crew_layout",
    key: "id",
    columns: &[("id", Col::Text), ("x", Col::Int), ("y", Col::Int)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};

pub const JOB: EntityDef = EntityDef {
    kind: "crew_job",
    table: "crew_job",
    key: "session_id",
    columns: &[("session_id", Col::Text), ("crew_id", Col::Text), ("at", Col::Int)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [MEMBER, LAYOUT, JOB] {
        store.define_entity(def)?;
    }
    Ok(())
}

pub fn member_row(m: &Member) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(m.id));
    r.insert("name".into(), json!(m.name));
    r.insert("updated_at".into(), json!(m.updated_at));
    r.insert("body".into(), serde_json::to_value(m)?);
    Ok(r)
}

pub fn put_member(w: &mut Writer<'_>, m: &Member) -> wisp_store::Result<()> {
    w.upsert(MEMBER.kind, member_row(m)?).map(|_| ())
}

pub fn put_point(w: &mut Writer<'_>, id: &str, p: Point) -> wisp_store::Result<()> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("x".into(), json!(p.x));
    r.insert("y".into(), json!(p.y));
    w.upsert(LAYOUT.kind, r).map(|_| ())
}

/// Everything at start: the members, the layout, each member's jobs (oldest first).
pub async fn load(store: &Store) -> wisp_store::Result<(Vec<Member>, Layout, Vec<(String, String)>)> {
    store
        .read_async(|r| {
            let crew = r.query(MEMBER.kind, &Query::new().asc("name"))?.into_iter().filter_map(|row| row.get("body").cloned().and_then(|b| serde_json::from_value(b).ok())).collect();
            let layout = r
                .query(LAYOUT.kind, &Query::new())?
                .into_iter()
                .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), Point { x: row.get("x")?.as_i64()?, y: row.get("y")?.as_i64()? })))
                .collect();
            let jobs = r
                .query(JOB.kind, &Query::new().asc("at"))?
                .into_iter()
                .filter_map(|row| Some((row.get("crew_id")?.as_str()?.to_owned(), row.get("session_id")?.as_str()?.to_owned())))
                .collect();
            Ok((crew, layout, jobs))
        })
        .await
}

/// v1's config.json `crew` and `crewLayout`, into the tables (upserts: safe to run again).
fn import_config(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let cfg: Value = f.json()?;
    for m in cfg.get("crew").and_then(Value::as_array).into_iter().flatten() {
        if let Ok(m) = serde_json::from_value::<Member>(m.clone()) {
            put_member(w, &m)?;
        }
    }
    for (id, p) in cfg.get("crewLayout").and_then(Value::as_object).into_iter().flatten() {
        if let (Some(x), Some(y)) = (p.get("x").and_then(Value::as_i64), p.get("y").and_then(Value::as_i64)) {
            put_point(w, id, Point { x, y })?;
        }
    }
    Ok(())
}

/// Reads v1's crew from `home/config.json`, once per version of that file (`crew.v1` progress).
pub async fn import_v1(store: &Store, home: &Path) -> wisp_store::Result<()> {
    if !home.join("config.json").is_file() {
        return Ok(());
    }
    let opts = ImportOptions { name: "crew.v1".into(), dir: home.to_owned(), pattern: Some(Arc::new(|n: &str| n == "config.json")), cancel: None };
    wisp_store::import_files(store, opts, Arc::new(import_config)).await.map(|_| ())
}
