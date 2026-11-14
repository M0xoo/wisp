//! wisp.later's tables (ADR-0004): one row per entry (`later_entry`), per plan (`later_plan`) and per
//! task it keeps something about (`later_meta`: its chain, reminder, For later, the follow-up sent).

use serde_json::{Value, json};
use wisp_later_api::{LaterEntry, Plan};
use wisp_later_core::TaskMeta;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "later";
pub const TOPIC: &str = "plugin:wisp.later:later";

pub const MIGRATIONS: &[Migration] = &[
    Migration::sql(
        1,
        "CREATE TABLE later_entry (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX later_entry_at ON later_entry (at);
     CREATE TABLE later_plan (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE later_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
    ),
    Migration::sql(2, "CREATE TABLE later_conf (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;"),
];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const ENTRY: EntityDef = EntityDef {
    kind: "later_entry",
    table: "later_entry",
    key: "id",
    columns: &[("id", Col::Text), ("session_id", Col::Text), ("at", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};
pub const PLAN: EntityDef = EntityDef {
    kind: "later_plan",
    table: "later_plan",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};
pub const META: EntityDef = EntityDef {
    kind: "later_meta",
    table: "later_meta",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

pub const CONF: EntityDef = EntityDef {
    kind: "later_conf",
    table: "later_conf",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for d in [ENTRY, PLAN, META, CONF] {
        store.define_entity(d)?;
    }
    Ok(())
}

fn row(id: &str, body: impl serde::Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

/// What changed: entries and plans to put or drop, metas to put.
#[derive(Debug, Default)]
pub struct Ops {
    pub entries: Vec<LaterEntry>,
    pub drop_entries: Vec<String>,
    pub plans: Vec<Plan>,
    pub drop_plans: Vec<String>,
    pub metas: Vec<(String, TaskMeta)>,
}

/// What [`Ops`] writes, its rows made (outside the store's writer: their kept ranges are found first).
#[derive(Debug, Default)]
pub struct Rows {
    del: Vec<(&'static str, String)>,
    put: Vec<(&'static str, Row)>,
}

impl Ops {
    /// The rows, each with where its text quotes a value its task read (`m`, ADR-0055).
    pub fn rows(self, m: Option<&dyn wisp_runtime_api::env::EnvMask>) -> wisp_store::Result<Rows> {
        let mut out = Rows::default();
        out.del.extend(self.drop_entries.into_iter().map(|id| (ENTRY.kind, id)));
        out.del.extend(self.drop_plans.into_iter().map(|id| (PLAN.kind, id)));
        for e in self.entries {
            let mut r = row(&e.id, &e)?;
            r.insert("session_id".into(), json!(e.session_id));
            r.insert("at".into(), json!(e.at));
            out.put.push((ENTRY.kind, r));
        }
        for p in self.plans {
            out.put.push((PLAN.kind, row(&p.id, &p)?));
        }
        for (id, m) in self.metas {
            out.put.push((META.kind, row(&id, &m)?));
        }
        for (kind, r) in &mut out.put {
            let mut v = Value::Object(std::mem::take(r));
            crate::egress::keep_ranges(m, kind, &mut v);
            if let Value::Object(o) = v {
                *r = o;
            }
        }
        Ok(out)
    }
}

impl Rows {
    pub fn apply(self, w: &mut Writer<'_>) -> wisp_store::Result<()> {
        for (kind, id) in self.del {
            w.del(kind, id)?;
        }
        for (kind, r) in self.put {
            let id = r.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            let mut v = Value::Object(r);
            // a text whose task wasn't in memory as it was written keeps the ranges it had, when it is as it was
            if let Some(old) = w.get(kind, id.as_str())? {
                crate::egress::carry_ranges(kind, &Value::Object(old), &mut v);
            }
            let Value::Object(r) = v else { continue };
            w.upsert(kind, r)?;
        }
        Ok(())
    }
}

pub type Loaded = (Vec<LaterEntry>, Vec<Plan>, Vec<(String, TaskMeta)>);

pub async fn load(store: &Store) -> wisp_store::Result<Loaded> {
    store
        .read_async(|r| {
            let body = |row: &Row| row.get("body").cloned().unwrap_or(Value::Null);
            let entries =
                r.query(ENTRY.kind, &Query::new().asc("at"))?.iter().filter_map(|x| serde_json::from_value(body(x)).ok()).collect();
            let plans = r.query(PLAN.kind, &Query::new())?.iter().filter_map(|x| serde_json::from_value(body(x)).ok()).collect();
            let metas = r
                .query(META.kind, &Query::new())?
                .iter()
                .filter_map(|x| Some((x.get("id")?.as_str()?.to_owned(), serde_json::from_value(body(x)).ok()?)))
                .collect();
            Ok((entries, plans, metas))
        })
        .await
}

/// The user's settings that later keeps (its zone).
pub fn put_conf(w: &mut Writer<'_>, v: &Value) -> wisp_store::Result<()> {
    w.upsert(CONF.kind, row("settings", v)?).map(|_| ())
}

pub async fn load_conf(store: &Store) -> wisp_store::Result<Value> {
    store.read_async(|r| Ok(r.query(CONF.kind, &Query::new())?.first().and_then(|x| x.get("body").cloned()).unwrap_or(Value::Null))).await
}
