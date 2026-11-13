//! One repo's Ship it, through git.service and gh: its status, commit → push → PR, the squash merge,
//! and whether it really conflicts with its base.

use std::sync::Arc;

use wisp_git_api::{CommitRequest, FetchRequest, MergeTree, PushRequest, Repo, WorktreeAdd};
use wisp_kernel::{Call, CancellationToken, Clock};
use wisp_ship_api::{PrSummary, RepoStatus, Synced, Worktree};
use wisp_ship_core::Refusal;
use wisp_ship_core::decide::{
    cleans_up, commit_message, created_url, merge_plan, merged_head, pr_create_args, push_refspec, push_target, repo_status, reuse_pr,
    unpushed_from,
};

use crate::error::Result;
use crate::gh::Gh;

/// What Ship it runs on. Cheap to clone.
#[derive(Clone)]
pub struct Shipper {
    pub git: Arc<dyn wisp_git_api::GitService>,
    pub gh: Gh,
    /// the plugin's scope: repo handles are released with it
    pub owner: CancellationToken,
    pub clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for Shipper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shipper").field("gh", &self.gh).finish_non_exhaustive()
    }
}

/// The stage a ship is at: commit, push, pr.
pub type OnStep<'a> = &'a (dyn Fn(&str) + Send + Sync);

pub async fn exists(path: &str) -> bool {
    !path.is_empty() && tokio::fs::try_exists(path).await.unwrap_or(false)
}

impl Shipper {
    pub fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    pub async fn repo(&self, call: &Call, path: &str) -> Result<Arc<dyn Repo>> {
        Ok(self.git.repo(call, &self.owner, path).await?)
    }

    /// Where to run gh and git for a worktree: its folder, else (gone after a merge) the main checkout.
    pub async fn dir_of(wt: &Worktree) -> String {
        if exists(&wt.path).await { wt.path.clone() } else { wt.root.clone() }
    }

    /// v1 worktreeStatus: dirty paths, commits past the base, commits not on the PR. After its PR
    /// merged, only commits since the merged head count (edge case Git 6).
    pub async fn status(&self, call: &Call, wt: &Worktree, pr: Option<&PrSummary>) -> Result<RepoStatus> {
        if !exists(&wt.path).await {
            return Ok(RepoStatus::default());
        }
        let repo = self.repo(call, &wt.path).await?;
        let (st, ahead) = tokio::join!(repo.status(call), repo.count(call, &format!("{}..HEAD", wt.base_ref)));
        let dirty = st.map_or(0, |s| u32::try_from(s.dirty()).unwrap_or(u32::MAX));
        let mut counts = Vec::new();
        for r in unpushed_from(wt, merged_head(pr)) {
            let n = repo.count(call, &format!("{r}..HEAD")).await.ok().flatten();
            counts.push(n);
            if n.is_some() {
                break;
            }
        }
        Ok(repo_status(true, dirty, ahead.ok().flatten(), &counts))
    }

    /// Archiving removed a clean worktree: bring it back from its branch before shipping.
    pub async fn ensure(&self, call: &Call, wt: &Worktree) -> Result<()> {
        if exists(&wt.path).await {
            return Ok(());
        }
        if wt.foreign {
            // no prune, and no add: that would make a new folder at its path
            return Err(Refusal::Conflict(format!("This worktree's folder is gone: {}", wt.path)).into());
        }
        let root = self.repo(call, &wt.root).await?;
        root.worktree_prune(call).await.ok();
        root.worktree_add(call, WorktreeAdd { path: wt.path.clone(), branch: wt.branch.clone(), start: None }).await?;
        Ok(())
    }

    /// Commit whatever the task left, push its branch and open (or update) its PR.
    pub async fn ship(&self, call: &Call, wt: &Worktree, req: &ShipReq<'_>, on_step: OnStep<'_>) -> Result<PrSummary> {
        self.ensure(call, wt).await?;
        let repo = self.repo(call, &wt.path).await?;
        if repo.status(call).await.map_or(0, |s| s.dirty()) > 0 {
            let (message, body) = commit_message(req.title, req.body)?;
            let body = wisp_ship_core::decide::with_task(&body, req.task);
            on_step("commit");
            repo.commit(call, CommitRequest { message, body, all: true, no_edit: false, no_verify: true }).await?;
        }
        let ahead = repo.count(call, &format!("{}..HEAD", wt.base_ref)).await?.unwrap_or(0);
        let remote = push_target(ahead, wt)?;
        on_step("push");
        repo.push(call, PushRequest { remote, refspec: push_refspec(wt), set_upstream: true, delete: false }).await?;
        on_step("pr");
        let now = self.now();
        if let Some(n) = reuse_pr(req.pr) {
            return self.gh.pr_view(&wt.path, &n.to_string(), now).await;
        }
        let title = req.title.trim();
        let out = self.gh.run(&wt.path, &pr_create_args(wt, title, req.body, req.draft), None).await?;
        self.gh.pr_view(&wt.path, &created_url(&out), now).await
    }

