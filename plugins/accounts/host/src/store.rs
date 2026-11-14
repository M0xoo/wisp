//! wisp.accounts' tables (ADR-0004: one write path, every row in the change feed): one row per
//! account (`accounts_account`, id `agent/account`), per harness watch (`accounts_watch`, id the
//! harness), per sign-in (`accounts_login`, id `agent` or `agent@account`) and its settings
//! (`accounts_meta`). v1's accounts.json, harnesses.json and config.json `defaults.harnessAsk` are
//! read once by the importer.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_accounts_api::{LoginView, TOPIC};
use wisp_accounts_core::accounts::Stored;
use wisp_accounts_core::watch::Watched;
use wisp_store::{Col, EntityDef, ImportFile, ImportOptions, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "accounts";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE accounts_account (id TEXT PRIMARY KEY, agent TEXT NOT NULL, ord INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX accounts_account_agent ON accounts_account (agent, ord);
     CREATE TABLE accounts_watch (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE accounts_login (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE accounts_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

macro_rules! doc {
    ($name:ident, $kind:literal) => {
        pub const $name: EntityDef = EntityDef {
            kind: $kind,
            table: $kind,
            key: "id",
            columns: &[("id", Col::Text), ("body", Col::Text)],
            json_columns: &["body"],
            parent: None,
            seq: None,
            topics,
        };
    };
}
doc!(WATCH, "accounts_watch");
doc!(LOGIN, "accounts_login");
doc!(META, "accounts_meta");
pub const ACCOUNT: EntityDef = EntityDef {
    kind: "accounts_account",
    table: "accounts_account",
    key: "id",
    columns: &[("id", Col::Text), ("agent", Col::Text), ("ord", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [ACCOUNT, WATCH, LOGIN, META] {
        store.define_entity(def)?;
    }
    Ok(())
}

fn doc_row(id: &str, body: impl serde::Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

/// A harness's whole list, replacing what was stored (order is the list's).
pub fn put_accounts(w: &mut Writer<'_>, agent: &str, list: &[Stored]) -> wisp_store::Result<()> {
    for row in w.query(ACCOUNT.kind, &Query::new().select(&["id", "agent"]))? {
        if row.get("agent").and_then(Value::as_str) == Some(agent)
            && let Some(id) = row.get("id").and_then(Value::as_str)
        {
            w.del(ACCOUNT.kind, id)?;
        }
    }
    for (i, a) in list.iter().enumerate() {
        let mut r = doc_row(&format!("{agent}/{}", a.id), a)?;
        r.insert("agent".into(), json!(agent));
        r.insert("ord".into(), json!(i));
        w.upsert(ACCOUNT.kind, r)?;
    }
    Ok(())
}

pub fn put_watch(w: &mut Writer<'_>, agent: &str, v: &Watched) -> wisp_store::Result<()> {
    w.upsert(WATCH.kind, doc_row(agent, v)?).map(|_| ())
}

pub fn put_login(w: &mut Writer<'_>, id: &str, v: &LoginView) -> wisp_store::Result<()> {
    w.upsert(LOGIN.kind, doc_row(id, v)?).map(|_| ())
}

pub fn put_meta(w: &mut Writer<'_>, id: &str, v: &Value) -> wisp_store::Result<()> {
    w.upsert(META.kind, doc_row(id, v)?).map(|_| ())
}

/// Everything stored: (agent → accounts in order, agent → watch, the settings).
pub type Loaded = (Vec<(String, Vec<Stored>)>, Vec<(String, Watched)>, Value);

pub async fn load(store: &Store) -> wisp_store::Result<Loaded> {
    store
        .read_async(|r| {
            let mut accounts: Vec<(String, Vec<Stored>)> = Vec::new();
            for row in r.query(ACCOUNT.kind, &Query::new().asc("agent").asc("ord"))? {
                let agent = row.get("agent").and_then(Value::as_str).unwrap_or_default().to_owned();
                let Some(a) = row.get("body").cloned().and_then(|b| serde_json::from_value::<Stored>(b).ok()) else { continue };
                match accounts.iter_mut().find(|(g, _)| *g == agent) {
                    Some((_, l)) => l.push(a),
                    None => accounts.push((agent, vec![a])),
                }
            }
            let mut watch = Vec::new();
            for row in r.query(WATCH.kind, &Query::new())? {
                if let (Some(id), Some(w)) = (
                    row.get("id").and_then(Value::as_str),
                    row.get("body").cloned().and_then(|b| serde_json::from_value::<Watched>(b).ok()),
                ) {
                    watch.push((id.to_owned(), w));
                }
            }
            let mut settings = json!({});
            for row in r.query(META.kind, &Query::new())? {
                if row.get("id").and_then(Value::as_str) == Some("settings") {
                    settings = row.get("body").cloned().unwrap_or_else(|| json!({}));
                }
            }
            Ok((accounts, watch, settings))
        })
        .await
}

/// v1 accounts.json: `{ agent: [accounts] }`.
fn import_accounts(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let v: Value = f.json()?;
    for (agent, list) in v.as_object().into_iter().flatten() {
        let list: Vec<Stored> = list.as_array().into_iter().flatten().filter_map(|a| serde_json::from_value(a.clone()).ok()).collect();
        put_accounts(w, agent, &list)?;
    }
    Ok(())
}

/// v1 harnesses.json: `{ pins: {id: fp}, changes: {id: change} }`.
fn import_watch(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let v: Value = f.json()?;
    let mut ids: Vec<String> = v["pins"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    ids.extend(v["changes"].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default());
    ids.dedup();
    for id in ids {
        let watched = Watched {
            pin: serde_json::from_value(v["pins"][&id].clone()).ok(),
            change: serde_json::from_value(v["changes"][&id].clone()).ok(),
        };
        put_watch(w, &id, &watched)?;
    }
    Ok(())
}

fn import_settings(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let v: Value = f.json()?;
    if let Some(ask) = v.pointer("/defaults/harnessAsk").and_then(Value::as_str) {
        put_meta(w, "settings", &json!({ "harnessAsk": ask }))?;
    }
    Ok(())
}

async fn import_one(
    store: &Store,
    home: &Path,
    name: &str,
    file: &'static str,
    f: fn(&ImportFile, &mut Writer<'_>) -> wisp_store::Result<()>,
) -> wisp_store::Result<()> {
    if !home.join(file).is_file() {
        return Ok(());
    }
    let opts = ImportOptions { name: name.into(), dir: home.to_owned(), pattern: Some(Arc::new(move |n: &str| n == file)), cancel: None };
    wisp_store::import_files(store, opts, Arc::new(f)).await.map(|_| ())
}

/// Reads v1's files once per version of each.
pub async fn import_v1(store: &Store, home: &Path) -> wisp_store::Result<()> {
    import_one(store, home, "accounts.v1", "accounts.json", import_accounts).await?;
    import_one(store, home, "accounts.v1watch", "harnesses.json", import_watch).await?;
    import_one(store, home, "accounts.v1config", "config.json", import_settings).await
}
