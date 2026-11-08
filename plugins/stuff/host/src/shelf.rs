//! The shelf: My Stuff's items, read from the rows once and kept in memory (a few hundred records),
//! every change written through `Rows` first. Writes are serialised so an update reads what the last
//! one wrote. Saving lives in `save.rs`; this file holds the rest.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use wisp_kernel::Clock;
use wisp_stuff_api::pane::{grant_of, is_write};
use wisp_stuff_api::{Grant, Published, StuffItem, StuffKind, StuffView};
use wisp_stuff_core::record::{self, Fields, ViewFacts, hash_now};

use crate::error::{Error, Result, bad};
use crate::ports::{Blobs, Rows};

pub struct Shelf {
    pub(crate) blobs: Arc<dyn Blobs>,
    pub(crate) rows: Arc<dyn Rows>,
    /// `~/.wisp/stuff`: apps' databases (`<id>-data.sqlite`, as v1) and agents' read-only copies
    pub(crate) dir: PathBuf,
    pub(crate) clock: Arc<dyn Clock>,
    items: RwLock<HashMap<String, StuffItem>>,
    pub(crate) write: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Shelf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shelf").field("dir", &self.dir).finish_non_exhaustive()
    }
}

pub(crate) fn gone() -> Error {
    bad(404, "That’s no longer in My Stuff.")
}

impl Shelf {
    pub async fn open(blobs: Arc<dyn Blobs>, rows: Arc<dyn Rows>, dir: PathBuf, clock: Arc<dyn Clock>) -> Result<Arc<Self>> {
        let items = rows.items().await?.into_iter().map(|it| (it.id.clone(), it)).collect();
        Ok(Arc::new(Self { blobs, rows, dir, clock, items: RwLock::new(items), write: tokio::sync::Mutex::new(()) }))
    }

    pub(crate) fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn get(&self, id: &str) -> Option<StuffItem> {
        self.items.read().ok()?.get(id).cloned()
    }

    /// Newest first.
    pub fn list(&self) -> Vec<StuffItem> {
        let mut v: Vec<StuffItem> = self.items.read().map(|m| m.values().cloned().collect()).unwrap_or_default();
        record::sort_newest(&mut v);
        v
    }

