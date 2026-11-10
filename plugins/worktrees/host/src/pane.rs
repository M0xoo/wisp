//! Settings → Worktrees reads rows, not answers: one topic (`plugin:wisp.worktrees:worktrees`) carries a
//! task's folders (`worktrees.item`), the leftovers (`worktrees.leftover`), the totals (`worktrees.status`,
//! one row `status`) and Bring in's offers (`worktrees.offer`, one per project). Each row is flat: its
//! columns are the fields the pane reads. `publish` writes the whole picture in one transaction and
//! deletes what's gone, so a removed folder leaves the list and an unchanged row isn't rewritten.

use std::collections::HashSet;

use serde_json::{Value, json};
use wisp_kernel::Call;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};
use wisp_worktrees_api::{Offer, WorktreesView};
use wisp_worktrees_core::offer::{self, Listed};

use crate::{Engine, Port, fsx};

pub const OWNER: &str = "worktrees";
pub const TOPIC: &str = "plugin:wisp.worktrees:worktrees";

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE worktrees_item (id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL,
       only INTEGER NOT NULL, size INTEGER, used_at INTEGER NOT NULL, clean_at INTEGER) STRICT;
     CREATE TABLE worktrees_leftover (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER, only INTEGER, used_at INTEGER NOT NULL) STRICT;
     CREATE TABLE worktrees_status (id TEXT PRIMARY KEY, size INTEGER, disk TEXT, looking INTEGER NOT NULL, cleaning TEXT, last TEXT) STRICT;
     CREATE TABLE worktrees_offer (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, \"from\" TEXT NOT NULL, items TEXT NOT NULL,
       detached INTEGER NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}

