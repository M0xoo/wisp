//! The work in progress in a checkout as a commit, written through a temporary index so the user's
//! `.git/index` is never locked or written. `git stash create` (v1's pin) refreshes and rewrites the
//! user's index under `index.lock` whatever `GIT_OPTIONAL_LOCKS` says, so a `git commit` the user ran
//! at that moment failed with "index.lock: File exists".

use std::sync::atomic::{AtomicU64, Ordering};

use crate::drive::Disk;

/// Who the snapshot commit is by: a checkout without `user.name` must still get one.
const WHO: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "wisp"),
    ("GIT_AUTHOR_EMAIL", "wisp@localhost"),
    ("GIT_COMMITTER_NAME", "wisp"),
    ("GIT_COMMITTER_EMAIL", "wisp@localhost"),
];

static NEXT: AtomicU64 = AtomicU64::new(0);

/// What `git stash create` captured (HEAD plus the index and the tracked files' edits, untracked files
/// left out) as a commit on HEAD; None when nothing differs from HEAD or `cwd` has no commit.
pub async fn work_in_progress(disk: &dyn Disk, cwd: &str) -> Option<String> {
    let head = trimmed(disk.git(cwd, &["rev-parse", "--verify", "HEAD"]).await)?;
    let git_dir = trimmed(disk.git(cwd, &["rev-parse", "--absolute-git-dir"]).await)?;
    // in the checkout's own git dir (as git's stash puts `index.stash.<pid>`): same disk, always writable
    let index = format!(
        "{git_dir}/wisp-wip-{}-{}.index",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let out = through(disk, cwd, &head, &git_dir, &index).await;
    disk.remove(&index).await;
    disk.remove(&format!("{index}.lock")).await;
    out
}

async fn through(disk: &dyn Disk, cwd: &str, head: &str, git_dir: &str, index: &str) -> Option<String> {
    let mut env: Vec<(&str, &str)> = WHO.to_vec();
    env.push(("GIT_INDEX_FILE", index));
    let tmp = |args: &'static [&'static str]| disk.git_env(cwd, args, &env);
    // seeded from the user's index (a plain read, no lock): its stat cache spares `add` re-hashing
    // every tracked file, and its staged adds and removals come along. A copy git can't read (a
    // missing index, a disk that can't copy) falls back to HEAD's tree, re-hashed whole.
    let seeded = disk.copy(&format!("{git_dir}/index"), index).await
        && tmp(&["add", "--update"]).await.is_some();
    if !seeded {
        disk.remove(index).await;
        tmp(&["read-tree", "HEAD"]).await?;
        tmp(&["add", "--update"]).await?;
    }
    let tree = trimmed(tmp(&["write-tree"]).await)?;
    if trimmed(disk.git(cwd, &["rev-parse", "HEAD^{tree}"]).await).as_deref() == Some(tree.as_str())
    {
        return None;
    }
    let commit = [
        "commit-tree",
        tree.as_str(),
        "-p",
        head,
        "-m",
        "wisp: work in progress",
    ];
    trimmed(disk.git_env(cwd, &commit, &env).await)
}

fn trimmed(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}