    pub fn len(&self) -> usize {
        self.items.read().map_or(0, |m| m.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The same thing from the same place (a reply's picture saved twice) is the one item.
    pub fn find_key(&self, key: Option<&str>) -> Option<StuffItem> {
        let key = key.filter(|k| !k.is_empty())?;
        self.list().into_iter().find(|x| x.from.as_ref().and_then(|f| f.key.as_deref()) == Some(key))
    }

    pub(crate) async fn put(&self, it: StuffItem) -> Result<StuffItem> {
        self.rows.put_item(it.clone()).await?;
        self.items.write().map_err(|_| Error::Poisoned)?.insert(it.id.clone(), it.clone());
        Ok(it)
    }

    /// An app's database: beside it, under its id, so it outlives updates to the app (v1's place).
    pub fn data_file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}-data.sqlite"))
    }

    /// What the page sees, with whether an app runs and on which port.
    pub async fn view(&self, it: &StuffItem, running: Option<u16>) -> StuffView {
        let data = it.db.is_some() && tokio::fs::try_exists(self.data_file(&it.id)).await.unwrap_or(false);
        record::view(it, &ViewFacts { grant: None, data, running })
    }

    pub fn grant(&self, id: &str) -> Result<Grant> {
        self.get(id).map(|it| record::current_grant(&it)).ok_or_else(gone)
    }

    pub async fn update(&self, id: &str, f: &Fields) -> Result<StuffItem> {
        let _w = self.write.lock().await;
        let mut it = self.get(id).ok_or_else(gone)?;
        f.apply(&mut it);
        self.put(it).await
    }

    /// Back to the version before the last change.
    pub async fn restore(&self, id: &str) -> Result<StuffItem> {
        let _w = self.write.lock().await;
        let it = self.get(id).ok_or_else(gone)?;
        let back = record::restore(&it, self.now())?;
        self.put(back).await
    }

    /// What you allowed a pane: only what its wisp-app.json asks for. A write scope is tied to its
    /// code as it is now.
    pub async fn allow(&self, id: &str, uses: &[String]) -> Result<StuffItem> {
        let _w = self.write.lock().await;
        let mut it = self.get(id).filter(|x| x.kind == StuffKind::App).ok_or_else(|| bad(404, "That’s not an app in My Stuff."))?;
        let allowed = grant_of(it.uses.as_deref().unwrap_or_default(), uses);
        let tied = allowed.iter().any(|x| is_write(x));
        it.grant_hash = tied.then(|| hash_now(&it));
        it.allowed = (!allowed.is_empty()).then_some(allowed);
        self.put(it).await
    }

    /// Where an app is published, or None once it's taken down.
    pub async fn set_published(&self, id: &str, published: Option<Published>) -> Result<StuffItem> {
        let _w = self.write.lock().await;
        let mut it = self.get(id).ok_or_else(gone)?;
        it.published = published;
        self.put(it).await
    }

    /// Gone from My Stuff: the record and its database. Its bytes stay in the CAS until nothing
    /// refers to them (the store's collection), so an undo or a shared blob never breaks.
    pub async fn remove(&self, id: &str) -> Result<bool> {
        let _w = self.write.lock().await;
        if self.get(id).is_none() {
            return Ok(false);
        }
        self.rows.delete_item(id).await?;
        self.items.write().map_err(|_| Error::Poisoned)?.remove(id);
        remove_data(&self.data_file(id)).await;
        Ok(true)
    }

    /// Its data gone: the next query makes the database again from its seed.
    pub async fn reset_data(&self, id: &str) -> Result<StuffItem> {
        let it = self.get(id).ok_or_else(gone)?;
        if it.db.is_none() {
            return Err(bad(404, "That app has no database."));
        }
        remove_data(&self.data_file(id)).await;
        Ok(it)
    }

    /// A readable copy of an item's content on this computer, for an agent (`file:`, `folder:`): a
    /// file under `files/<hash>/<name>`, an app under `apps/<code>/`. Made once, never changed.
    pub async fn local_path(&self, it: &StuffItem) -> Result<String> {
        if let Some(p) = it.path.as_ref().filter(|_| it.blob.is_none() && it.tree.is_none()) {
            return Ok(p.clone());
        }
        if let (Some(tree), Some(code)) = (&it.tree, &it.code) {
            let dest = self.dir.join("apps").join(code);
            crate::appfiles::checkout(self.blobs.as_ref(), tree, &dest).await?;
            return Ok(dest.to_string_lossy().into_owned());
        }
        match &it.blob {
            Some(h) => self.blob_file(h, &it.name).await.map(|p| p.to_string_lossy().into_owned()),
            None => Ok(String::new()),
        }
    }

    pub(crate) async fn blob_file(&self, hash: &str, name: &str) -> Result<PathBuf> {
        let dir = self.dir.join("files").join(hash);
        let file = dir.join(wisp_stuff_core::kind::safe_name(name, "file"));
        if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
            tokio::fs::create_dir_all(&dir).await?;
            crate::appfiles::put_file(self.blobs.as_ref(), hash, &file).await?;
        }
        Ok(file)
    }

    /// The bytes of a file item (an imported v1 record whose bytes aren't in the CAS yet: its file).
    pub async fn bytes(&self, it: &StuffItem) -> Result<Option<Arc<Vec<u8>>>> {
        if let Some(h) = &it.blob {
            return self.blobs.get(h).await;
        }
        match &it.path {
            Some(p) if it.kind != StuffKind::App => Ok(tokio::fs::read(p).await.ok().map(Arc::new)),
            _ => Ok(None),
        }
    }
}

async fn remove_data(file: &Path) {
    for ext in ["", "-wal", "-shm"] {
        let mut p = file.as_os_str().to_owned();
        p.push(ext);
        let _ = tokio::fs::remove_file(PathBuf::from(p)).await;
    }
}
