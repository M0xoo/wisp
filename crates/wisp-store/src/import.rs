//! The v1 import framework (plan §4.8). v1 keeps one JSON file per session (`sessions/<id>.json`, written
//! temp + rename, `.light/` summaries beside them) and a few config files. The owner plugin supplies the
//! handler; this runs it in one transaction per file and records the file's (mtime, size) in `meta` in
//! that same transaction, so an import stopped at any point resumes where it was, and a file v1 rewrote
//! since is imported again. One way only (ADR-0031): nothing writes v1's files back.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use wisp_kernel::CancellationToken;

use crate::error::{Result, StoreError, invalid};
use crate::store::Store;
use crate::writer::Writer;

/// One file, already read (the handler runs on the writer thread, which must not wait on the disk).
#[derive(Debug, Clone)]
pub struct ImportFile {
    pub path: PathBuf,
    pub name: String,
    pub mtime_ns: u64,
    pub size: u64,
    pub bytes: Vec<u8>,
}

impl ImportFile {
    pub fn text(&self) -> Result<&str> {
        std::str::from_utf8(&self.bytes).map_err(|e| invalid(format!("{} is not UTF-8: {e}", self.name)))
    }
    /// Parsed JSON; a cut-off or corrupt file fails, and the file is recorded as failed.
    pub fn json<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.bytes).map_err(|e| invalid(format!("{} is not valid JSON: {e}", self.name)))
    }
}

/// Picks the files to import by name.
pub type Pattern = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Writes the file's rows; must be safe to run again for a file that changed (upsert, not insert).
pub type ImportHandler = Arc<dyn Fn(&ImportFile, &mut Writer<'_>) -> Result<()> + Send + Sync>;

pub struct ImportOptions {
    /// the import's name, owner-prefixed (`runtime.sessions`): its progress is kept under it
    pub name: String,
    pub dir: PathBuf,
    /// which files in `dir` (not recursive) to import; `*.json` by default. Temp files never match.
    pub pattern: Option<Pattern>,
    pub cancel: Option<CancellationToken>,
}

impl std::fmt::Debug for ImportOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportOptions").field("name", &self.name).field("dir", &self.dir).finish_non_exhaustive()
    }
}

impl ImportOptions {
    pub fn new(name: &str, dir: impl Into<PathBuf>) -> Self {
        Self { name: name.to_owned(), dir: dir.into(), pattern: None, cancel: None }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    pub imported: Vec<String>,
    /// already imported with the same mtime and size, or failed before and unchanged since
    pub unchanged: u64,
    pub failed: Vec<(String, String)>,
    /// true when the cancel token stopped it before the last file
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Mark {
    mtime_ns: u64,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn valid_name(s: &str) -> bool {
    crate::migrate::valid_owner(s)
}

fn has_ext(name: &str, ext: &str) -> bool {
    Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn mark_key(import: &str, file: &str) -> String {
    format!("import:{import}:{file}")
}

async fn stat(path: &Path) -> Option<(u64, u64)> {
    let m = tokio::fs::metadata(path).await.ok().filter(std::fs::Metadata::is_file)?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some((u64::try_from(mtime.as_nanos()).unwrap_or(u64::MAX), m.len()))
}

/// Imports every matching file in `opts.dir` that is new or changed since its last import.
pub async fn import_files(store: &Store, opts: ImportOptions, handle: ImportHandler) -> Result<ImportReport> {
    if !valid_name(&opts.name) {
        return Err(invalid(format!("bad import name: {}", opts.name)));
    }
    let mut report = ImportReport::default();
    let mut names = Vec::new();
    let mut dir = match tokio::fs::read_dir(&opts.dir).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report), // nothing to import
        Err(e) => return Err(e.into()),
    };
    while let Some(e) = dir.next_entry().await? {
        let n = e.file_name().to_string_lossy().into_owned();
        let wanted = opts.pattern.as_ref().map_or_else(|| has_ext(&n, "json"), |p| p(&n));
        if wanted && !has_ext(&n, "tmp") {
            names.push(n);
        }
    }
    names.sort();
    for name in names {
        if opts.cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            report.stopped = true;
            break;
        }
        import_one(store, &opts, &handle, &name, &mut report).await?;
    }
    Ok(report)
}

async fn import_one(store: &Store, opts: &ImportOptions, handle: &ImportHandler, name: &str, report: &mut ImportReport) -> Result<()> {
    let path = opts.dir.join(name);
    let Some((mtime_ns, size)) = stat(&path).await else {
        return Ok(());
    }; // gone since the listing, or a folder
    let key = mark_key(&opts.name, name);
    let had: Option<Mark> = store
        .read_async({
            let key = key.clone();
            move |r| Ok(r.get_meta(&key)?.and_then(|v| serde_json::from_str(&v).ok()))
        })
        .await?;
    if had.is_some_and(|m| m.mtime_ns == mtime_ns && m.size == size) {
        report.unchanged += 1;
        return Ok(());
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return Ok(());
    };
    let file = ImportFile { path, name: name.to_owned(), mtime_ns, size, bytes };
    let mark = serde_json::to_string(&Mark { mtime_ns, size, error: None })?;
    let (h, k) = (handle.clone(), key.clone());
    match store
        .write(move |w| {
            h(&file, w)?;
            w.set_meta(&k, Some(&mark))
        })
        .await
    {
        Ok(()) => report.imported.push(name.to_owned()),
        Err(StoreError::Closed) => return Err(StoreError::Closed),
        Err(e) => {
            let error = e.to_string();
            // Recorded so it isn't retried on every start; a new mtime or size retries it.
            let failed = serde_json::to_string(&Mark { mtime_ns, size, error: Some(error.clone()) })?;
            store.write(move |w| w.set_meta(&key, Some(&failed))).await?;
            report.failed.push((name.to_owned(), error));
        }
    }
    Ok(())
}
