//! My Stuff in the store (ADR-0004): items and uploads are rows in stuff-owned tables (each change in
//! the change feed), their contents are the store's blobs (BLAKE3, zstd, refs). The shelf's `Rows` and
//! `Blobs` ports over them. A content hash stays the shelf's own (BLAKE3 hex), so v1's app code hashes
//! and the grants made for them still hold.
//!
//! v1's `~/.wisp/stuff`, `uploads` and `shots` (and the pre-store `stuff/rows` and `stuff/blobs` files)
//! are read once at start by `import.rs`; an item already here is skipped.

use std::sync::Arc;

use serde_json::json;
use wisp_kernel::BoxFuture;
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};
use wisp_stuff_api::{StuffItem, Upload};

use crate::error::{Error, Result};
use crate::ports::{Blobs, Rows};

pub const OWNER: &str = "stuff";
/// Blobs the shelf holds are refd by this owner, so the store's gc keeps them.
const REF: (&str, &str) = ("stuff", "shelf");
const ALGO: &str = "blake3:";

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE stuff_item (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
     CREATE INDEX stuff_item_updated ON stuff_item (updated_at);
     CREATE TABLE stuff_upload (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn item_topics(_: &Row) -> Vec<String> {
    vec!["stuff".into()]
}

fn upload_topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.stuff:uploads".into()]
}

pub const ITEM: EntityDef = EntityDef {
    kind: "stuff_item",
    table: "stuff_item",
    key: "id",
    columns: &[("id", Col::Text), ("updated_at", Col::Int), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: item_topics,
};

pub const UPLOAD: EntityDef = EntityDef {
    kind: "stuff_upload",
    table: "stuff_upload",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: upload_topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(ITEM)?;
    store.define_entity(UPLOAD)
}

fn err(e: wisp_store::StoreError) -> Error {
    Error::from(wisp_kernel::WireError::from(e))
}

fn body<T: serde::de::DeserializeOwned>(mut row: Row) -> Option<T> {
    row.remove("body").and_then(|b| serde_json::from_value(b).ok())
}

/// The shelf's rows, in the store.
#[derive(Debug, Clone)]
pub struct StoreRows {
    pub store: Store,
}

impl Rows for StoreRows {
    fn items(&self) -> BoxFuture<'static, Result<Vec<StuffItem>>> {
        let store = self.store.clone();
        Box::pin(async move {
            store
                .read_async(|r| r.query(ITEM.kind, &Query::new()))
                .await
                .map(|rows| rows.into_iter().filter_map(body).collect())
                .map_err(err)
        })
    }
    fn put_item(&self, it: StuffItem) -> BoxFuture<'static, Result<()>> {
        let store = self.store.clone();
        Box::pin(async move {
            let mut row = Row::new();
            row.insert("id".into(), json!(it.id));
            row.insert("updated_at".into(), json!(it.updated_at.unwrap_or(it.at)));
            row.insert("body".into(), serde_json::to_value(&it)?);
            store.write(move |w| w.upsert(ITEM.kind, row).map(|_| ())).await.map_err(err)
        })
    }
    fn delete_item(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        let (store, id) = (self.store.clone(), id.to_owned());
        Box::pin(async move { store.write(move |w| w.del(ITEM.kind, id.as_str())).await.map_err(err) })
    }
    fn upload(&self, id: &str) -> BoxFuture<'static, Result<Option<Upload>>> {
        let (store, id) = (self.store.clone(), id.to_owned());
        Box::pin(async move { store.read_async(move |r| r.get(UPLOAD.kind, id.as_str())).await.map(|r| r.and_then(body)).map_err(err) })
    }
    fn put_upload(&self, u: Upload) -> BoxFuture<'static, Result<()>> {
        let store = self.store.clone();
        Box::pin(async move {
            let mut row = Row::new();
            row.insert("id".into(), json!(u.id));
            row.insert("body".into(), serde_json::to_value(&u)?);
            store.write(move |w| w.upsert(UPLOAD.kind, row).map(|_| ())).await.map_err(err)
        })
    }
    fn delete_upload(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        let (store, id) = (self.store.clone(), id.to_owned());
        Box::pin(async move { store.write(move |w| w.del(UPLOAD.kind, id.as_str())).await.map_err(err) })
    }
}

/// The shelf's contents, as the store's blobs.
#[derive(Debug, Clone)]
pub struct StoreBlobs {
    pub store: Store,
}

impl Blobs for StoreBlobs {
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'static, Result<String>> {
        let store = self.store.clone();
        Box::pin(async move {
            let info = store.put_blob(bytes, Some((REF.0.to_owned(), REF.1.to_owned()))).await.map_err(err)?;
            Ok(info.hash.strip_prefix(ALGO).unwrap_or(&info.hash).to_owned())
        })
    }
    fn get(&self, hash: &str) -> BoxFuture<'static, Result<Option<Arc<Vec<u8>>>>> {
        let (store, key) = (self.store.clone(), format!("{ALGO}{hash}"));
        Box::pin(async move { store.read_async(move |r| r.blob(&key)).await.map(|b| b.map(Arc::new)).map_err(err) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rows_and_blobs_round_trip_through_the_store() {
        let store = Store::open(wisp_store::Location::Memory, Arc::new(wisp_store::SystemClock)).unwrap();
        install(&store).unwrap();
        let blobs = StoreBlobs { store: store.clone() };
        let h = blobs.put(b"hello".to_vec()).await.unwrap();
        assert_eq!(h, crate::ports::hash(b"hello"), "the shelf's own hash");
        assert_eq!(blobs.get(&h).await.unwrap().as_deref().map(Vec::as_slice), Some(&b"hello"[..]));
        let rows = StoreRows { store: store.clone() };
        let it = StuffItem { id: "abc".into(), name: "a.txt".into(), ..StuffItem::default() };
        rows.put_item(it.clone()).await.unwrap();
        assert_eq!(rows.items().await.unwrap().first().map(|x| x.id.clone()), Some("abc".into()));
        assert!(rows.delete_item("abc").await.unwrap());
        assert_eq!(rows.items().await.unwrap().len(), 0);
        let u = Upload { id: "u1".into(), name: "a.png".into(), mime: "image/png".into(), size: 3, blob: None, path: None };
        rows.put_upload(u).await.unwrap();
        assert_eq!(rows.upload("u1").await.unwrap().map(|x| x.name), Some("a.png".into()));
        assert!(rows.delete_upload("u1").await.unwrap());
    }
}
