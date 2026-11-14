//! What My Stuff's page reads: one `stuff.item` row per item on the `stuff` topic, the item as the page sees
//! it (`StuffView`: no paths or hashes, whether an app runs, its public link, the version before), flat,
//! named as the UI names it. Rewritten after every change (`publish`); a removed item's row goes.

use std::collections::HashSet;

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};
use wisp_stuff_api::StuffView;

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE stuff_view (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL, at INTEGER NOT NULL,
       by TEXT NOT NULL, lang TEXT, excerpt TEXT, url TEXT, entry TEXT, files INTEGER, uses TEXT, \"from\" TEXT, note TEXT, tags TEXT, starred INTEGER, rev INTEGER,
       updatedAt INTEGER, published TEXT, allowed TEXT, changed INTEGER, risky TEXT, prev TEXT, cover INTEGER, db INTEGER, data INTEGER, running TEXT) STRICT;",
)];

pub const VIEW: EntityDef = EntityDef {
    kind: "stuff.item",
    table: "stuff_view",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("kind", Col::Text),
        ("name", Col::Text),
        ("title", Col::Text),
        ("mime", Col::Text),
        ("size", Col::Int),
        ("at", Col::Int),
        ("by", Col::Text),
        ("lang", Col::Text),
        ("excerpt", Col::Text),
        ("url", Col::Text),
        ("entry", Col::Text),
        ("files", Col::Int),
        ("uses", Col::Text),
        ("from", Col::Text),
        ("note", Col::Text),
        ("tags", Col::Text),
        ("starred", Col::Bool),
        ("rev", Col::Int),
        ("updatedAt", Col::Int),
        ("published", Col::Text),
        ("allowed", Col::Text),
        ("changed", Col::Bool),
        ("risky", Col::Text),
        ("prev", Col::Text),
        ("cover", Col::Bool),
        ("db", Col::Bool),
        ("data", Col::Bool),
        ("running", Col::Text),
    ],
    json_columns: &["uses", "from", "tags", "published", "allowed", "risky", "prev", "running"],
    parent: None,
    seq: None,
    topics: |_| vec!["stuff".to_owned()],
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate("stuff_view", MIGRATIONS)?;
    store.define_entity(VIEW)
}

/// A view as its row: the struct's fields, by the names the page reads.
pub fn row_of(v: &StuffView) -> Row {
    let fields = serde_json::to_value(v).ok().and_then(|x| x.as_object().cloned()).unwrap_or_default();
    let mut r = Row::new();
    for (c, _) in VIEW.columns {
        r.insert((*c).to_owned(), fields.get(*c).cloned().unwrap_or(Value::Null));
    }
    r
}

/// `r` with where its text quotes a value its task read, kept in it.
fn kept_row(m: Option<&dyn wisp_runtime_api::env::EnvMask>, r: Row) -> Row {
    let mut v = Value::Object(r);
    crate::egress::keep_item(m, &mut v);
    match v {
        Value::Object(r) => r,
        _ => Row::new(),
    }
}

/// Every item's row as it stands; a gone one's row deleted. Off the caller's way.
pub fn publish(ctx: &Ctx, st: &std::sync::Arc<crate::state::Stuff>) {
    let (c, s) = (ctx.clone(), st.clone());
    ctx.spawn(async move {
        let Ok(store) = c.service::<Store>() else { return };
        // where each row's text quotes a value its task read, kept in its `from` (ADR-0055); a row whose task isn't in
        // memory now (every row at start) keeps what it had, where its text is as it was
        let mask = c.use_service::<wisp_runtime_api::env::EnvMaskService>().ok();
        let rows: Vec<Row> = s.views().await.iter().map(|x| kept_row(mask.as_deref(), row_of(x))).collect();
        let r = store
            .write(move |w| {
                let keep: HashSet<String> = rows.iter().filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
                let mut was = std::collections::HashMap::new();
                for old in w.query(VIEW.kind, &Query::default())? {
                    match old.get("id").and_then(Value::as_str).map(str::to_owned) {
                        Some(id) if !keep.contains(&id) => drop(w.del(VIEW.kind, id)?),
                        Some(id) => drop(was.insert(id, Value::Object(old))),
                        None => {}
                    }
                }
                for row in rows {
                    let mut new = Value::Object(row);
                    if let Some(old) = new.get("id").and_then(Value::as_str).and_then(|id| was.get(id)) {
                        crate::egress::carry_item(old, &mut new);
                    }
                    let Value::Object(row) = new else { continue };
                    w.upsert(VIEW.kind, row)?;
                }
                Ok(())
            })
            .await;
        if let Err(e) = r {
            tracing::warn!(error = %e, "stuff: writing My Stuff's rows");
        }
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// The page's row is the view's own fields under the names the page reads (`updatedAt`, `from`), with the
    /// app's running port and public link as objects; nothing the view doesn't carry (paths, hashes).
    #[tokio::test]
    async fn my_stuffs_rows_are_the_view_flat_and_named_as_the_page_reads_them() {
        let db = Store::open(wisp_store::Location::Memory, std::sync::Arc::new(wisp_store::SystemClock)).unwrap();
        install(&db).unwrap();
        let v: StuffView = serde_json::from_value(serde_json::json!({
            "id": "s1", "kind": "app", "name": "pomodoro", "title": "Pomodoro", "size": 10, "at": 5, "by": "agent",
            "from": { "session": "t1", "title": "Make a timer" }, "updatedAt": 7, "running": { "port": 4100 }, "starred": true
        }))
        .unwrap();
        let r = row_of(&v);
        db.write(move |w| w.upsert(VIEW.kind, r).map(|_| ())).await.unwrap();
        let got = db.read(|x| x.get("stuff.item", "s1")).unwrap().unwrap();
        assert_eq!(got["running"]["port"], 4100);
        assert_eq!(got["from"]["session"], "t1");
        assert_eq!(got["updatedAt"], 7);
        assert_eq!(got["starred"], true);
        assert_eq!((VIEW.topics)(&got), vec!["stuff".to_owned()]);
    }
}
