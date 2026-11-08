//! wisp.router's tables (ADR-0004: one write path, every row in the change feed). One row per arm,
//! per (kind of task, arm) record, per taste, per routed task and per cooling harness; Settings → Auto,
//! the corrections and `backfilled` in `router_meta`. A save writes only what the state marked dirty.
//! v1's `router.json` and config.json `defaults.router` are read once by the importer.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_router_api::view::Settings;
use wisp_router_core::RouterState;
use wisp_router_core::state::{ArmState, Cool, Dirty, Pair, Stat, Taste};
use wisp_store::{Col, EntityDef, ImportFile, ImportOptions, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "router";
pub const TOPIC: &str = "plugin:wisp.router:auto";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE router_arm (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE router_stat (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE router_taste (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE router_cool (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE router_route (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX router_route_at ON router_route (at);
     CREATE TABLE router_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

macro_rules! doc {
    ($name:ident, $kind:literal) => {
        pub const $name: EntityDef = EntityDef { kind: $kind, table: $kind, key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };
    };
}
doc!(ARM, "router_arm");
doc!(STAT, "router_stat");
doc!(TASTE, "router_taste");
doc!(COOL, "router_cool");
doc!(META, "router_meta");
pub const ROUTE: EntityDef = EntityDef {
    kind: "router_route",
    table: "router_route",
    key: "id",
    columns: &[("id", Col::Text), ("at", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [ARM, STAT, TASTE, COOL, META, ROUTE] {
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

fn put(w: &mut Writer<'_>, kind: &str, id: &str, body: impl serde::Serialize) -> wisp_store::Result<()> {
    w.upsert(kind, doc_row(id, body)?).map(|_| ())
}

/// `kind|key`, v1's stat and taste keys.
fn bar(kind: &str, key: &str) -> String {
    format!("{kind}|{key}")
}

/// Deletes every row of `kind` whose id isn't in `keep` (a reset forgot them).
fn keep_only(w: &mut Writer<'_>, kind: &str, keep: &[String]) -> wisp_store::Result<()> {
    for row in w.query(kind, &Query::new().select(&["id"]))? {
        if let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| !keep.iter().any(|k| k == id)) {
            w.del(kind, id)?;
        }
    }
    Ok(())
}

/// The writes a save makes: rows to put, ids to delete, and (after a reset) the stat and taste ids
/// to keep. Built under the state's lock from what it marked dirty; applied on the writer thread.
#[derive(Debug, Default)]
pub struct Ops {
    puts: Vec<(&'static str, Row)>,
    dels: Vec<(&'static str, String)>,
    keep: Option<(Vec<String>, Vec<String>)>,
}

impl Ops {
    pub fn is_empty(&self) -> bool {
        self.puts.is_empty() && self.dels.is_empty() && self.keep.is_none()
    }

    fn put(&mut self, kind: &'static str, id: &str, body: impl serde::Serialize) -> wisp_store::Result<()> {
        self.puts.push((kind, doc_row(id, body)?));
        Ok(())
    }

    fn put_or_del<T: serde::Serialize>(&mut self, kind: &'static str, id: String, v: Option<T>) -> wisp_store::Result<()> {
        if let Some(v) = v { self.put(kind, &id, v) } else {
            self.dels.push((kind, id));
            Ok(())
        }
    }

    pub fn apply(self, w: &mut Writer<'_>) -> wisp_store::Result<()> {
        if let Some((stats, taste)) = &self.keep {
            keep_only(w, STAT.kind, stats)?;
            keep_only(w, TASTE.kind, taste)?;
        }
        for (kind, id) in self.dels {
            w.del(kind, id)?;
        }
        for (kind, row) in self.puts {
            w.upsert(kind, row)?;
        }
        Ok(())
    }
}

/// The rows `d` names, as `st` has them now (gone from `st`: deleted).
pub fn ops(st: &RouterState, d: &Dirty, settings: Option<&Settings>) -> wisp_store::Result<Ops> {
    let mut o = Ops::default();
    for k in &d.arms {
        o.put_or_del(ARM.kind, k.clone(), st.arms.get(k))?;
    }
    for k in &d.cooling {
        o.put_or_del(COOL.kind, k.clone(), st.cooling.get(k))?;
    }
    for (t, k) in &d.stats {
        o.put_or_del(STAT.kind, bar(t, k), st.stat(t, k))?;
    }
    for (t, k) in &d.taste {
        o.put_or_del(TASTE.kind, bar(t, k), st.taste(t, k))?;
    }
    for id in &d.routes {
        if let Some(r) = st.route(id) {
            let mut row = doc_row(id, r)?;
            row.insert("at".into(), json!(r.at));
            o.puts.push((ROUTE.kind, row));
        }
    }
    for id in &d.dropped_routes {
        o.dels.push((ROUTE.kind, id.clone()));
    }
    if d.meta {
        // a reset forgets every record: the dirty sets don't name all of them
        o.keep = Some((st.all_stats().map(|(t, k, _)| bar(t, k)).collect(), st.all_taste().map(|(t, k, _)| bar(t, k)).collect()));
        o.put(META.kind, "backfilled", json!({ "at": st.backfilled }))?;
    }
    if d.pairs {
        o.put(META.kind, "pairs", &st.pairs)?;
    }
    if let Some(s) = settings {
        o.put(META.kind, "settings", s)?;
    }
    Ok(o)
}

fn body<T: serde::de::DeserializeOwned>(row: &Row) -> Option<T> {
    row.get("body").cloned().and_then(|b| serde_json::from_value(b).ok())
}

fn id(row: &Row) -> &str {
    row.get("id").and_then(Value::as_str).unwrap_or_default()
}

/// The state and the settings, as the tables hold them.
pub async fn load(store: &Store) -> wisp_store::Result<(RouterState, Settings)> {
    store
        .read_async(|r| {
            let mut st = RouterState::default();
            for row in r.query(ARM.kind, &Query::new())? {
                if let Some(a) = body::<ArmState>(&row) {
                    st.arms.insert(id(&row).to_owned(), a);
                }
            }
            for row in r.query(COOL.kind, &Query::new())? {
                if let Some(c) = body::<Cool>(&row) {
                    st.cooling.insert(id(&row).to_owned(), c);
                }
            }
            for row in r.query(STAT.kind, &Query::new())? {
                if let (Some((t, k)), Some(s)) = (id(&row).split_once('|'), body::<Stat>(&row)) {
                    st.load_stat(t, k, s);
                }
            }
            for row in r.query(TASTE.kind, &Query::new())? {
                if let (Some((t, k)), Some(x)) = (id(&row).split_once('|'), body::<Taste>(&row)) {
                    st.load_taste(t, k, x);
                }
            }
            for row in r.query(ROUTE.kind, &Query::new().asc("at"))? {
                if let Some(x) = body(&row) {
                    st.load_route(id(&row), x);
                }
            }
            let mut settings = Settings::default();
            for row in r.query(META.kind, &Query::new())? {
                match id(&row) {
                    "backfilled" => st.backfilled = body::<Value>(&row).and_then(|b| b.get("at").and_then(Value::as_i64)),
                    "pairs" => st.pairs = body::<Vec<Pair>>(&row).unwrap_or_default(),
                    "settings" => settings = body(&row).unwrap_or_default(),
                    _ => {}
                }
            }
            Ok((st, settings))
        })
        .await
}

/// v1's router.json, whole, into the tables (upserts: safe to run again).
fn import_file(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let st: RouterState = f.json()?;
    let d = Dirty {
        arms: st.arms.keys().cloned().collect(),
        cooling: st.cooling.keys().cloned().collect(),
        stats: st.all_stats().map(|(t, k, _)| (t.to_owned(), k.to_owned())).collect(),
        taste: st.all_taste().map(|(t, k, _)| (t.to_owned(), k.to_owned())).collect(),
        routes: st.routes().map(|(id, _)| id.to_owned()).collect(),
        pairs: true,
        ..Dirty::default()
    };
    ops(&st, &d, None)?.apply(w)?;
    put(w, META.kind, "backfilled", json!({ "at": st.backfilled }))
}

/// v1 kept Settings → Auto in config.json (`defaults.router`).
fn import_settings(f: &ImportFile, w: &mut Writer<'_>) -> wisp_store::Result<()> {
    let cfg: Value = f.json()?;
    if let Some(s) = cfg.pointer("/defaults/router").and_then(|v| serde_json::from_value::<Settings>(v.clone()).ok()) {
        put(w, META.kind, "settings", &s)?;
    }
    Ok(())
}

async fn import_one(store: &Store, home: &Path, name: &str, file: &'static str, f: fn(&ImportFile, &mut Writer<'_>) -> wisp_store::Result<()>) -> wisp_store::Result<()> {
    if !home.join(file).is_file() {
        return Ok(());
    }
    let opts = ImportOptions { name: name.into(), dir: home.to_owned(), pattern: Some(Arc::new(move |n: &str| n == file)), cancel: None };
    wisp_store::import_files(store, opts, Arc::new(f)).await.map(|_| ())
}

/// Reads v1's files once per version of each (`router.v1`, `router.v1config` progress).
pub async fn import_v1(store: &Store, home: &Path) -> wisp_store::Result<()> {
    import_one(store, home, "router.v1", "router.json", import_file).await?;
    import_one(store, home, "router.v1config", "config.json", import_settings).await
}
