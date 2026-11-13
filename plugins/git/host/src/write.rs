//! The writes of a repo handle. Each announces itself to `on_change` subscribers. Worktree adds and
//! removes take turns per repo (edge case Git 3); the user's checkout is only ever fast-forwarded.
//!
//! size-ok: every repo write takes the same per-repo turn and announces itself the same way

use std::path::Path;

use wisp_git_api::{Applied, ApplyRequest, CommitRequest, FetchRequest, PushRequest, StageRequest, Synced, WorktreeAdd, WorktreeEntry};
use wisp_git_core::{SNAPSHOT_ENV, porcelain};

use crate::error::{GitError, Result};
use crate::repo::Inner;
use crate::run::{Opts, args, read_args};

fn snapshot_env(index: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = SNAPSHOT_ENV.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    env.push(("GIT_INDEX_FILE".into(), index.to_string_lossy().into_owned()));
    env
}

impl Inner {
    /// A whole-remote fetch is shared while fresh (`max_age_ms`), and a second caller waits for the one
    /// in flight. Offline is fine: what we have is used. A refspec fetch always runs.
    pub async fn fetch(&self, req: FetchRequest) -> Result<()> {
        let remote = req.remote.unwrap_or_else(|| "origin".into());
        if let Some(spec) = req.refspec {
            let _ = self.git.exec(&self.dir, &args(&["fetch", "--quiet", &remote, &spec]), Opts::timeout(30)).await?;
        } else {
            let mut clock = self.shared.fetching.lock().await;
            let key = format!("{}\0{remote}", self.info.root);
            if !clock.due(&key, (self.now)(), i64::try_from(req.max_age_ms).unwrap_or(i64::MAX)) {
                return Ok(());
            }
            let _ = self.git.exec(&self.root, &args(&["fetch", "--quiet", &remote]), Opts::timeout(20)).await?;
        }
        self.notify("fetched");
        Ok(())
    }

