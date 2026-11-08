//! wisp.later's tables (ADR-0004): one row per entry (`later_entry`), per plan (`later_plan`) and per
//! task it keeps something about (`later_meta`: its chain, reminder, For later, the follow-up sent).

use serde_json::{Value, json};
use wisp_later_api::{LaterEntry, Plan};
use wisp_later_core::TaskMeta;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "later";
pub const TOPIC: &str = "plugin:wisp.later:later";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE later_entry (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX later_entry_at ON later_entry (at);
     CREATE TABLE later_plan (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE later_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const ENTRY: EntityDef = EntityDef { kind: "later_entry", table: "later_entry", key: "id", columns: &[("id", Col::Text), ("session_id", Col::Text), ("at", Col::Int), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };
pub const PLAN: EntityDef = EntityDef { kind: "later_plan", table: "later_plan", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };
pub const META: EntityDef = EntityDef { kind: "later_meta", table: "later_meta", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for d in [ENTRY, PLAN, META] {
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

impl Ops {
    pub fn apply(self, w: &mut Writer<'_>) -> wisp_store::Result<()> {
        for id in self.drop_entries {
            w.del(ENTRY.kind, id)?;
        }
        for e in self.entries {
            let mut r = row(&e.id, &e)?;
            r.insert("session_id".into(), json!(e.session_id));
            r.insert("at".into(), json!(e.at));
            w.upsert(ENTRY.kind, r)?;
        }
        for id in self.drop_plans {
            w.del(PLAN.kind, id)?;
        }
        for p in self.plans {
            w.upsert(PLAN.kind, row(&p.id, &p)?)?;
        }
        for (id, m) in self.metas {
            w.upsert(META.kind, row(&id, &m)?)?;
        }
        Ok(())
    }
}

pub type Loaded = (Vec<LaterEntry>, Vec<Plan>, Vec<(String, TaskMeta)>);

pub async fn load(store: &Store) -> wisp_store::Result<Loaded> {
    store
        .read_async(|r| {
            let body = |row: &Row| row.get("body").cloned().unwrap_or(Value::Null);
            let entries = r.query(ENTRY.kind, &Query::new().asc("at"))?.iter().filter_map(|x| serde_json::from_value(body(x)).ok()).collect();
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
