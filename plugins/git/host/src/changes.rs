//! Changes (edge case Git 10): every file the work changed since it left its base, from the merge-base
//! so what lands on the base later is never the work's; untracked files whole (≤ 200, binary when a NUL
//! is in the first 8000 bytes); ≤ 2000 rows per file. Big diffs parse off the runtime's workers, and a
//! result past `INLINE_MAX` goes to the blob store by reference.

use std::path::Path;

use tokio::task::JoinSet;
use wisp_git_api::{Body, Changes, DiffRequest, FileDiff, FileStat};
use wisp_git_core::diff::{finish, parse_diff, untracked_file, UNTRACKED_MAX};
use wisp_git_core::porcelain::paths;
use wisp_git_core::stage::{hunk_states, hunkable, split_diff, APPLY_DIFF};

use crate::error::{GitError, Result};
use crate::repo::Inner;

/// Changes before it is packed into inline files or a blob.
#[derive(Debug)]
pub struct Collected {
    pub base: String,
    pub at: String,
    pub files: Vec<FileDiff>,
    pub untracked: u32,
    pub staged: Option<u32>,
}

/// A diff's files sent inline up to this much JSON; past it, a blob ref.
pub const INLINE_MAX: usize = 512 * 1024;
/// Output this big is parsed on the blocking pool, not a runtime worker.
const PARSE_OFF_THREAD: usize = 256 * 1024;

async fn parse(out: Vec<u8>) -> Result<Vec<FileDiff>> {
    if out.len() < PARSE_OFF_THREAD {
        return Ok(parse_diff(&String::from_utf8_lossy(&out)));
    }
    tokio::task::spawn_blocking(move || parse_diff(&String::from_utf8_lossy(&out))).await.map_err(|e| GitError::Io(e.to_string()))
}

impl Inner {
    pub async fn changes(&self, base: &str, inline: bool) -> Result<Option<Changes>> {
        let Some(c) = self.collect(base).await? else { return Ok(None) };
        Ok(Some(self.pack(c, inline).await?))
    }

    /// Changes' files, not yet packed: the command layer adds stage state and masking first.
    pub async fn collect(&self, base: &str) -> Result<Option<Collected>> {
        let Some(at) = self.merge_base("HEAD", base).await? else { return Ok(None) };
        let out = self.git.raw(&self.dir, &["diff", "--no-color", "--no-ext-diff", "-M", "-U3", &at]).await?;
        let mut files = parse(out).await?;
        let untracked = paths(&String::from_utf8_lossy(&self.git.raw(&self.dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await?));
        let extra = untracked.len().saturating_sub(UNTRACKED_MAX);
        files.extend(read_untracked(&self.dir, untracked.into_iter().take(UNTRACKED_MAX).collect()).await);
        let files = tokio::task::spawn_blocking(move || {
            let mut files = files;
            finish(&mut files);
            files
        })
        .await
        .map_err(|e| GitError::Io(e.to_string()))?;
        let base = base.strip_prefix("refs/remotes/").and_then(|b| b.split_once('/')).map_or(base, |(_, b)| b).to_owned();
        Ok(Some(Collected { base, at, files, untracked: u32::try_from(extra).unwrap_or(u32::MAX), staged: None }))
    }

    pub async fn pack(&self, c: Collected, inline: bool) -> Result<Changes> {
        let stats: Vec<FileStat> = c.files.iter().map(FileDiff::stat).collect();
        let body = self.body(c.files, inline).await?;
        Ok(Changes { base: c.base, at: c.at, stats, body, untracked: c.untracked, staged: c.staged })
    }

    pub async fn diff(&self, req: DiffRequest) -> Result<Body> {
        let mut a: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-M", "-U3", &req.from];
        if let Some(to) = &req.to {
            a.push(to);
        }
        a.push("--");
        a.extend(req.paths.iter().map(String::as_str));
        let mut files = parse(self.git.raw(&self.dir, &a).await?).await?;
        finish(&mut files);
        self.body(files, false).await
    }

    /// Inline when small or when no blob store is installed; else the files' JSON as a blob.
    async fn body(&self, files: Vec<FileDiff>, inline: bool) -> Result<Body> {
        let Some(blobs) = self.blobs.clone().filter(|_| !inline) else { return Ok(Body::Inline { files }) };
        let (files, json) = tokio::task::spawn_blocking(move || {
            let json = serde_json::to_vec(&files).unwrap_or_default();
            (files, json)
        })
        .await
        .map_err(|e| GitError::Io(e.to_string()))?;
        if json.len() <= INLINE_MAX {
            return Ok(Body::Inline { files });
        }
        let blob = blobs.put("application/json", json).await.map_err(|e| GitError::Io(e.message))?;
        Ok(Body::Blob { blob })
    }

    /// Each file's stage state (v1 stageState): staged, still to stage (untracked counts), and per
    /// hunk for files staged hunk by hunk. Committed-only files are neither.
    pub async fn stage_state(&self, files: &mut [FileDiff]) -> Result<u32> {
        let unstaged = split_diff(&String::from_utf8_lossy(&self.git.raw(&self.dir, APPLY_DIFF).await.unwrap_or_default()));
        let mut cached: Vec<&str> = APPLY_DIFF.to_vec();
        cached.push("--cached");
        let staged = split_diff(&String::from_utf8_lossy(&self.git.raw(&self.dir, &cached).await.unwrap_or_default()));
        let untracked = paths(&self.git.quiet(&self.dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await);
        let mut n = 0;
        for f in files.iter_mut() {
            let names: Vec<&str> = std::iter::once(f.path.as_str()).chain(f.from.as_deref()).collect();
            let s = names.iter().any(|p| staged.iter().any(|g| g.path == *p));
            let u = names.iter().any(|p| unstaged.iter().any(|g| g.path == *p) || untracked.iter().any(|x| x == p));
            f.staged = Some(s);
            f.unstaged = Some(u);
            if hunkable(f) && (s || u) {
                let un = unstaged.iter().find(|g| g.path == f.path);
                let st = staged.iter().find(|g| g.path == f.path);
                f.hunk_stage = Some(hunk_states(&f.rows, un, st));
            }
            n += u32::from(s);
        }
        Ok(n)
    }
}

/// Reads untracked files side by side; one that went since ls-files, or is a folder (a nested repo), is
/// left out.
async fn read_untracked(dir: &Path, list: Vec<String>) -> Vec<FileDiff> {
    let mut set = JoinSet::new();
    for (i, p) in list.into_iter().enumerate() {
        let file = dir.join(&p);
        set.spawn(async move { tokio::fs::read(&file).await.ok().map(|b| (i, untracked_file(&p, &b))) });
    }
    let mut out: Vec<(usize, FileDiff)> = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(Some(f)) = r {
            out.push(f);
        }
    }
    out.sort_by_key(|(i, _)| *i);
    out.into_iter().map(|(_, f)| f).collect()
}
