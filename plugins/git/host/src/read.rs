//! The reads of a repo handle. Read-only and without refreshing the index (`--no-optional-locks`,
//! edge case Git 1), so an agent's own git in the same worktree never finds index.lock taken.

use wisp_git_api::{BaseMerged, BaseRef, Branch, MergeTree, Status, Touched, WorktreeEntry};
use wisp_git_core::{base, porcelain};

use crate::error::Result;
use crate::repo::Inner;
use crate::run::{Opts, read_args};

impl Inner {
    pub async fn status(&self) -> Result<Status> {
        let out = self.git.raw(&self.dir, &["status", "--porcelain=v2", "-z", "--branch"]).await?;
        Ok(porcelain::parse_status(&out))
    }

    pub async fn branches(&self) -> Result<Vec<Branch>> {
        let out = self.git.read(&self.dir, &["for-each-ref", porcelain::BRANCH_FORMAT, "refs/heads", "refs/remotes"]).await?;
        Ok(porcelain::parse_branches(&out))
    }

    pub async fn worktrees(&self) -> Result<Vec<WorktreeEntry>> {
        let out = self.git.read(&self.root, &["worktree", "list", "--porcelain"]).await?;
        Ok(porcelain::parse_worktrees(&out))
    }

    /// `rev-parse --verify --quiet <rev>^{commit}`.
    pub async fn rev_parse(&self, rev: &str) -> Result<Option<String>> {
        let at = format!("{rev}^{{commit}}");
        let out = self.git.quiet(&self.dir, &["rev-parse", "--verify", "--quiet", &at]).await;
        Ok(Some(out).filter(|s| !s.is_empty()))
    }

    pub async fn count(&self, range: &str) -> Result<Option<u32>> {
        let r = self.git.exec(&self.dir, &read_args(&["rev-list", "--count", range]), Opts::default()).await?;
        Ok(if r.exit.success() { porcelain::parse_count(&r.stdout_text()) } else { None })
    }

    pub async fn is_ancestor(&self, a: &str, b: &str) -> Result<bool> {
        let r = self.git.exec(&self.dir, &read_args(&["merge-base", "--is-ancestor", a, b]), Opts::default()).await?;
        Ok(r.exit.success())
    }

