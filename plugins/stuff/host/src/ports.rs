//! What the shelf needs from the store, as two narrow traits: the CAS (`Blobs`) and the rows
//! (`Rows`). wisp-store isn't built yet: these are the signatures to back with it (blob put/get by
//! BLAKE3 hash, the `stuff_item` and `stuff_upload` tables). Until then: an in-memory pair for tests
//! and a pair on disk (`FsBlobs`, `JsonRows`) so the plugin keeps what it's given.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use wisp_kernel::BoxFuture;
use wisp_stuff_api::{StuffItem, Upload};

use crate::error::{Error, Result};

/// The CAS: content by its BLAKE3 hash (hex). Putting the same bytes twice keeps one copy.
pub trait Blobs: Send + Sync + 'static {
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'static, Result<String>>;
    fn get(&self, hash: &str) -> BoxFuture<'static, Result<Option<Arc<Vec<u8>>>>>;
    /// a file holding exactly these bytes, if the CAS keeps them as one (a hard link saves a copy)
    fn file(&self, _hash: &str) -> Option<PathBuf> {
        None
    }
}

/// My Stuff's rows: items (records with their hashes) and uploads.
pub trait Rows: Send + Sync + 'static {
    fn items(&self) -> BoxFuture<'static, Result<Vec<StuffItem>>>;
    fn put_item(&self, it: StuffItem) -> BoxFuture<'static, Result<()>>;
    fn delete_item(&self, id: &str) -> BoxFuture<'static, Result<bool>>;
    fn upload(&self, id: &str) -> BoxFuture<'static, Result<Option<Upload>>>;
    fn put_upload(&self, u: Upload) -> BoxFuture<'static, Result<()>>;
    fn delete_upload(&self, id: &str) -> BoxFuture<'static, Result<bool>>;
}

pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[derive(Debug, Default)]
pub struct MemBlobs {
    map: RwLock<HashMap<String, Arc<Vec<u8>>>>,
}

impl MemBlobs {
    pub fn len(&self) -> usize {
        self.map.read().map_or(0, |m| m.len())
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Blobs for MemBlobs {
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'static, Result<String>> {
        let h = hash(&bytes);
        let ok = self.map.write().map(|mut m| {
            m.entry(h.clone()).or_insert_with(|| Arc::new(bytes));
        }).is_ok();
        Box::pin(async move { if ok { Ok(h) } else { Err(Error::Poisoned) } })
    }
    fn get(&self, hash: &str) -> BoxFuture<'static, Result<Option<Arc<Vec<u8>>>>> {
        let r = self.map.read().map(|m| m.get(hash).cloned()).map_err(|_| Error::Poisoned);
        Box::pin(async move { r })
    }
}

/// Blobs on disk, uncompressed, at `<dir>/<aa>/<hash>`: written once (temp file, then rename).
#[derive(Debug, Clone)]
pub struct FsBlobs {
    dir: PathBuf,
}

impl FsBlobs {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
    fn at(&self, hash: &str) -> Option<PathBuf> {
        let ok = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
        ok.then(|| self.dir.join(&hash[..2]).join(hash))
    }
}