pub const ITEM: EntityDef = EntityDef {
    kind: "worktrees.item",
    table: "worktrees_item",
    key: "id",
    columns: &[("id", Col::Text), ("title", Col::Text), ("project", Col::Text), ("branch", Col::Text), ("status", Col::Text), ("only", Col::Int), ("size", Col::Int), ("used_at", Col::Int), ("clean_at", Col::Int)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};
pub const LEFTOVER: EntityDef = EntityDef {
    kind: "worktrees.leftover",
    table: "worktrees_leftover",
    key: "id",
    columns: &[("id", Col::Text), ("name", Col::Text), ("size", Col::Int), ("only", Col::Int), ("used_at", Col::Int)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics,
};
pub const STATUS: EntityDef = EntityDef {
    kind: "worktrees.status",
    table: "worktrees_status",
    key: "id",
    columns: &[("id", Col::Text), ("size", Col::Int), ("disk", Col::Text), ("looking", Col::Bool), ("cleaning", Col::Text), ("last", Col::Text)],
    json_columns: &["disk", "cleaning", "last"],
    parent: None,
    seq: None,
    topics,
};
pub const OFFER: EntityDef = EntityDef {
    kind: "worktrees.offer",
    table: "worktrees_offer",
    key: "id",
    columns: &[("id", Col::Text), ("project", Col::Text), ("name", Col::Text), ("from", Col::Text), ("items", Col::Text), ("detached", Col::Int)],
    json_columns: &["items"],
    parent: None,
    seq: None,
    topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [ITEM, LEFTOVER, STATUS, OFFER] {
        store.define_entity(def)?;
    }
    Ok(())
}

/// `used_at` → `usedAt`: the store's columns are snake case, the API's fields camel case.
fn camel(col: &str) -> String {
    let mut out = String::with_capacity(col.len());
    let mut up = false;
    for c in col.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// A struct's fields as a row keyed `id`, with only the entity's columns (the pane reads these names).
fn row(def: &EntityDef, id: &str, v: &impl serde::Serialize) -> Row {
    let fields = serde_json::to_value(v).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    for (k, _) in def.columns.iter().skip(1) {
        r.insert((*k).into(), fields.get(&camel(k)).cloned().unwrap_or(Value::Null));
    }
    r
}

/// The rows the pane shows for this view and these offers, by kind.
pub fn rows(view: &WorktreesView, offers: &[Offer]) -> Vec<(&'static EntityDef, Vec<Row>)> {
    let status = json!({ "size": view.size, "disk": view.disk, "looking": view.looking, "cleaning": view.cleaning, "last": view.last });
    vec![
        (&ITEM, view.items.iter().map(|i| row(&ITEM, &i.id, i)).collect()),
        (&LEFTOVER, view.leftovers.iter().map(|l| row(&LEFTOVER, &l.name, l)).collect()),
        (&STATUS, vec![row(&STATUS, "status", &status)]),
        (&OFFER, offers.iter().map(|o| row(&OFFER, &o.project, o)).collect()),
    ]
}

/// Writes the pane's rows: new and changed ones upserted, an unchanged one left as it is, a gone one deleted.
pub async fn publish(store: &Store, view: &WorktreesView, offers: &[Offer]) -> wisp_store::Result<()> {
    let all = rows(view, offers);
    store
        .write(move |w| {
            for (def, want) in all {
                let have = w.query(def.kind, &Query::default())?;
                let keep: HashSet<&str> = want.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).collect();
                for old in &have {
                    if let Some(id) = old.get("id").and_then(Value::as_str).filter(|id| !keep.contains(id)) {
                        w.del(def.kind, id.to_owned())?;
                    }
                }
                for r in want {
                    let same = have.iter().any(|h| def.columns.iter().all(|(k, _)| h.get(*k).unwrap_or(&Value::Null) == r.get(*k).unwrap_or(&Value::Null)));
                    if !same {
                        w.upsert(def.kind, r)?;
                    }
                }
            }
            Ok(())
        })
        .await
}

/// Bring in's offers: every declared project's worktrees no task knows (git.service lists them).
pub async fn offers(engine: &Engine, port: &dyn Port, call: &Call) -> Vec<Offer> {
    let tasks = port.tasks().await;
    let known: HashSet<String> = tasks.iter().flat_map(|t| t.trees.iter().map(|x| x.worktree.path.trim_end_matches('/').to_owned())).collect();
    let dismissed = port.settings().await.dismissed;
    let wisp_dir = format!("{}/worktrees", engine.home.trim_end_matches('/'));
    let mut out = Vec::new();
    for (name, root) in port.projects().await {
        if dismissed.contains(&name) || !fsx::exists(&root).await {
            continue;
        }
        let Ok(repo) = engine.repo(call, &root).await else { continue };
        let Ok(entries) = repo.worktrees(call).await else { continue };
        let mut listed = Vec::with_capacity(entries.len());
        for e in entries {
            let p = e.path.trim_end_matches('/');
            let candidate = !e.bare && !e.prunable && p != root.trim_end_matches('/') && !known.contains(p) && !p.starts_with(&wisp_dir);
            let (dirty, chat) = if candidate && !e.branch.is_empty() {
                let dirty = match engine.repo(call, &e.path).await {
                    Ok(r) => r.status(call).await.map_or(0, |s| u32::try_from(s.dirty()).unwrap_or(u32::MAX)),
                    Err(_) => 0,
                };
                (dirty, port.chat_in(e.path.clone()).await)
            } else {
                (0, false)
            };
            listed.push(Listed { path: e.path, branch: e.branch, bare: e.bare, prunable: e.prunable, dirty, chat });
        }
        if let Some(o) = offer::offer(&name, &root, &listed, &known, &wisp_dir, &engine.user_home, &dismissed) {
            out.push(o);
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use wisp_store::{Location, SystemClock};
    use wisp_worktrees_api::{ItemRow, LeftoverRow, OfferItem, Standing};

    fn view(items: Vec<ItemRow>) -> WorktreesView {
        WorktreesView { cleanup: "7".into(), max: "40".into(), items, leftovers: vec![LeftoverRow { name: "old-x".into(), size: Some(9), only: None, used_at: 3 }], size: Some(10), disk: None, ready: 0, looking: true, cleaning: None, last: None }
    }

    fn item(id: &str, status: Standing) -> ItemRow {
        ItemRow { id: id.into(), title: "Fix".into(), project: "app".into(), branch: "wisp/fix".into(), status, only: 0, size: Some(1), used_at: 5, clean_at: None }
    }

    /// The pane's topic carries flat rows of every kind it reads; a folder that's gone leaves, and the
    /// status row is the one `status` row.
    #[tokio::test]
    async fn the_worktrees_pane_rows_are_published_flat_and_a_gone_folder_leaves() {
        let db = Store::open(Location::Memory, std::sync::Arc::new(SystemClock)).unwrap();
        install(&db).unwrap();
        let offer = Offer { project: "app".into(), name: "app".into(), from: "Conductor".into(), items: vec![OfferItem { path: "/c/oslo".into(), branch: "oslo".into(), name: "oslo".into(), dirty: 2, chat: true }], detached: 0 };
        publish(&db, &view(vec![item("t1", Standing::Idle), item("t2", Standing::Kept)]), std::slice::from_ref(&offer)).await.unwrap();
        let t2 = db.read(|r| r.get("worktrees.item", "t2")).unwrap().unwrap();
        assert_eq!(t2["status"], "kept");
        assert_eq!(t2["used_at"], 5);
        let st = db.read(|r| r.get("worktrees.status", "status")).unwrap().unwrap();
        assert_eq!(st["looking"], true);
        assert_eq!(st["size"], 10);
        let o = db.read(|r| r.get("worktrees.offer", "app")).unwrap().unwrap();
        assert_eq!(o["from"], "Conductor");
        assert_eq!(o["items"][0]["path"], "/c/oslo");
        assert_eq!(db.read(|r| r.get("worktrees.leftover", "old-x")).unwrap().unwrap()["name"], "old-x");
        publish(&db, &view(vec![item("t2", Standing::Kept)]), &[]).await.unwrap();
        assert!(db.read(|r| r.get("worktrees.item", "t1")).unwrap().is_none(), "removed: its row goes");
        assert!(db.read(|r| r.get("worktrees.offer", "app")).unwrap().is_none(), "brought in or dismissed: the offer goes");
        assert_eq!((ITEM.topics)(&t2), vec![TOPIC.to_owned()]);
        assert_eq!(TOPIC, "plugin:wisp.worktrees:worktrees", "the topic the pane watches (plugins/worktrees/ui types.ts TOPIC)");
    }
}