    pub async fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
        let out = self.git.quiet(&self.dir, &["merge-base", a, b]).await;
        Ok(Some(out).filter(|s| !s.is_empty()))
    }

    /// Would `a` and `b` merge? Runs in any worktree of the repo without touching it (edge case Git 9).
    pub async fn merge_tree(&self, a: &str, b: &str) -> Result<MergeTree> {
        let args = read_args(&["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b]);
        let r = self.git.exec(&self.dir, &args, Opts::timeout(30)).await?;
        Ok(porcelain::read_merge_tree(r.exit.code.filter(|_| !r.timed_out), &r.stdout_text()))
    }

    pub async fn show(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let spec = format!("{rev}:{path}");
        let r = self.git.exec(&self.dir, &read_args(&["show", &spec]), Opts::default()).await?;
        Ok(r.exit.success().then_some(r.stdout))
    }

    /// Tracked files plus new ones (not ignored), capped: Open file… in a monorepo waits for search past it.
    pub async fn files(&self, max: usize) -> Result<Vec<String>> {
        let out = self.git.raw(&self.dir, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).await?;
        let mut list = porcelain::paths(&String::from_utf8_lossy(&out));
        list.dedup();
        list.truncate(max);
        Ok(list)
    }

    pub async fn remote_url(&self, remote: &str) -> Result<Option<String>> {
        let out = self.git.quiet(&self.dir, &["remote", "get-url", remote]).await;
        Ok(Some(out).filter(|s| !s.is_empty()))
    }

    /// What new work branches from (edge case Git 4): origin/HEAD, origin/main, origin/master, else
    /// HEAD with no remote, else None. With `fetch`, origin is fetched first (good for 60 s).
    pub async fn base(&self, fetch: bool) -> Result<Option<BaseRef>> {
        let remotes = self.git.quiet(&self.root, &["remote"]).await;
        let mut resolved = Vec::new();
        if remotes.lines().any(|r| r == "origin") {
            if fetch {
                self.fetch(wisp_git_api::FetchRequest { remote: None, refspec: None, max_age_ms: 60_000 }).await?;
            }
            let head = self.git.quiet(&self.root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).await;
            for r in base::base_candidates(Some(&head)) {
                let sha = self.rev_parse_at_root(&r).await;
                let found = sha.is_some();
                resolved.push((r, sha));
                if found {
                    break;
                }
            }
        }
        let head = self.git.quiet(&self.root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await;
        let branch = self.git.quiet(&self.root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
        Ok(base::choose_base(&resolved, Some(&head), &branch))
    }

    async fn rev_parse_at_root(&self, rev: &str) -> Option<String> {
        let at = format!("{rev}^{{commit}}");
        Some(self.git.quiet(&self.root, &["rev-parse", "--verify", "--quiet", &at]).await).filter(|s| !s.is_empty())
    }

    /// Files changed since the merge-base with `base`, uncommitted edits and new files; `head` is a
    /// commit of the work as it stands (a snapshot through a temporary index when there are edits). One read after another.
    pub async fn touched(&self, base_ref: &str) -> Result<Option<Touched>> {
        let Some(at) = self.merge_base("HEAD", base_ref).await? else {
            return Ok(None);
        };
        let committed = self.git.quiet(&self.dir, &["diff", "--name-only", &at, "HEAD"]).await;
        let edited = self.git.quiet(&self.dir, &["diff", "--name-only", "HEAD"]).await;
        let added = self.git.quiet(&self.dir, &["ls-files", "--others", "--exclude-standard"]).await;
        let mut files: Vec<String> =
            committed.lines().chain(edited.lines()).chain(added.lines()).filter(|l| !l.is_empty()).map(str::to_owned).collect();
        files.sort();
        files.dedup();
        // the work as it stands through a temporary index: `stash create` rewrote the user's index under
        // `index.lock`, failing a `git commit` they ran at that moment
        let head = match self.snapshot().await.ok().flatten() {
            Some(sha) => sha,
            None => self.git.quiet(&self.dir, &["rev-parse", "HEAD"]).await,
        };
        Ok(Some(Touched { files, head, base: at }))
    }

    /// After an agent merged the base in: nothing still conflicted, a resolved-but-uncommitted merge
    /// committed, the base an ancestor, and no conflict markers staged as if resolved (edge case Git 9).
    pub async fn base_merged(&self, base_ref: &str) -> Result<BaseMerged> {
        let no = |why: String| Ok(BaseMerged { ok: false, why: Some(why) });
        let unmerged = self.git.quiet(&self.dir, &["diff", "--name-only", "--diff-filter=U"]).await;
        if !unmerged.is_empty() {
            return no(format!("Still conflicted: {}", unmerged.lines().collect::<Vec<_>>().join(", ")));
        }
        if !self.git.quiet(&self.dir, &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]).await.is_empty() {
            self.commit(wisp_git_api::CommitRequest { all: true, no_edit: true, no_verify: true, ..Default::default() }).await?;
        }
        if !self.is_ancestor(base_ref, "HEAD").await? {
            return no(format!("{} is not merged into the branch.", base_ref.strip_prefix("refs/remotes/").unwrap_or(base_ref)));
        }
        let range = format!("{base_ref}...HEAD");
        let marked = self.git.quiet(&self.dir, &["diff", "--name-only", "-G^<<<<<<< ", &range]).await;
        if !marked.is_empty() {
            return no(format!("Conflict markers left in {}", marked.lines().collect::<Vec<_>>().join(", ")));
        }
        Ok(BaseMerged { ok: true, why: None })
    }
}
