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
    let out = through(disk, cwd, &head, &index).await;
    disk.remove(&index).await;
    disk.remove(&format!("{index}.lock")).await;
    out
}

async fn through(disk: &dyn Disk, cwd: &str, head: &str, index: &str) -> Option<String> {
    let mut env: Vec<(&str, &str)> = WHO.to_vec();
    env.push(("GIT_INDEX_FILE", index));
    let tmp = |args: &'static [&'static str]| disk.git_env(cwd, args, &env);
    tmp(&["read-tree", "HEAD"]).await?;
    tmp(&["add", "--update"]).await?;
    // what the user's index holds that HEAD doesn't (a staged new file) or dropped (a staged removal):
    // read from their index without a lock (GIT_OPTIONAL_LOCKS=0 from the proc service)
    let staged = |filter: &'static str| async move {
        let out = disk
            .git(
                cwd,
                &[
                    "diff",
                    "--cached",
                    "--name-only",
                    "--no-renames",
                    filter,
                    "-z",
                ],
            )
            .await
            .unwrap_or_default();
        // root-relative names, whatever folder `cwd` is in the checkout
        out.split('\0')
            .filter(|s| !s.is_empty())
            .map(|s| format!(":(top,literal){s}"))
            .collect::<Vec<_>>()
    };
    let steps: [(&str, &[&str]); 2] = [
        ("--diff-filter=A", &["add", "--force", "--"]),
        (
            "--diff-filter=D",
            &["rm", "--cached", "--quiet", "--ignore-unmatch", "--"],
        ),
    ];
    for (filter, verb) in steps {
        let files = staged(filter).await;
        if files.is_empty() {
            continue;
        }
        let args: Vec<&str> = verb
            .iter()
            .copied()
            .chain(files.iter().map(String::as_str))
            .collect();
        disk.git_env(cwd, &args, &env).await?;
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
