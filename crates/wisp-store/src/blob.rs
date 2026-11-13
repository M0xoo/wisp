//! Content-addressed blobs (plan §4.1): diffs, raw answers, attachments, screenshots. Keyed by BLAKE3, so
//! a diff snapshot that repeats is stored once; zstd-compressed unless that doesn't shrink it. Up to 64 KB
//! (compressed) they live in the row; bigger ones in `<home>/blobs/ab/cdef…`, written temp + fsync +
//! rename so a crash never leaves half a file under a real name. Refcounted by owner; `gc` frees the rest.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError, invalid};
use crate::store::Store;
use crate::writer::Writer;

pub const INLINE_MAX: usize = 64 * 1024;
const ALGO: &str = "blake3";
/// an orphan file younger than this may belong to a put whose row has not committed yet
const ORPHAN_GRACE_MS: i64 = 10 * 60 * 1000;
const ZSTD_LEVEL: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    Zstd,
    /// already-compressed content (PNG, MP4) that zstd didn't shrink
    Raw,
}

impl Codec {
    fn as_str(self) -> &'static str {
        match self {
            Self::Zstd => "zstd",
            Self::Raw => "raw",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobInfo {
    pub hash: String,
    /// uncompressed bytes
    pub size: u64,
    pub codec: Codec,
    pub inline: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GcResult {
    pub blobs: u64,
    pub files: u64,
    /// uncompressed bytes freed
    pub bytes: u64,
}

/// Who holds a ref: `(owner_kind, owner_id)`, e.g. `("turn", "t1")`.
pub type Owner<'a> = (&'a str, &'a str);

pub fn hash_of(data: &[u8]) -> String {
    format!("{ALGO}:{}", blake3::hash(data).to_hex())
}

/// A blob ready to record: hashed, compressed, and (when big) already on disk.
struct Prepared {
    info: BlobInfo,
    inline: Option<Vec<u8>>,
}

fn prepare(data: &[u8], home: Option<&Path>) -> Result<Prepared> {
    let hash = hash_of(data);
    let packed = zstd::bulk::compress(data, ZSTD_LEVEL)?;
    let (codec, bytes) = if packed.len() < data.len() { (Codec::Zstd, packed) } else { (Codec::Raw, data.to_vec()) };
    let size = data.len() as u64;
    match home {
        Some(home) if bytes.len() > INLINE_MAX => {
            write_atomic(&path_of(home, &hash)?, &bytes)?;
            Ok(Prepared { info: BlobInfo { hash, size, codec, inline: false }, inline: None })
        }
        _ => Ok(Prepared { info: BlobInfo { hash, size, codec, inline: true }, inline: Some(bytes) }), // in memory: no files
    }
}

fn existing(db: &Connection, hash: &str) -> Result<Option<BlobInfo>> {
    let row: Option<(i64, String, bool)> = db
        .prepare_cached("SELECT size, codec, data IS NOT NULL FROM blob WHERE hash = ?")?
        .query_row([hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    row.map(|(size, codec, inline)| {
        Ok(BlobInfo { hash: hash.to_owned(), size: u64::try_from(size).unwrap_or(0), codec: parse_codec(&codec)?, inline })
    })
    .transpose()
}

fn parse_codec(s: &str) -> Result<Codec> {
    match s {
        "zstd" => Ok(Codec::Zstd),
        "raw" => Ok(Codec::Raw),
        other => Err(StoreError::Internal(format!("unknown blob codec {other}"))),
    }
}

fn record(w: &mut Writer<'_>, p: Prepared, owner: Option<Owner<'_>>) -> Result<BlobInfo> {
    let db = w.db;
    let info = if let Some(had) = existing(db, &p.info.hash)? {
        had
    } else {
        let size = i64::try_from(p.info.size).map_err(|_| invalid("blob too large"))?;
        db.prepare_cached("INSERT INTO blob (hash, size, codec, data, at) VALUES (?, ?, ?, ?, ?)")?.execute(params![
            p.info.hash,
            size,
            p.info.codec.as_str(),
            p.inline,
            w.now
        ])?;
        p.info
    };
    if let Some((kind, id)) = owner {
        w.blob_ref(&info.hash, kind, id)?;
    }
    Ok(info)
}

impl Writer<'_> {
    /// Stores bytes (once per content) in this transaction and, given an owner, refs them for it.
    /// Compresses on the writer thread: from async code prefer `Store::put_blob`.
    pub fn put_blob(&mut self, data: &[u8], owner: Option<Owner<'_>>) -> Result<BlobInfo> {
        let home = if self.shared.memory { None } else { self.shared.home.clone() };
        let p = self.guard(|_| prepare(data, home.as_deref()))?;
        self.guard(|w| record(w, p, owner))
    }

    pub fn blob_ref(&mut self, hash: &str, owner_kind: &str, owner_id: &str) -> Result<()> {
        self.guard(|w| {
            if existing(w.db, hash)?.is_none() {
                return Err(StoreError::NotFound(format!("no blob {hash}")));
            }
            w.db.prepare_cached("INSERT OR IGNORE INTO blob_ref (hash, owner_kind, owner_id) VALUES (?, ?, ?)")?
                .execute([hash, owner_kind, owner_id])?;
            Ok(())
        })
    }

    pub fn blob_unref(&mut self, hash: &str, owner_kind: &str, owner_id: &str) -> Result<()> {
        self.guard(|w| {
            Ok(w.db
                .prepare_cached("DELETE FROM blob_ref WHERE hash = ? AND owner_kind = ? AND owner_id = ?")?
                .execute([hash, owner_kind, owner_id])
                .map(|_| ())?)
        })
    }

    /// Drops every ref an owner holds (a session deleted); returns how many.
    pub fn blob_unref_owner(&mut self, owner_kind: &str, owner_id: &str) -> Result<u64> {
        self.guard(|w| {
            Ok(w.db.prepare_cached("DELETE FROM blob_ref WHERE owner_kind = ? AND owner_id = ?")?.execute([owner_kind, owner_id])? as u64)
        })
    }
}

impl Store {
    /// Hashes and compresses on tokio's blocking pool (and writes a big blob's file there), then records
    /// the row on the writer thread, so a screenshot never holds up other writes.
    pub async fn put_blob(&self, data: Vec<u8>, owner: Option<(String, String)>) -> Result<BlobInfo> {
        let home = if self.shared.memory { None } else { self.shared.home.clone() };
        let p = tokio::task::spawn_blocking(move || prepare(&data, home.as_deref()))
            .await
            .map_err(|e| StoreError::Internal(e.to_string()))??;
        self.write(move |w| record(w, p, owner.as_ref().map(|(k, i)| (k.as_str(), i.as_str())))).await
    }

    pub fn blob(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        self.read(|r| r.blob(hash))
    }

    /// Removes blobs nobody refs (rows, then files), and files under `blobs/` that no row names and that
    /// are older than ten minutes (a put that rolled back).
    pub async fn gc_blobs(&self) -> Result<GcResult> {
        let (mut out, gone) = self
            .write(|w| {
                let mut out = GcResult::default();
                let mut gone = Vec::new();
                let mut st = w.db.prepare_cached(
                    "SELECT hash, size, data IS NULL FROM blob WHERE NOT EXISTS (SELECT 1 FROM blob_ref r WHERE r.hash = blob.hash)",
                )?;
                let rows: Vec<(String, i64, bool)> =
                    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
                for (hash, size, on_disk) in rows {
                    w.db.prepare_cached("DELETE FROM blob WHERE hash = ?")?.execute([&hash])?;
                    out.blobs += 1;
                    out.bytes += u64::try_from(size).unwrap_or(0);
                    if on_disk {
                        gone.push(hash);
                    }
                }
                Ok((out, gone))
            })
            .await?;
        let Some(home) = self.shared.home.clone().filter(|_| !self.shared.memory) else {
            return Ok(out);
        };
        // Files go after the rows commit: a crash in between leaves an orphan file, never a row without one.
        let store = self.clone();
        let now = self.shared.clock.now_ms();
        out.files = tokio::task::spawn_blocking(move || -> Result<u64> {
            let mut n = 0;
            for h in gone {
                if fs::remove_file(path_of(&home, &h)?).is_ok() {
                    n += 1;
                }
            }
            Ok(n + sweep_orphans(&store, &home, now)?)
        })
        .await
        .map_err(|e| StoreError::Internal(e.to_string()))??;
        Ok(out)
    }
}

fn sweep_orphans(store: &Store, home: &Path, now: i64) -> Result<u64> {
    let root = home.join("blobs");
    let Ok(dirs) = fs::read_dir(&root) else {
        return Ok(0);
    };
    let mut n = 0;
    for dir in dirs.flatten() {
        let d = dir.file_name().to_string_lossy().into_owned();
        if d.len() != 2 || !d.bytes().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        for f in fs::read_dir(dir.path())?.flatten() {
            let hex = format!("{d}{}", f.file_name().to_string_lossy());
            let named = hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit());
            let orphan = !named || !store.read(|r| r.blob_exists(&format!("{ALGO}:{hex}")))?;
            let old = f
                .metadata()?
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|t| now - i64::try_from(t.as_millis()).unwrap_or(i64::MAX) > ORPHAN_GRACE_MS);
            if orphan && old && fs::remove_file(f.path()).is_ok() {
                n += 1;
            }
        }
    }
    Ok(n)
}

pub(crate) fn get(db: &Connection, home: Option<&Path>, hash: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(String, Option<Vec<u8>>)> =
        db.prepare_cached("SELECT codec, data FROM blob WHERE hash = ?")?.query_row([hash], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let Some((codec, data)) = row else {
        return Ok(None);
    };
    let packed = if let Some(d) = data {
        d
    } else {
        let home = home.ok_or_else(|| StoreError::Internal(format!("blob {hash} is on disk but the store has no home")))?;
        fs::read(path_of(home, hash)?).map_err(|_| StoreError::NotFound(format!("blob {hash} is recorded but its file is missing")))?
    };
    Ok(Some(match parse_codec(&codec)? {
        Codec::Raw => packed,
        Codec::Zstd => zstd::stream::decode_all(packed.as_slice())?,
    }))
}

pub(crate) fn exists(db: &Connection, hash: &str) -> Result<bool> {
    Ok(existing(db, hash)?.is_some())
}

pub(crate) fn refs(db: &Connection, hash: &str) -> Result<u64> {
    let n: i64 = db.prepare_cached("SELECT count(*) FROM blob_ref WHERE hash = ?")?.query_row([hash], |r| r.get(0))?;
    Ok(u64::try_from(n).unwrap_or(0))
}

fn path_of(home: &Path, hash: &str) -> Result<PathBuf> {
    let hex = hash.strip_prefix("blake3:").filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    let hex = hex.ok_or_else(|| invalid(format!("bad blob hash {hash}")))?;
    Ok(home.join("blobs").join(&hex[..2]).join(&hex[2..]))
}

pub(crate) fn write_atomic(file: &Path, data: &[u8]) -> Result<()> {
    let dir = file.parent().ok_or_else(|| invalid("a file needs a folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = file.with_extension(format!("{}.{}.tmp", std::process::id(), uuid::Uuid::now_v7().simple()));
    let mut f = fs::File::create(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, file)?;
    Ok(())
}
