//! What each resource was last applied as (`resources_applied`), so a plan tells drift (wisp's copy
//! changed since, in the app or by a command) from a change in the files. Written after each apply.

use serde_json::{Value, json};
use wisp_kernel::{Ctx, Result, WireError};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

const KIND: &str = "resources_applied";

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.resources:applied".into()]
}

const DEF: EntityDef = EntityDef {
    kind: KIND,
    table: KIND,
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

static READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();

fn store(ctx: &Ctx) -> Result<std::sync::Arc<Store>> {
    let s = ctx.service::<Store>()?;
    if READY.get().is_none() {
        s.migrate(
            "resources.applied",
            &[Migration::sql(1, "CREATE TABLE resources_applied (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")],
        )
        .map_err(|e| WireError::internal(e.to_string()))?;
        s.define_entity(DEF).map_err(|e| WireError::internal(e.to_string()))?;
        let _ = READY.set(());
    }
    Ok(s)
}

pub fn key(kind: &str, name: &str) -> String {
    format!("{kind}/{name}")
}

/// Every resource's last applied spec, by `kind/name`.
pub async fn all(ctx: &Ctx) -> Result<std::collections::HashMap<String, Value>> {
    let s = store(ctx)?;
    let rows = s.read_async(|r| r.query(KIND, &Query::new())).await.map_err(|e| WireError::internal(e.to_string()))?;
    Ok(rows.into_iter().filter_map(|r| Some((r.get("id")?.as_str()?.to_owned(), r.get("body")?.clone()))).collect())
}

/// Sets (`Some`) or forgets (`None`) these baselines, in one write.
pub async fn set(ctx: &Ctx, items: Vec<(String, Option<Value>)>) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let s = store(ctx)?;
    s.write(move |w| {
        for (id, spec) in items {
            match spec {
                Some(body) => {
                    let mut r = Row::new();
                    r.insert("id".into(), json!(id));
                    r.insert("body".into(), body);
                    w.upsert(KIND, r)?;
                }
                None => {
                    w.del(KIND, id.as_str())?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| WireError::internal(e.to_string()))
}
