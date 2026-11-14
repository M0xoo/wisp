//! wisp.machines' tables (ADR-0004: one write path, every row in the change feed), forward-only:
//! - `machines_peer`: a peer as stored (`PeerRow`), on the `machines` topic
//! - `machines_status`: its live side (`PeerStatus`), beside it on the `machines` topic, so a client
//!   watches a connection move without polling
//! - `machines_mirror`: the rows each peer's `list` shows, as last seen (`<peer>/<e>/<id>`), on
//!   `plugin:wisp.machines:remote`: an asleep box's tasks stay on screen and a restart resumes
//! - `machines_sync`: each peer link's client id and resume point (cursor, epoch, pending commands),
//!   on `plugin:wisp.machines:links`
//!
//! A token a transport keeps for a peer goes to secrets (`machines.<id>`), never here.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_machines_api::{PeerRow, PeerStatus, TOPIC};
use wisp_machines_core::peer_client::Saved;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store, Writer};

pub const OWNER: &str = "machines";
pub const REMOTE_TOPIC: &str = "plugin:wisp.machines:remote";
/// each link's resume point (Settings → Machines → Details shows a peer's cursor and queue)
pub const LINKS_TOPIC: &str = "plugin:wisp.machines:links";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE machines_peer (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE machines_status (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE machines_mirror (id TEXT PRIMARY KEY, peer TEXT NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX machines_mirror_peer ON machines_mirror (peer);
     CREATE TABLE machines_sync (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn on_machines(_: &Row) -> Vec<String> {
    vec![TOPIC.into()]
}
fn on_remote(_: &Row) -> Vec<String> {
    vec![REMOTE_TOPIC.into()]
}
fn on_links(_: &Row) -> Vec<String> {
    vec![LINKS_TOPIC.into()]
}

const DOC: &[(&str, Col)] = &[("id", Col::Text), ("body", Col::Text)];

pub const PEER: EntityDef = EntityDef {
    kind: "machines_peer",
    table: "machines_peer",
    key: "id",
    columns: DOC,
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: on_machines,
};
pub const STATUS: EntityDef = EntityDef {
    kind: "machines_status",
    table: "machines_status",
    key: "id",
    columns: DOC,
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: on_machines,
};
pub const MIRROR: EntityDef = EntityDef {
    kind: "machines_mirror",
    table: "machines_mirror",
    key: "id",
    columns: &[("id", Col::Text), ("peer", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: on_remote,
};
pub const SYNC: EntityDef = EntityDef {
    kind: "machines_sync",
    table: "machines_sync",
    key: "id",
    columns: DOC,
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: on_links,
};

/// A link's resume point: the client id the peer knows this wisp by, and `PeerClient::save()`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncRow {
    pub client_id: String,
    #[serde(default)]
    pub saved: Saved,
}

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    for def in [PEER, STATUS, MIRROR, SYNC] {
        store.define_entity(def)?;
    }
    Ok(())
}

fn doc(id: &str, body: impl Serialize) -> wisp_store::Result<Row> {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), serde_json::to_value(body)?);
    Ok(r)
}

pub fn put_peer(w: &mut Writer<'_>, p: &PeerRow) -> wisp_store::Result<()> {
    w.upsert(PEER.kind, doc(&p.id, p)?).map(|_| ())
}

pub fn put_status(w: &mut Writer<'_>, s: &PeerStatus) -> wisp_store::Result<()> {
    w.upsert(STATUS.kind, doc(&s.id, s)?).map(|_| ())
}

pub fn put_sync(w: &mut Writer<'_>, id: &str, s: &SyncRow) -> wisp_store::Result<()> {
    w.upsert(SYNC.kind, doc(id, s)?).map(|_| ())
}

pub fn mirror_key(peer: &str, e: &str, id: &str) -> String {
    format!("{peer}/{e}/{id}")
}

/// What the mirror changed since the last flush: `(peer, e, id, Some(value) | None for gone)`.
pub fn put_mirror(w: &mut Writer<'_>, dirty: Vec<(String, String, String, Option<Value>)>) -> wisp_store::Result<()> {
    for (peer, e, id, v) in dirty {
        let key = mirror_key(&peer, &e, &id);
        match v {
            Some(v) => {
                let mut r = doc(&key, json!({ "e": e, "id": id, "v": v }))?;
                r.insert("peer".into(), json!(peer));
                w.upsert(MIRROR.kind, r)?;
            }
            None => {
                w.del(MIRROR.kind, key.as_str())?;
            }
        }
    }
    Ok(())
}

/// Everything a peer leaves behind goes with it.
pub fn forget(w: &mut Writer<'_>, id: &str) -> wisp_store::Result<()> {
    w.del(PEER.kind, id)?;
    w.del(STATUS.kind, id)?;
    w.del(SYNC.kind, id)?;
    for row in w.query(MIRROR.kind, &Query::new().select(&["id"]).eq("peer", id))? {
        if let Some(k) = row.get("id").and_then(Value::as_str) {
            w.del(MIRROR.kind, k)?;
        }
    }
    Ok(())
}

/// What is stored: peers, their links' resume points and the mirrored rows `(peer, e, id, v)`.
#[derive(Debug, Default)]
pub struct Loaded {
    pub peers: Vec<PeerRow>,
    pub sync: Vec<(String, SyncRow)>,
    pub mirror: Vec<(String, String, String, Value)>,
}

fn body<T: serde::de::DeserializeOwned>(r: &Row) -> Option<T> {
    r.get("body").cloned().and_then(|b| serde_json::from_value(b).ok())
}

pub async fn load(store: &Store) -> wisp_store::Result<Loaded> {
    store
        .read_async(|r| {
            let mut out = Loaded::default();
            let mut peers: Vec<PeerRow> = r.query(PEER.kind, &Query::new())?.iter().filter_map(body).collect();
            peers.sort_by_key(|p| p.added_at);
            out.peers = peers;
            for row in r.query(SYNC.kind, &Query::new())? {
                if let (Some(id), Some(s)) = (row.get("id").and_then(Value::as_str), body::<SyncRow>(&row)) {
                    out.sync.push((id.to_owned(), s));
                }
            }
            for row in r.query(MIRROR.kind, &Query::new())? {
                let (Some(peer), Some(b)) = (row.get("peer").and_then(Value::as_str), body::<Value>(&row)) else { continue };
                let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                out.mirror.push((peer.to_owned(), s("e"), s("id"), b.get("v").cloned().unwrap_or(Value::Null)));
            }
            Ok(out)
        })
        .await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use super::*;

    fn row(id: &str, at: i64) -> PeerRow {
        PeerRow {
            id: id.into(),
            peer: None,
            name: id.into(),
            transport: "loopback".into(),
            address: "127.0.0.1".into(),
            port: 4999,
            command: String::new(),
            auto_connect: true,
            added_at: at,
            data: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn peers_their_mirror_and_resume_point_come_back_and_go_with_the_peer() {
        let store = Store::open(wisp_store::Location::Memory, Arc::new(wisp_store::SystemClock)).unwrap();
        install(&store).unwrap();
        install(&store).unwrap(); // forward-only: running twice changes nothing
        let (a, b) = (row("aa11bb", 2), row("cc22dd", 1));
        store
            .write(move |w| {
                put_peer(w, &a)?;
                put_peer(w, &b)?;
                put_status(w, &PeerStatus::off("aa11bb"))?;
                put_sync(w, "aa11bb", &SyncRow { client_id: "machines-1".into(), saved: Saved { cursor: Some(7), ..Saved::default() } })?;
                put_mirror(
                    w,
                    vec![
                        ("aa11bb".into(), "session".into(), "s1".into(), Some(json!({"state": "running"}))),
                        ("cc22dd".into(), "session".into(), "s2".into(), Some(json!({}))),
                    ],
                )
            })
            .await
            .unwrap();
        let l = load(&store).await.unwrap();
        assert_eq!(l.peers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["cc22dd", "aa11bb"], "in the order they were added");
        assert_eq!(l.sync[0].1.saved.cursor, Some(7));
        assert_eq!(l.mirror.len(), 2);
        store.write(|w| forget(w, "aa11bb")).await.unwrap();
        let l = load(&store).await.unwrap();
        assert_eq!((l.peers.len(), l.sync.len(), l.mirror.len()), (1, 0, 1), "its rows went with it");
        store.write(|w| put_mirror(w, vec![("cc22dd".into(), "session".into(), "s2".into(), None)])).await.unwrap();
        assert_eq!(load(&store).await.unwrap().mirror.len(), 0);
    }
}
