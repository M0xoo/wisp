//! The git.* commands: Changes, Revert, Stage, Commit, Tools, Clone (v1 routes/workspace.js and
//! git.js), over the same repo handles the service gives out. The deciders are in wisp-git-core
//! (`ops`); here they meet the folder. File writes stay inside the folder (no link out, not .git).

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use wisp_git_api::commands::{ChangesArgs, CommitArgs, Committed, Done, RevertArgs, Reverted, StageArgs};
use wisp_git_api::{ApplyRequest, Changes, CommitRequest, StageRequest};
use wisp_git_core::mask::mask_file;
use wisp_git_core::ops::{
    NOT_HERE, NOT_STAGED, NOTHING_TO_STAGE, Refusal, RevertPlan, STALE, StagePlan, lexical_path, plan_revert, plan_stage,
};
use wisp_git_core::stage::{APPLY_DIFF, hunk_patch, split_diff};
use wisp_kernel::CancellationToken;

use crate::error::{GitError, Result};
use crate::repo::{Inner, RepoImpl};
use crate::run::{Opts, args};
use crate::service::GitServiceImpl;

/// A handle for one command: released when the command is done (the cache keeps it if others hold it).
pub(crate) async fn handle(svc: &Arc<GitServiceImpl>, dir: &str) -> Result<(RepoImpl, lease::Lease)> {
    let token = CancellationToken::new();
    let r = svc.clone().open(token.clone(), dir.to_owned()).await?;
    Ok((r, lease::Lease(token)))
}

/// Cancels its token when dropped.
pub(crate) mod lease {
    #[derive(Debug)]
    pub struct Lease(pub wisp_kernel::CancellationToken);
    impl Drop for Lease {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }
}

#[allow(clippy::needless_pass_by_value)] // used as map_err(refusal)
fn refusal(r: Refusal) -> GitError {
    match r {
        Refusal::Stale(m) => GitError::Stale(m.into()),
        Refusal::Bad(m) => GitError::Refused(m.into()),
    }
}

