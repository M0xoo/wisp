//! A repo handle (`git.service@1`'s `Repo`): every method checks the caller's permission first (the
//! table in wisp-git-api), then runs in the folder the handle was opened at. The work is in `read.rs`,
//! `write.rs` and `changes.rs`; this file is the guarded surface.

use std::path::PathBuf;
use std::sync::Arc;

use wisp_git_api::{
    Applied, ApplyRequest, BaseMerged, BaseRef, Blobs, Body, Branch, ChangeFn, Changes,
    CommitRequest, DiffRequest, FetchRequest, Fut, MergeTree, PushRequest, Repo, RepoChange,
    RepoInfo, StageRequest, Status, Subscription, Synced, Touched, WorktreeAdd, WorktreeEntry,
    permission,
};
use wisp_kernel::{Call, CancellationToken, Result, WireError};

use crate::run::Git;
use crate::shared::{Now, RootState};

pub struct Inner {
    pub info: RepoInfo,
    pub dir: PathBuf,
    pub root: PathBuf,
    pub git: Arc<Git>,
    pub shared: Arc<RootState>,
    pub blobs: Option<Arc<dyn Blobs>>,
    pub now: Now,
}

impl Inner {
    pub fn notify(&self, kind: &str) {
        self.shared.notify(&RepoChange {
            root: self.info.root.clone(),
            path: self.info.path.clone(),
            kind: kind.to_owned(),
        });
    }
}

#[derive(Clone)]
pub struct RepoImpl {
    pub(crate) inner: Arc<Inner>,
}

impl std::fmt::Debug for RepoImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repo")
            .field("path", &self.inner.info.path)
            .field("root", &self.inner.info.root)
            .finish()
    }
}

/// The permission of `method`, required of `call`. A method missing from the table is refused.
fn guard(call: &Call, method: &str) -> Result<()> {
    let p = permission(method)
        .ok_or_else(|| WireError::forbidden(format!("git.service has no method {method}")))?;
    call.require(p)
}

macro_rules! guarded {
    ($self:ident, $call:ident, $method:literal, |$me:ident| $body:expr) => {{
        let ok = guard($call, $method);
        let $me = $self.inner.clone();
        Box::pin(async move {
            ok?;
            $body.await.map_err(WireError::from)
        })
    }};
}