impl Blobs for FsBlobs {
    fn put(&self, bytes: Vec<u8>) -> BoxFuture<'static, Result<String>> {
        let h = hash(&bytes);
        let at = self.at(&h);
        Box::pin(async move {
            let at = at.ok_or(Error::Poisoned)?;
            if tokio::fs::try_exists(&at).await.unwrap_or(false) {
                return Ok(h);
            }
            if let Some(d) = at.parent() {
                tokio::fs::create_dir_all(d).await?;
            }
            let tmp = at.with_extension(format!("tmp-{}", wisp_kernel::ids::uuid7()));
            tokio::fs::write(&tmp, &bytes).await?;
            tokio::fs::rename(&tmp, &at).await?;
            Ok(h)
        })
    }
    fn get(&self, hash: &str) -> BoxFuture<'static, Result<Option<Arc<Vec<u8>>>>> {
        let at = self.at(hash);
        Box::pin(async move {
            let Some(at) = at else { return Ok(None) };
            match tokio::fs::read(&at).await {
                Ok(b) => Ok(Some(Arc::new(b))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
    }
    fn file(&self, hash: &str) -> Option<PathBuf> {
        self.at(hash)
    }
}

#[derive(Debug, Default)]
pub struct MemRows {
    items: RwLock<HashMap<String, StuffItem>>,
    uploads: RwLock<HashMap<String, Upload>>,
}

fn ready<T: Send + 'static>(r: Result<T>) -> BoxFuture<'static, Result<T>> {
    Box::pin(async move { r })
}

impl Rows for MemRows {
    fn items(&self) -> BoxFuture<'static, Result<Vec<StuffItem>>> {
        ready(self.items.read().map(|m| m.values().cloned().collect()).map_err(|_| Error::Poisoned))
    }
    fn put_item(&self, it: StuffItem) -> BoxFuture<'static, Result<()>> {
        ready(self.items.write().map(|mut m| drop(m.insert(it.id.clone(), it))).map_err(|_| Error::Poisoned))
    }
    fn delete_item(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        ready(self.items.write().map(|mut m| m.remove(id).is_some()).map_err(|_| Error::Poisoned))
    }
    fn upload(&self, id: &str) -> BoxFuture<'static, Result<Option<Upload>>> {
        ready(self.uploads.read().map(|m| m.get(id).cloned()).map_err(|_| Error::Poisoned))
    }
    fn put_upload(&self, u: Upload) -> BoxFuture<'static, Result<()>> {
        ready(self.uploads.write().map(|mut m| drop(m.insert(u.id.clone(), u))).map_err(|_| Error::Poisoned))
    }
    fn delete_upload(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        ready(self.uploads.write().map(|mut m| m.remove(id).is_some()).map_err(|_| Error::Poisoned))
    }
}

/// Rows as one JSON file per record (`<dir>/items/<id>.json`, `<dir>/uploads/<id>.json`): the stand-in
/// until wisp-store's tables, written atomically (temp file, then rename).
#[derive(Debug, Clone)]
pub struct JsonRows {
    dir: PathBuf,
}

impl JsonRows {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn write_json(dir: PathBuf, id: String, v: serde_json::Value) -> Result<()> {
    if !safe_id(&id) {
        return Err(Error::Bad(wisp_stuff_core::Bad::new(400, "bad id")));
    }
    tokio::fs::create_dir_all(&dir).await?;
    let tmp = dir.join(format!(".{id}.tmp"));
    tokio::fs::write(&tmp, serde_json::to_vec(&v)?).await?;
    tokio::fs::rename(&tmp, dir.join(format!("{id}.json"))).await?;
    Ok(())
}

pub(crate) async fn read_all<T: serde::de::DeserializeOwned>(dir: &Path) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else { return Ok(out) };
    while let Some(e) = rd.next_entry().await? {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "json")
            && let Ok(b) = tokio::fs::read(&p).await
            && let Ok(v) = serde_json::from_slice(&b)
        {
            out.push(v);
        }
    }
    Ok(out)
}

async fn remove(path: PathBuf) -> Result<bool> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

impl Rows for JsonRows {
    fn items(&self) -> BoxFuture<'static, Result<Vec<StuffItem>>> {
        let d = self.dir.join("items");
        Box::pin(async move { read_all(&d).await })
    }
    fn put_item(&self, it: StuffItem) -> BoxFuture<'static, Result<()>> {
        let d = self.dir.join("items");
        Box::pin(async move { write_json(d, it.id.clone(), serde_json::to_value(&it)?).await })
    }
    fn delete_item(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        let ok = safe_id(id);
        let p = self.dir.join("items").join(format!("{id}.json"));
        Box::pin(async move { if ok { remove(p).await } else { Ok(false) } })
    }
    fn upload(&self, id: &str) -> BoxFuture<'static, Result<Option<Upload>>> {
        let ok = safe_id(id);
        let p = self.dir.join("uploads").join(format!("{id}.json"));
        Box::pin(async move {
            if !ok {
                return Ok(None);
            }
            match tokio::fs::read(&p).await {
                Ok(b) => Ok(serde_json::from_slice(&b).ok()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
    }
    fn put_upload(&self, u: Upload) -> BoxFuture<'static, Result<()>> {
        let d = self.dir.join("uploads");
        Box::pin(async move { write_json(d, u.id.clone(), serde_json::to_value(&u)?).await })
    }
    fn delete_upload(&self, id: &str) -> BoxFuture<'static, Result<bool>> {
        let ok = safe_id(id);
        let p = self.dir.join("uploads").join(format!("{id}.json"));
        Box::pin(async move { if ok { remove(p).await } else { Ok(false) } })
    }
}