    /// Squash-merge the exact head that was reviewed (a draft readied first), fast-forward the user's
    /// base, then tidy wisp's own worktree and branch (edge cases Git 7, 8).
    pub async fn merge(&self, call: &Call, wt: &Worktree, number: u64) -> Result<(PrSummary, Synced)> {
        let dir = Self::dir_of(wt).await;
        let n = number.to_string();
        let pr = self.gh.pr_view(&dir, &n, self.now()).await?;
        let plan = merge_plan(&pr, &n)?;
        if let Some(ready) = plan.ready {
            self.gh.run(&dir, &ready, None).await?;
        }
        self.gh.run(&dir, &plan.merge, None).await?;
        let pr = self.gh.pr_view(&dir, &n, self.now()).await?;
        let root = self.repo(call, &wt.root).await?;
        let sync = root.sync_base(call, &wt.base).await.map_or_else(
            |e| Synced { ok: false, text: format!("Local {} was not updated: {}", wt.base, e.message) },
            |s| Synced { ok: s.ok, text: s.text },
        );
        if cleans_up(wt) {
            self.tidy(call, &root, wt).await;
        }
        Ok((pr, sync))
    }

    /// The merged task's worktree and branch go, here and on the remote. Best effort: the merge landed.
    async fn tidy(&self, call: &Call, root: &Arc<dyn Repo>, wt: &Worktree) {
        if exists(&wt.path).await
            && let Err(e) = root.worktree_remove(call, &wt.path).await
        {
            tracing::warn!(path = %wt.path, "ship: worktree remove after merge: {}", e.message);
        }
        root.branch_delete(call, &wt.branch).await.ok();
        let remote = wt.remote.clone().unwrap_or_else(|| "origin".into());
        root.push(call, PushRequest { remote, refspec: wt.branch.clone(), set_upstream: false, delete: true }).await.ok();
    }

    /// Squash-merge a PR attached by URL: no worktree of wisp's to sync or tidy.
    pub async fn merge_url(&self, dir: &str, url: &str) -> Result<PrSummary> {
        let pr = self.gh.pr_view(dir, url, self.now()).await?;
        let plan = merge_plan(&pr, url)?;
        if let Some(ready) = plan.ready {
            self.gh.run(dir, &ready, None).await?;
        }
        self.gh.run(dir, &plan.merge, None).await?;
        self.gh.pr_view(dir, url, self.now()).await
    }

    /// Does the branch really conflict with its freshly fetched base? Asked before spending an agent run
    /// on GitHub's word, which can lag a push. None when git can't tell (< 2.38, edge case Git 9).
    pub async fn conflicts_with_base(&self, call: &Call, wt: &Worktree) -> Result<Option<bool>> {
        let Some(remote) = wt.remote.clone().filter(|r| !r.is_empty()) else {
            return Ok(None);
        };
        if !exists(&wt.path).await {
            return Ok(None);
        }
        let repo = self.repo(call, &wt.path).await?;
        repo.fetch(call, FetchRequest { remote: Some(remote.clone()), refspec: Some(wt.base.clone()), max_age_ms: 0 }).await.ok();
        Ok(match repo.merge_tree(call, &format!("refs/remotes/{remote}/{}", wt.base), "HEAD").await? {
            MergeTree::Clean => Some(false),
            MergeTree::Conflict { .. } => Some(true),
            MergeTree::Unknown => None,
        })
    }

    /// After the fix-up turn: the base is merged in with nothing half done (git.service `base_merged`).
    pub async fn base_merged(&self, call: &Call, wt: &Worktree) -> Result<std::result::Result<(), String>> {
        let repo = self.repo(call, &wt.path).await?;
        let base = format!("refs/remotes/{}/{}", wt.remote.as_deref().unwrap_or("origin"), wt.base);
        let m = repo.base_merged(call, &base).await?;
        Ok(if m.ok { Ok(()) } else { Err(m.why.unwrap_or_else(|| "The base is not merged in.".into())) })
    }
}

/// What a Ship it asks for.
#[derive(Debug, Clone, Copy)]
pub struct ShipReq<'a> {
    /// the task the commit is for (its `Wisp-Task` trailer)
    pub task: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub draft: bool,
    /// the repo's PR so far: an open one is updated, not opened again
    pub pr: Option<&'a PrSummary>,
}
