//! An app's folder into the CAS: walk it (without what a build makes again or files that hold
//! secrets), cap it, put each file in, and record its tree and its v1-compatible code hash. And the
//! way back: a tree checked out into a folder an agent can read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use wisp_stuff_api::AppFile;
use wisp_stuff_core::app::{CodeHasher, scans_for_risk, skipped, sort_rels, webrtc_in};
use wisp_stuff_core::kind::{MAX_APP, MAX_APP_FILES};

use crate::error::{Result, bad};
use crate::ports::Blobs;

/// What an app's folder became.
#[derive(Debug, Clone)]
pub struct Stored {
    pub files: Vec<AppFile>,
    pub tree: String,
    pub code: String,
    pub size: u64,
    pub risky: bool,
}

fn too_big() -> crate::error::Error {
    bad(413, format!("That app is too big for My Stuff ({MAX_APP_FILES} files, 200 MB at most, without node_modules)."))
}

/// Where a file's bytes come from: the folder being saved, or a starter compiled into wisp.
#[derive(Debug, Clone)]
pub enum Src {
    Disk(PathBuf),
    Mem(&'static [u8]),
}

/// Every file of the folder that's kept: `(rel, where, size)`, links left out (as v1's copy did),
/// in v1's hash order.
pub async fn walk(src: &Path) -> Result<Vec<(String, Src, u64)>> {
    let mut out = Vec::new();
    let mut stack = vec![(src.to_path_buf(), String::new())];
    let mut total = 0u64;
    while let Some((dir, rel)) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(e) = rd.next_entry().await? {
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let ft = e.file_type().await?;
            if skipped(&name, &r, ft.is_file()) {
                continue;
            }
            if ft.is_dir() {
                stack.push((e.path(), r));
            } else if ft.is_file() {
                let size = e.metadata().await?.len();
                total += size;
                if out.len() >= MAX_APP_FILES as usize || total > MAX_APP {
                    return Err(too_big());
                }
                out.push((r, Src::Disk(e.path()), size));
            }
        }
    }
    sort_rels(&mut out, |f| f.0.as_str());
    Ok(out)
}

/// Puts each file in the CAS, in path order, hashing as it goes.
pub async fn store(blobs: &dyn Blobs, files: Vec<(String, Src, u64)>) -> Result<Stored> {
    let mut h = CodeHasher::new();
    let mut list = Vec::with_capacity(files.len());
    let mut size = 0;
    let mut risky = false;
    for (rel, src, _) in files {
        let bytes = match src {
            Src::Disk(p) => tokio::fs::read(&p).await?,
            Src::Mem(b) => b.to_vec(),
        };
        let n = bytes.len() as u64;
        h.file(&rel, n, &bytes);
        risky |= scans_for_risk(&rel) && webrtc_in(&bytes);
        size += n;
        let hash = blobs.put(bytes).await?;
        list.push(AppFile { rel, hash, size: n });
    }
    let tree = blobs.put(serde_json::to_vec(&list)?).await?;
    Ok(Stored { files: list, tree, code: h.finish(), size, risky })
}

/// The tree of an app, by its hash: `rel → (hash, size)`.
pub async fn tree(blobs: &dyn Blobs, hash: &str) -> Result<Arc<HashMap<String, (String, u64)>>> {
    let bytes = blobs.get(hash).await?.ok_or_else(|| bad(404, "The app’s files are gone."))?;
    let list: Vec<AppFile> = serde_json::from_slice(&bytes)?;
    Ok(Arc::new(list.into_iter().map(|f| (f.rel, (f.hash, f.size))).collect()))
}

/// The tree checked out at `dest` (once: a folder named by its code hash never changes).
pub async fn checkout(blobs: &dyn Blobs, tree_hash: &str, dest: &Path) -> Result<()> {
    if tokio::fs::try_exists(dest).await.unwrap_or(false) {
        return Ok(());
    }
    let t = tree(blobs, tree_hash).await?;
    let tmp = dest.with_extension(format!("tmp-{}", wisp_kernel::ids::uuid7()));
    for (rel, (hash, _)) in t.iter() {
        let file = tmp.join(rel);
        if let Some(d) = file.parent() {
            tokio::fs::create_dir_all(d).await?;
        }
        put_file(blobs, hash, &file).await?;
    }
    tokio::fs::create_dir_all(&tmp).await?;
    if let Err(e) = tokio::fs::rename(&tmp, dest).await {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        if !tokio::fs::try_exists(dest).await.unwrap_or(false) {
            return Err(e.into());
        }
    }
    Ok(())
}

/// One blob as a file: a hard link to the CAS's own copy when it keeps one, else its bytes.
pub async fn put_file(blobs: &dyn Blobs, hash: &str, file: &Path) -> Result<()> {
    if let Some(src) = blobs.file(hash)
        && tokio::fs::hard_link(&src, file).await.is_ok()
    {
        return Ok(());
    }
    let bytes = blobs.get(hash).await?.ok_or_else(|| bad(404, "The file is gone."))?;
    tokio::fs::write(file, bytes.as_slice()).await?;
    Ok(())
}
