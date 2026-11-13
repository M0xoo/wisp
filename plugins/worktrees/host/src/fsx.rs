//! The few file operations the plugin makes, all async (nothing blocks a runtime thread).

use std::path::{Path, PathBuf};

pub async fn exists(p: impl AsRef<Path>) -> bool {
    tokio::fs::try_exists(p).await.unwrap_or(false)
}

/// The file's text, or None when it isn't there or isn't readable.
pub async fn read_opt(p: impl AsRef<Path>) -> Option<String> {
    tokio::fs::read_to_string(p).await.ok()
}

/// The real path (symlinks, macOS's /private/tmp), else the path as given.
pub async fn real(p: &str) -> String {
    tokio::fs::canonicalize(p).await.map_or_else(|_| p.to_owned(), |r| r.to_string_lossy().into_owned())
}

pub async fn mkdirp(p: impl AsRef<Path>) -> std::io::Result<()> {
    tokio::fs::create_dir_all(p).await
}

/// Removes a file or a tree; gone already is fine.
pub async fn rm_rf(p: impl AsRef<Path>) {
    let p = p.as_ref();
    match tokio::fs::symlink_metadata(p).await {
        Ok(m) if m.is_dir() => drop(tokio::fs::remove_dir_all(p).await),
        Ok(_) => drop(tokio::fs::remove_file(p).await),
        Err(_) => {}
    }
}

/// Names in a folder with whether each is a folder; empty when it can't be read.
pub async fn entries(dir: impl AsRef<Path>) -> Vec<(String, bool)> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        let is_dir = e.file_type().await.is_ok_and(|t| t.is_dir());
        out.push((e.file_name().to_string_lossy().into_owned(), is_dir));
    }
    out
}

/// A folder's mtime in ms, or None when it's gone.
pub async fn mtime_ms(p: impl AsRef<Path>) -> Option<i64> {
    let m = tokio::fs::metadata(p).await.ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(t.as_millis()).ok()
}

pub fn join(a: &str, b: &str) -> String {
    PathBuf::from(a).join(b).to_string_lossy().into_owned()
}

pub fn parent(p: &str) -> String {
    Path::new(p).parent().map_or_else(|| p.to_owned(), |d| d.to_string_lossy().into_owned())
}