    pub async fn worktree_add(&self, req: WorktreeAdd) -> Result<WorktreeEntry> {
        let _turn = self.shared.worktrees.lock().await;
        if let Some(parent) = Path::new(&req.path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut a = args(&["worktree", "add", "--quiet"]);
        match &req.start {
            Some(start) => a.extend(args(&["--no-track", "-b", &req.branch, &req.path, start])),
            None => a.extend(args(&[&req.path, &req.branch])),
        }
        self.git.run(&self.root, &a, Opts::timeout(120)).await?;
        let head = self.git.quiet(Path::new(&req.path), &["rev-parse", "HEAD"]).await;
        self.notify("worktrees");
        Ok(WorktreeEntry { path: req.path, head, branch: req.branch, ..WorktreeEntry::default() })
    }

    /// Removes the worktree and its folder, then forgets what git calls prunable. A large `node_modules`
    /// takes a while: five minutes.
    pub async fn worktree_remove(&self, path: &str) -> Result<()> {
        let _turn = self.shared.worktrees.lock().await;
        let _ = self.git.exec(&self.root, &args(&["worktree", "remove", "--force", path]), Opts::timeout(300)).await?;
        match tokio::fs::remove_dir_all(path).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let _ = self.git.exec(&self.root, &args(&["worktree", "prune"]), Opts::timeout(60)).await?;
        self.notify("worktrees");
        Ok(())
    }

    pub async fn worktree_prune(&self) -> Result<()> {
        let _turn = self.shared.worktrees.lock().await;
        let _ = self.git.exec(&self.root, &args(&["worktree", "prune"]), Opts::timeout(60)).await?;
        Ok(())
    }

    /// Only the paths git has something for move (v1 stageFile).
    pub async fn stage(&self, req: StageRequest) -> Result<bool> {
        let list: Vec<&str> = req.paths.iter().map(String::as_str).filter(|p| !p.is_empty()).collect();
        let has = if req.unstage {
            porcelain::paths(&self.git.quiet(&self.dir, &["diff", "--cached", "--name-only", "--no-renames", "-z"]).await)
        } else {
            let mut v = porcelain::paths(&self.git.quiet(&self.dir, &["diff", "--name-only", "--no-renames", "-z"]).await);
            v.extend(porcelain::paths(&self.git.quiet(&self.dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await));
            v
        };
        let go: Vec<&str> = list.into_iter().filter(|p| has.iter().any(|h| h == p)).collect();
        if go.is_empty() {
            return Ok(false);
        }
        let mut a = if req.unstage { args(&["restore", "--staged", "--"]) } else { args(&["add", "-A", "--"]) };
        a.extend(go.iter().map(|s| (*s).to_owned()));
        self.git.run(&self.dir, &a, Opts::timeout(60)).await?;
        self.notify("status");
        Ok(true)
    }

    /// `git apply` from stdin: as it is, else (with `three_way`) a three-way merge against the blobs it
    /// came from; conflicts are the files left with markers.
    pub async fn apply(&self, req: ApplyRequest) -> Result<Applied> {
        if req.patch.trim().is_empty() {
            return Ok(Applied::default());
        }
        let run = |three: bool| {
            let mut a = args(&["apply", "--binary", "--whitespace=nowarn"]);
            if req.cached {
                a.push("--cached".into());
            }
            if req.reverse {
                a.push("-R".into());
            }
            if three {
                a.push("--3way".into());
            }
            a.push("-".into());
            let o =
                Opts { input: Some(req.patch.clone().into_bytes()), timeout: Some(std::time::Duration::from_secs(120)), ..Opts::default() };
            async move { self.git.run(&self.dir, &a, o).await }
        };
        let first = run(false).await;
        if first.is_ok() || !req.three_way {
            self.notify("status");
            return Ok(match first {
                Ok(_) => Applied { applied: true, ..Applied::default() },
                Err(e) => Applied { error: Some(e.to_string()), ..Applied::default() },
            });
        }
        let out = match run(true).await {
            Ok(_) => Applied { applied: true, merged: true, ..Applied::default() },
            Err(e) => {
                let conflicts = porcelain::paths(&self.git.quiet(&self.dir, &["diff", "--name-only", "--diff-filter=U"]).await);
                if conflicts.is_empty() {
                    Applied { error: Some(e.to_string()), ..Applied::default() }
                } else {
                    Applied { applied: true, conflicts, ..Applied::default() }
                }
            }
        };
        self.notify("status");
        Ok(out)
    }

    /// The new commit's sha, or None when nothing was staged (a merge's conclusion always commits).
    pub async fn commit(&self, req: CommitRequest) -> Result<Option<String>> {
        if req.all {
            self.git.run(&self.dir, &args(&["add", "-A"]), Opts::timeout(120)).await?;
        }
        if !req.no_edit {
            let r = self.git.exec(&self.dir, &args(&["diff", "--cached", "--quiet"]), Opts::default()).await?;
            match r.exit.code {
                Some(0) => return Ok(None),
                Some(1) => {}
                _ => crate::run::check(&r)?,
            }
        }
        let mut a = args(&["commit", "--quiet"]);
        if req.no_verify {
            a.push("--no-verify".into());
        }
        if req.no_edit {
            a.push("--no-edit".into());
        } else {
            let message = req.message.trim();
            if message.is_empty() {
                return Err(GitError::Refused("A commit message is required.".into()));
            }
            a.extend(args(&["-m", message]));
            if !req.body.trim().is_empty() {
                a.extend(args(&["-m", req.body.trim()]));
            }
        }
        self.git.run(&self.dir, &a, Opts::timeout(120)).await?;
        let sha = self.git.read(&self.dir, &["rev-parse", "HEAD"]).await?;
        self.notify("head");
        Ok(Some(sha))
    }

    pub async fn push(&self, req: PushRequest) -> Result<()> {
        let mut a = args(&["push", "--quiet"]);
        if req.set_upstream {
            a.push("-u".into());
        }
        a.push(req.remote.clone());
        if req.delete {
            a.push("--delete".into());
        }
        a.push(req.refspec.clone());
        self.git.run(&self.dir, &a, Opts::timeout(120)).await?;
        self.notify("branches");
        Ok(())
    }

    pub async fn branch_delete(&self, name: &str) -> Result<bool> {
        let r = self.git.exec(&self.root, &args(&["branch", "-D", name]), Opts::default()).await?;
        if r.exit.success() {
            self.notify("branches");
        }
        Ok(r.exit.success())
    }

    /// Fast-forwards the user's `base` to origin's (edge case Git 8): `merge --ff-only` when it is
    /// checked out, else the ref is moved with a fast-forward-only fetch. Never anything more.
    pub async fn sync_base(&self, base: &str) -> Result<Synced> {
        let go = async {
            self.git.run(&self.root, &args(&["fetch", "--quiet", "origin"]), Opts::timeout(60)).await?;
            let current = self.git.quiet(&self.root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
            if current == base {
                self.git.run(&self.root, &args(&["merge", "--ff-only", "--quiet", &format!("origin/{base}")]), Opts::default()).await?;
            } else {
                self.git.run(&self.root, &args(&["fetch", "--quiet", "origin", &format!("{base}:{base}")]), Opts::timeout(60)).await?;
            }
            Ok::<(), GitError>(())
        };
        let out = match go.await {
            Ok(()) => Synced { ok: true, text: format!("Local {base} is up to date with origin/{base}.") },
            Err(e) => Synced { ok: false, text: format!("Local {base} was not updated: {e}") },
        };
        self.notify("branches");
        Ok(out)
    }

    /// The folder as it is (untracked included, ignored not) as a commit on top of HEAD that no branch
    /// points at, through a temporary index: the user's index and folder are only read. None when it
    /// is HEAD's tree, or outside a repo with commits.
    pub async fn snapshot(&self) -> Result<Option<String>> {
        let Some(head) = self.rev_parse("HEAD").await? else {
            return Ok(None);
        };
        let Some(tree) = self.work_tree().await? else {
            return Ok(None);
        };
        if self.git.quiet(&self.dir, &["rev-parse", "HEAD^{tree}"]).await == tree {
            return Ok(None);
        }
        let index = temp_index();
        let o = Opts { env: snapshot_env(&index), ..Opts::default() };
        let sha = self.git.run(&self.dir, &args(&["commit-tree", &tree, "-p", &head, "-m", "wisp: work in progress"]), o).await;
        let _ = tokio::fs::remove_file(&index).await;
        sha.map(Some)
    }

    /// The folder back as `to` has it, the branch back at `head` (see `Repo::restore`). Untracked files `to`
    /// doesn't hold are removed first (`read-tree -u` leaves untracked files alone); then the tree is read
    /// into the index and the folder, and a mixed reset puts the index and the branch at `head`, so what
    /// was untracked then is untracked again.
    pub async fn restore(&self, to: &str, head: &str) -> Result<()> {
        let Some(to) = self.rev_parse(to).await? else {
            return Err(GitError::Refused(format!("no checkpoint {to} in this repo")));
        };
        let Some(head) = self.rev_parse(head).await? else {
            return Err(GitError::Refused(format!("no commit {head} in this repo")));
        };
        let root = std::path::Path::new(&self.info.root).to_path_buf();
        let held = self.git.raw(&root, &["ls-tree", "-r", "-z", "--name-only", &to]).await?;
        let held: std::collections::HashSet<&[u8]> = held.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
        let loose = self.git.raw(&root, &["ls-files", "-z", "--others", "--exclude-standard"]).await?;
        for p in loose.split(|b| *b == 0).filter(|p| !p.is_empty() && !held.contains(p)) {
            let rel = String::from_utf8_lossy(p).into_owned();
            if rel.split('/').any(|c| c == "..") {
                continue;
            }
            let _ = tokio::fs::remove_file(root.join(&rel)).await;
        }
        self.git.run(&root, &args(&["read-tree", "--reset", "-u", &to]), Opts::default()).await?;
        self.git.run(&root, &args(&["reset", "--quiet", "--mixed", &head]), Opts::default()).await?;
        Ok(())
    }

    /// A binary patch of the folder against `base`, untracked included; "" when nothing changed.
    pub async fn patch(&self, base: &str) -> Result<String> {
        let Some(tree) = self.work_tree().await? else {
            return Ok(String::new());
        };
        let out = self.git.raw(&self.dir, &["diff", "--binary", "--no-color", "--no-ext-diff", "--full-index", base, &tree]).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// The tree of the folder as it is, written through a temporary index seeded from the user's (a plain
    /// read, no lock): its stat cache spares `add` re-hashing every tracked file. A copy git can't read
    /// (no index yet, a failed copy) falls back to HEAD's tree, re-hashed whole.
    async fn work_tree(&self) -> Result<Option<String>> {
        if self.rev_parse("HEAD").await?.is_none() {
            return Ok(None);
        }
        let index = temp_index();
        let o = || Opts { env: snapshot_env(&index), timeout: Some(std::time::Duration::from_secs(120)), ..Opts::default() };
        let git_dir = self.git.quiet(&self.dir, &["rev-parse", "--absolute-git-dir"]).await;
        let go = async {
            let seeded = !git_dir.is_empty()
                && copy_keeping_mtime(Path::new(&git_dir).join("index"), index.clone()).await
                && self.git.run(&self.dir, &args(&["add", "-A"]), o()).await.is_ok();
            if !seeded {
                let _ = tokio::fs::remove_file(&index).await;
                self.git.run(&self.dir, &args(&["read-tree", "HEAD"]), o()).await?;
                self.git.run(&self.dir, &args(&["add", "-A"]), o()).await?;
            }
            self.git.run(&self.dir, &read_args(&["write-tree"]), o()).await
        };
        let tree = go.await;
        let _ = tokio::fs::remove_file(&index).await;
        tree.map(Some)
    }
}

/// `from` into `to` through one open handle (git swaps its index by rename, so this reads one whole
/// file), with `from`'s mtime set on `to`: git's racy-clean check compares the index's mtime with its
/// entries', and a fresh mtime would hide a same-size edit made in the instant the index was written.
/// As wisp.runtime's `copy_file` (plugins/runtime/host/src/sys.rs), which harness runs pin through.
async fn copy_keeping_mtime(from: std::path::PathBuf, to: std::path::PathBuf) -> bool {
    let copy = move || -> std::io::Result<()> {
        let mut src = std::fs::File::open(&from)?;
        let mtime = src.metadata()?.modified()?;
        let mut dst = std::fs::File::create(&to)?;
        std::io::copy(&mut src, &mut dst)?;
        dst.set_modified(mtime)
    };
    tokio::task::spawn_blocking(copy).await.is_ok_and(|r| r.is_ok())
}

fn temp_index() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("wisp-index-{}-{}", std::process::id(), wisp_kernel::ids::uuid7()))
}