impl Repo for RepoImpl {
    fn info(&self) -> &RepoInfo {
        &self.inner.info
    }
    fn status(&self, call: &Call) -> Fut<Status> {
        guarded!(self, call, "status", |me| me.status())
    }
    fn changes(&self, call: &Call, base: &str) -> Fut<Option<Changes>> {
        let base = base.to_owned();
        guarded!(self, call, "changes", |me| me.changes(&base, false))
    }
    fn diff(&self, call: &Call, req: DiffRequest) -> Fut<Body> {
        guarded!(self, call, "diff", |me| me.diff(req))
    }
    fn touched(&self, call: &Call, base: &str) -> Fut<Option<Touched>> {
        let base = base.to_owned();
        guarded!(self, call, "touched", |me| me.touched(&base))
    }
    fn branches(&self, call: &Call) -> Fut<Vec<Branch>> {
        guarded!(self, call, "branches", |me| me.branches())
    }
    fn worktrees(&self, call: &Call) -> Fut<Vec<WorktreeEntry>> {
        guarded!(self, call, "worktrees", |me| me.worktrees())
    }
    fn base(&self, call: &Call, fetch: bool) -> Fut<Option<BaseRef>> {
        // fetching first needs the fetch permission too
        let fetch_ok = if fetch { guard(call, "fetch") } else { Ok(()) };
        let ok = guard(call, "base").and(fetch_ok);
        let me = self.inner.clone();
        Box::pin(async move {
            ok?;
            me.base(fetch).await.map_err(WireError::from)
        })
    }
    fn rev_parse(&self, call: &Call, rev: &str) -> Fut<Option<String>> {
        let rev = rev.to_owned();
        guarded!(self, call, "rev_parse", |me| me.rev_parse(&rev))
    }
    fn count(&self, call: &Call, range: &str) -> Fut<Option<u32>> {
        let range = range.to_owned();
        guarded!(self, call, "count", |me| me.count(&range))
    }
    fn is_ancestor(&self, call: &Call, ancestor: &str, of: &str) -> Fut<bool> {
        let (a, b) = (ancestor.to_owned(), of.to_owned());
        guarded!(self, call, "is_ancestor", |me| me.is_ancestor(&a, &b))
    }
    fn merge_base(&self, call: &Call, a: &str, b: &str) -> Fut<Option<String>> {
        let (a, b) = (a.to_owned(), b.to_owned());
        guarded!(self, call, "merge_base", |me| me.merge_base(&a, &b))
    }
    fn merge_tree(&self, call: &Call, a: &str, b: &str) -> Fut<MergeTree> {
        let (a, b) = (a.to_owned(), b.to_owned());
        guarded!(self, call, "merge_tree", |me| me.merge_tree(&a, &b))
    }
    fn base_merged(&self, call: &Call, base: &str) -> Fut<BaseMerged> {
        let base = base.to_owned();
        guarded!(self, call, "base_merged", |me| me.base_merged(&base))
    }
    fn show(&self, call: &Call, rev: &str, path: &str) -> Fut<Option<Vec<u8>>> {
        let (rev, path) = (rev.to_owned(), path.to_owned());
        guarded!(self, call, "show", |me| me.show(&rev, &path))
    }
    fn files(&self, call: &Call, max: usize) -> Fut<Vec<String>> {
        guarded!(self, call, "files", |me| me.files(max))
    }
    fn remote_url(&self, call: &Call, remote: &str) -> Fut<Option<String>> {
        let remote = remote.to_owned();
        guarded!(self, call, "remote_url", |me| me.remote_url(&remote))
    }
    fn fetch(&self, call: &Call, req: FetchRequest) -> Fut<()> {
        guarded!(self, call, "fetch", |me| me.fetch(req))
    }
    fn worktree_add(&self, call: &Call, req: WorktreeAdd) -> Fut<WorktreeEntry> {
        guarded!(self, call, "worktree_add", |me| me.worktree_add(req))
    }
    fn worktree_remove(&self, call: &Call, path: &str) -> Fut<()> {
        let path = path.to_owned();
        guarded!(self, call, "worktree_remove", |me| me
            .worktree_remove(&path))
    }
    fn worktree_prune(&self, call: &Call) -> Fut<()> {
        guarded!(self, call, "worktree_prune", |me| me.worktree_prune())
    }
    fn stage(&self, call: &Call, req: StageRequest) -> Fut<bool> {
        guarded!(self, call, "stage", |me| me.stage(req))
    }
    fn apply(&self, call: &Call, req: ApplyRequest) -> Fut<Applied> {
        guarded!(self, call, "apply", |me| me.apply(req))
    }
    fn commit(&self, call: &Call, req: CommitRequest) -> Fut<Option<String>> {
        guarded!(self, call, "commit", |me| me.commit(req))
    }
    fn push(&self, call: &Call, req: PushRequest) -> Fut<()> {
        guarded!(self, call, "push", |me| me.push(req))
    }
    fn branch_delete(&self, call: &Call, name: &str) -> Fut<bool> {
        let name = name.to_owned();
        guarded!(self, call, "branch_delete", |me| me.branch_delete(&name))
    }
    fn sync_base(&self, call: &Call, base: &str) -> Fut<Synced> {
        let base = base.to_owned();
        guarded!(self, call, "sync_base", |me| me.sync_base(&base))
    }
    fn snapshot(&self, call: &Call) -> Fut<Option<String>> {
        guarded!(self, call, "snapshot", |me| me.snapshot())
    }
    fn patch(&self, call: &Call, base: &str) -> Fut<String> {
        let base = base.to_owned();
        guarded!(self, call, "patch", |me| me.patch(&base))
    }
    fn restore(&self, call: &Call, to: &str, head: &str) -> Fut<()> {
        let (to, head) = (to.to_owned(), head.to_owned());
        guarded!(self, call, "restore", |me| me.restore(&to, &head))
    }
    fn on_change(
        &self,
        call: &Call,
        owner: &CancellationToken,
        cb: ChangeFn,
    ) -> Result<Subscription> {
        guard(call, "on_change")?;
        Ok(self.inner.shared.subscribe(owner, cb))
    }
    fn touch(&self, call: &Call, kind: &str) -> Result<()> {
        guard(call, "touch")?;
        self.inner.notify(kind);
        Ok(())
    }
}