pub fn hash(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

async fn hash_at(file: &Path) -> Option<String> {
    tokio::fs::read(file).await.ok().map(|b| hash(&b))
}

/// A path a revert may write or remove (v1 targetFile): lexically inside, and its nearest folder that
/// exists is really inside `root` (no link out of it).
async fn target(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = lexical_path(rel).ok_or_else(|| GitError::NoFolder(NOT_HERE.into()))?;
    let file = root.join(&rel);
    let real_root = tokio::fs::canonicalize(root).await?;
    let mut probe = file.clone();
    while tokio::fs::symlink_metadata(&probe).await.is_err() {
        if !probe.pop() {
            break;
        }
    }
    let at = tokio::fs::canonicalize(&probe).await.unwrap_or_default();
    if at != real_root && !at.starts_with(&real_root) {
        return Err(GitError::NoFolder(NOT_HERE.into()));
    }
    Ok(file)
}

pub async fn changes(svc: &Arc<GitServiceImpl>, a: ChangesArgs) -> Result<Option<Changes>> {
    let (repo, _g) = handle(svc, &a.path).await?;
    let me = &repo.inner;
    // the stage reads run beside the Changes diff: each is ~one full diff on a big change
    let (collected, reads) = tokio::join!(me.collect(&a.base), async { if a.stage_state { Some(me.stage_reads().await) } else { None } });
    let Some(mut c) = collected? else {
        return Ok(None);
    };
    // per-file work over a big change runs on the blocking pool, never a runtime worker
    let (mask, reveal) = (a.mask, a.reveal);
    let c = tokio::task::spawn_blocking(move || {
        if let Some(reads) = reads {
            c.staged = Some(crate::changes::apply_stage_state(&mut c.files, &reads));
        }
        if mask {
            for f in &mut c.files {
                let shown = reveal.contains(&f.path);
                mask_file(f, shown);
            }
        }
        c
    })
    .await
    .map_err(|e| GitError::Io(e.to_string()))?;
    Ok(Some(me.pack(c, a.inline).await?))
}

async fn file_of(me: &Inner, base: &str, path: &str) -> Result<(String, Option<wisp_git_api::FileDiff>)> {
    let c = me.collect(base).await?.ok_or_else(|| GitError::Stale(STALE.into()))?;
    let f = c.files.into_iter().find(|f| f.path == path);
    Ok((c.at, f))
}

pub async fn revert(svc: &Arc<GitServiceImpl>, a: RevertArgs) -> Result<Reverted> {
    if a.path.is_empty() {
        return Err(GitError::Refused("path is required".into()));
    }
    let (repo, _g) = handle(svc, &a.dir).await?;
    let me = &repo.inner;
    if let Some(restore) = a.restore {
        let file = target(&me.dir, &a.path).await?;
        if a.hash.is_some() && hash_at(&file).await != a.hash {
            return Err(GitError::Stale("The file changed since it was reverted: Undo would lose that.".into()));
        }
        match restore {
            None => {
                let _ = tokio::fs::remove_file(&file).await;
            }
            Some(text) => {
                if let Some(p) = file.parent() {
                    tokio::fs::create_dir_all(p).await?;
                }
                tokio::fs::write(&file, text).await?;
            }
        }
        me.notify("status");
        return Ok(Reverted { ok: true, hash: hash_at(&file).await });
    }
    let (at, f) = file_of(me, &a.base, &a.path).await?;
    let plan = plan_revert(f.as_ref(), a.hunk, a.key.as_deref()).map_err(refusal)?;
    let file = target(&me.dir, &a.path).await?;
    match plan {
        RevertPlan::Hunk { index } => {
            let rows = f.map(|f| f.rows).unwrap_or_default();
            let text = tokio::fs::read_to_string(&file).await.map_err(|_| GitError::Stale(STALE.into()))?;
            let out = wisp_git_core::hunks::revert_hunk(&text, &rows, index).ok_or_else(|| GitError::Stale(STALE.into()))?;
            tokio::fs::write(&file, out).await?;
        }
        RevertPlan::File { remove, restore } => {
            if let Some(r) = remove {
                let _ = tokio::fs::remove_file(target(&me.dir, &r).await?).await;
            }
            if let Some(r) = restore {
                target(&me.dir, &r).await?;
                me.git.run(&me.dir, &args(&["restore", &format!("--source={at}"), "--worktree", "--", &r]), Opts::default()).await?;
            }
        }
    }
    me.notify("status");
    Ok(Reverted { ok: true, hash: hash_at(&file).await })
}

pub async fn stage(svc: &Arc<GitServiceImpl>, a: StageArgs) -> Result<Done> {
    if a.path.is_empty() {
        return Err(GitError::Refused("path is required".into()));
    }
    let (repo, _g) = handle(svc, &a.dir).await?;
    let me = &repo.inner;
    let (_, f) = file_of(me, &a.base, &a.path).await?;
    let plan = plan_stage(f.as_ref(), a.hunk, a.key.as_deref()).map_err(refusal)?;
    let gone = if a.unstage { NOT_STAGED } else { NOTHING_TO_STAGE };
    let moved = match plan {
        StagePlan::Files(paths) => {
            for p in &paths {
                target(&me.dir, p).await?;
            }
            me.stage(StageRequest { paths, unstage: a.unstage }).await?
        }
        StagePlan::Hunk { index } => {
            let rows = f.map(|f| f.rows).unwrap_or_default();
            let mut un: Vec<&str> = APPLY_DIFF.to_vec();
            un.extend(["--", &a.path]);
            let unstaged = split_diff(&String::from_utf8_lossy(&me.git.raw(&me.dir, &un).await.unwrap_or_default())).into_iter().next();
            let mut st: Vec<&str> = APPLY_DIFF.to_vec();
            st.extend(["--cached", "--", &a.path]);
            let staged = split_diff(&String::from_utf8_lossy(&me.git.raw(&me.dir, &st).await.unwrap_or_default())).into_iter().next();
            match hunk_patch(&rows, index, unstaged.as_ref(), staged.as_ref(), a.unstage) {
                None => false,
                Some(patch) => {
                    let r = me.apply(ApplyRequest { patch, cached: true, reverse: a.unstage, three_way: false }).await?;
                    if let Some(e) = r.error {
                        return Err(GitError::Stale(format!("git refused: {e}")));
                    }
                    r.applied
                }
            }
        }
    };
    if !moved {
        return Err(GitError::Stale(gone.into()));
    }
    Ok(Done { ok: true })
}

pub async fn commit(svc: &Arc<GitServiceImpl>, a: CommitArgs) -> Result<Committed> {
    let message = a.message.trim().to_owned();
    if message.is_empty() {
        return Err(GitError::Refused("Write a commit message first.".into()));
    }
    let (repo, _g) = handle(svc, &a.dir).await?;
    let me = &repo.inner;
    let sha = me.commit(CommitRequest { message, all: a.all, ..CommitRequest::default() }).await.map_err(|e| match e {
        GitError::Failed { why, .. } => GitError::Stale(format!("git couldn’t commit: {why}")),
        other => other,
    })?;
    if sha.is_none() {
        let why =
            if a.all { "Nothing to commit: the folder is as its last commit." } else { "Nothing is staged: stage a file or a hunk first." };
        return Err(GitError::Refused(why.into()));
    }
    let short = me.git.read(&me.dir, &["rev-parse", "--short", "HEAD"]).await?;
    Ok(Committed { ok: true, sha: short })
}
