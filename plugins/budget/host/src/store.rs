//! wisp.budget's tables (ADR-0004): one row per account's readings (`budget_acc`, id `agent|account`)
//! and its settings (`budget_meta`: Automations stop at per harness). v1's config.json `defaults`
//! stop lines are read once by the importer.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_budget_core::state::Acc;
use wisp_store::{Col, EntityDef, ImportFile, ImportOptions, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "budget";
pub const TOPIC: &str = "plugin:wisp.budget:plan";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE budget_acc (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE budget_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const ACC: EntityDef = EntityDef { kind: "budget_acc", table: "budget_acc", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };
pub const META: EntityDef = EntityDef { kind: "budget_meta", table: "budget_meta", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(ACC)?;
    store.define_entity(META)
}

fn row(id: &str, body: impl serde::Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

pub fn put_acc(w: &mut Writer<'_>, agent: &str, account: &str, acc: &Acc) -> wisp_store::Result<()> {
    w.upsert(ACC.kind, row(&format!("{agent}|{account}"), acc)?).map(|_| ())
}

pub fn put_settings(w: &mut Writer<'_>, v: &Value) -> wisp_store::Result<()> {
    w.upsert(META.kind, row("settings", v)?).map(|_| ())
}

/// (agent, account, readings) per account, and the settings.
pub async fn load(store: &Store) -> wisp_store::Result<(Vec<(String, String, Acc)>, Value)> {
    store
        .read_async(|r| {
            let mut accs = Vec::new();
            for row in r.query(ACC.kind, &Query::new())? {
                let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
                if let (Some((agent, account)), Some(acc)) = (id.split_once('|'), row.get("body").cloned().and_then(|b| serde_json::from_value::<Acc>(b).ok())) {
                    accs.push((agent.to_owned(), account.to_owned(), acc));
                }
            }
            let mut settings = json!({});
            for row in r.query(META.kind, &Query::new())? {
                if row.get("id").and_then(Value::as_str) == Some("settings") {
                    settings = row.get("body").cloned().unwrap_or_else(|| json!({}));
                }
            }
            Ok((accs, settings))
        })
        .await
}

/// v1 config.json `defaults`: the stop lines, and Drain watch.
fn import_settings(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let cfg: Value = f.json()?;
    let mut out = serde_json::Map::new();
    for k in [wisp_budget_api::settings::AUTO_STOP, wisp_budget_api::settings::AUTO_STOP_CLAUDE, wisp_budget_api::settings::AUTO_STOP_CODEX, wisp_budget_api::settings::DRAIN_WATCH] {
        if let Some(v) = cfg.pointer(&format!("/defaults/{k}")) {
            out.insert(k.into(), v.clone());
        }
    }
    if out.is_empty() { Ok(()) } else { put_settings(w, &Value::Object(out)) }
}

pub async fn import_v1(store: &Store, home: &Path) -> wisp_store::Result<()> {
    if !home.join("config.json").is_file() {
        return Ok(());
    }
    let opts = ImportOptions { name: "budget.v1config".into(), dir: home.to_owned(), pattern: Some(Arc::new(|n: &str| n == "config.json")), cancel: None };
    wisp_store::import_files(store, opts, Arc::new(import_settings)).await.map(|_| ())
}
