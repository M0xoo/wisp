//! wisp.learn's tables: one row per scope's lists, the recent retros, and how far each task was read.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};
use wisp_learn_api::{GLOBAL, Lists, Retro};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

pub const OWNER: &str = "learn";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE learn_list (scope TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE learn_retro (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE TABLE learn_seen (session_id TEXT PRIMARY KEY, turns INTEGER NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.learn:lists".into()]
}

pub const LIST: EntityDef = EntityDef {
    kind: "learn.list",
    table: "learn_list",
    key: "scope",
    columns: &[("scope", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};
pub const RETRO: EntityDef = EntityDef {
    kind: "learn.retro",
    table: "learn_retro",
    key: "id",
    columns: &[("id", Col::Text), ("at", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};
pub const SEEN: EntityDef = EntityDef {
    kind: "learn.seen",
    table: "learn_seen",
    key: "session_id",
    columns: &[("session_id", Col::Text), ("turns", Col::Int)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics: |_| Vec::new(),
};

/// What the tables hold, read once at start.
#[derive(Debug, Default)]
pub struct Data {
    pub global: Lists,
    pub projects: BTreeMap<String, Lists>,
    pub history: Vec<Retro>,
    pub seen: HashMap<String, u32>,
}

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for d in [LIST, RETRO, SEEN] {
        store.define_entity(d)?;
    }
    Ok(())
}

pub async fn load(store: &Store) -> wisp_store::Result<Data> {
    store
        .read_async(|r| {
            let mut d = Data::default();
            for row in r.query(LIST.kind, &Query::new())? {
                let scope = row.get("scope").and_then(Value::as_str).unwrap_or_default().to_owned();
                let lists: Lists = row.get("body").cloned().and_then(|b| serde_json::from_value(b).ok()).unwrap_or_default();
                if scope == GLOBAL {
                    d.global = lists;
                } else {
                    d.projects.insert(scope, lists);
                }
            }
            let mut hist: Vec<Retro> = r
                .query(RETRO.kind, &Query::new())?
                .into_iter()
                .filter_map(|row| row.get("body").cloned().and_then(|b| serde_json::from_value(b).ok()))
                .collect();
            hist.sort_by_key(|x| x.at);
            d.history = hist;
            for row in r.query(SEEN.kind, &Query::new())? {
                let id = row.get("session_id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let n = row.get("turns").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
                d.seen.insert(id, n);
            }
            Ok(d)
        })
        .await
}

/// One scope's lists (an emptied project scope goes): `body` (them, with the ranges kept for the items retros added,
/// `texts`), an item whose ranges couldn't be found now keeping the ones the row it replaces had for it.
pub async fn put_list(store: &Store, scope: &str, lists: &Lists, mut body: Value, texts: Vec<(String, String)>) -> wisp_store::Result<()> {
    let (scope, gone) = (scope.to_owned(), scope != GLOBAL && lists.is_empty());
    store
        .write(move |w| {
            if gone {
                return w.del(LIST.kind, scope.as_str()).map(|_| ());
            }
            if let Some(old) = w.get(LIST.kind, scope.as_str())?.and_then(|mut o| o.remove("body")) {
                wisp_runtime_api::env::carry(&old, &mut body, "", &texts);
            }
            let mut r = Row::new();
            r.insert("scope".into(), json!(scope));
            r.insert("body".into(), body);
            w.upsert(LIST.kind, r).map(|_| ())
        })
        .await
}

/// A retro run (`body`: it, with its kept ranges), and the oldest beyond `keep` dropped; the task read up to `turns`.
pub async fn put_retro(store: &Store, run: &Retro, body: Value, drop: Vec<String>, turns: u32) -> wisp_store::Result<()> {
    let (id, at, sid) = (run.id.clone(), run.at, run.session_id.clone());
    store
        .write(move |w| {
            let mut r = Row::new();
            r.insert("id".into(), json!(id));
            r.insert("at".into(), json!(at));
            r.insert("body".into(), body);
            w.upsert(RETRO.kind, r)?;
            for d in &drop {
                w.del(RETRO.kind, d.as_str())?;
            }
            seen_row(w, &sid, turns)
        })
        .await
}

fn seen_row(w: &mut wisp_store::Writer<'_>, sid: &str, turns: u32) -> wisp_store::Result<()> {
    let mut r = Row::new();
    r.insert("session_id".into(), json!(sid));
    r.insert("turns".into(), json!(turns));
    w.upsert(SEEN.kind, r).map(|_| ())
}

/// The task read up to `turns` with nothing to learn (no retro run).
pub async fn put_seen(store: &Store, sid: &str, turns: u32) -> wisp_store::Result<()> {
    let sid = sid.to_owned();
    store.write(move |w| seen_row(w, &sid, turns)).await
}
