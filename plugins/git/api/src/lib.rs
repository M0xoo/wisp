//! wisp-git-api: `git.service@1`, the worked example of a plugin service (plan §6.11.1).
//!
//! Worktrees, ship, review and the panes need a live repo handle: open a repo once, run many operations
//! on it, keep its cache warm. `GitService::repo(path)` returns one, cached per path and owned by the
//! caller's scope (`owner`): when that token is cancelled the handle and its subscriptions are released.
//! Every method takes the `Call` first and checks its permission before doing anything (`PERMISSIONS`
//! maps each method to one; the testkit refuses each without it). Plain data only crosses: large diffs
//! go as `BlobRef`s. Requested by contract (`git.service@^1`), never by provider, so a `jj` plugin can
//! provide the same service.

pub mod commands;
pub mod model;
pub mod ports;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Call, CancellationToken, Result, Service};

pub use model::*;
pub use ports::Blobs;

/// The contract id `git.service`, major 1.
#[derive(Debug)]
pub struct GitServiceV1;

impl Service for GitServiceV1 {
    const ID: &'static str = "git.service";
    const MAJOR: u32 = 1;
    type Api = dyn GitService;
}

/// Each method of the service and the permission it requires (plan §6.11.1 "each method is a
/// permission"). CI checks every trait method is listed; a plugin's manifest names what it needs.
pub const PERMISSIONS: &[(&str, &str)] = &[
    ("repo", "git:repo"),
    ("clone", "git:clone"),
    ("tools", "git:read"),
    ("status", "git:status"),
    ("changes", "git:diff"),
    ("diff", "git:diff"),
    ("touched", "git:diff"),
    ("branches", "git:read"),
    ("worktrees", "git:read"),
    ("base", "git:read"),
    ("rev_parse", "git:read"),
    ("count", "git:read"),
    ("is_ancestor", "git:read"),
    ("merge_base", "git:read"),
    ("merge_tree", "git:read"),
    ("base_merged", "git:commit"),
    ("show", "git:read"),
    ("files", "git:read"),
    ("remote_url", "git:read"),
    ("fetch", "git:fetch"),
    ("worktree_add", "git:worktree.add"),
    ("worktree_remove", "git:worktree.remove"),
    ("worktree_prune", "git:worktree.remove"),
    ("stage", "git:stage"),
    ("apply", "git:apply"),
    ("commit", "git:commit"),
    ("push", "git:push"),
    ("branch_delete", "git:branch.delete"),
    ("sync_base", "git:merge.ff"),
    ("snapshot", "git:snapshot"),
    ("patch", "git:snapshot"),
    ("on_change", "git:watch"),
    ("touch", "git:watch"),
];

/// The permission `method` requires, or None for a method that isn't part of the service.
pub fn permission(method: &str) -> Option<&'static str> {
    PERMISSIONS
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, p)| *p)
}

pub type Fut<T> = BoxFuture<'static, Result<T>>;
pub type ChangeFn = Arc<dyn Fn(RepoChange) + Send + Sync>;

/// A subscription (a Disposable): ends on `dispose()`, when it is dropped, or when its owner scope is
/// cancelled, whichever comes first.
#[derive(Debug)]
pub struct Subscription {
    token: CancellationToken,
}

impl Subscription {
    pub fn new(token: CancellationToken) -> Self {
        Self { token }
    }
    pub fn dispose(&self) {
        self.token.cancel();
    }
    pub fn is_live(&self) -> bool {
        !self.token.is_cancelled()
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.token.cancel();
    }
}

pub trait GitService: Send + Sync + 'static {
    /// The repo containing `path` (a worktree folder, a subfolder, the main checkout), cached per path.
    /// `not_found` outside a repo. The handle lives until `owner` is cancelled.
    fn repo(&self, call: &Call, owner: &CancellationToken, path: &str) -> Fut<Arc<dyn Repo>>;
    /// Clones `url` into `parent`/<name>, reusing a folder that already is this repo (v1 cloneRepo).
    fn clone_repo(&self, call: &Call, req: CloneRequest) -> Fut<Cloned>;
    /// Is git installed, and gh signed in? With how to get what's missing on this OS.
    fn tools(&self, call: &Call) -> Fut<Tools>;
}

/// A repo handle. Operations run in the folder the handle was opened at; worktree adds and removes run
/// in the main checkout, one at a time per repo (edge case Git 3).
pub trait Repo: Send + Sync + std::fmt::Debug + 'static {
    fn info(&self) -> &RepoInfo;

    fn status(&self, call: &Call) -> Fut<Status>;
    /// Everything changed since the merge-base with `base`, untracked files whole. None when git can't tell.
    fn changes(&self, call: &Call, base: &str) -> Fut<Option<Changes>>;
    /// `git diff from [to] -- paths`, parsed.
    fn diff(&self, call: &Call, req: DiffRequest) -> Fut<Body>;
    fn touched(&self, call: &Call, base: &str) -> Fut<Option<Touched>>;
    fn branches(&self, call: &Call) -> Fut<Vec<Branch>>;
    fn worktrees(&self, call: &Call) -> Fut<Vec<WorktreeEntry>>;
    /// What new work branches from (edge case Git 4); `fetch` refreshes origin first (good for 60 s).
    fn base(&self, call: &Call, fetch: bool) -> Fut<Option<BaseRef>>;
    /// `rev-parse --verify --quiet <rev>^{commit}`: the sha, or None when it isn't there.
    fn rev_parse(&self, call: &Call, rev: &str) -> Fut<Option<String>>;
    /// `rev-list --count <range>`: None when a ref in it isn't there.
    fn count(&self, call: &Call, range: &str) -> Fut<Option<u32>>;
    fn is_ancestor(&self, call: &Call, ancestor: &str, of: &str) -> Fut<bool>;
    fn merge_base(&self, call: &Call, a: &str, b: &str) -> Fut<Option<String>>;
    fn merge_tree(&self, call: &Call, a: &str, b: &str) -> Fut<MergeTree>;
    /// After the base was merged in: commits a resolved merge left uncommitted, then checks.
    fn base_merged(&self, call: &Call, base: &str) -> Fut<BaseMerged>;
    /// A file's bytes at `rev` (`git show rev:path`), None when it isn't there.
    fn show(&self, call: &Call, rev: &str, path: &str) -> Fut<Option<Vec<u8>>>;
    /// Every file git knows here plus new ones, capped at `max`.
    fn files(&self, call: &Call, max: usize) -> Fut<Vec<String>>;
    fn remote_url(&self, call: &Call, remote: &str) -> Fut<Option<String>>;

    fn fetch(&self, call: &Call, req: FetchRequest) -> Fut<()>;
    fn worktree_add(&self, call: &Call, req: WorktreeAdd) -> Fut<WorktreeEntry>;
    /// `worktree remove --force`, the folder deleted, then `worktree prune`. The safety decision is
    /// the caller's (wisp-worktrees-core); this only does it.
    fn worktree_remove(&self, call: &Call, path: &str) -> Fut<()>;
    fn worktree_prune(&self, call: &Call) -> Fut<()>;
    /// `add -A` (or `restore --staged`) of the paths git has something for: true when any moved.
    fn stage(&self, call: &Call, req: StageRequest) -> Fut<bool>;
    /// `git apply` a patch (index only with `cached`, three-way fallback with `three_way`).
    fn apply(&self, call: &Call, req: ApplyRequest) -> Fut<Applied>;
    /// Commits (everything first with `all`): the new sha, None when there was nothing to commit.
    fn commit(&self, call: &Call, req: CommitRequest) -> Fut<Option<String>>;
    fn push(&self, call: &Call, req: PushRequest) -> Fut<()>;
    /// Deletes a local branch: true when it went.
    fn branch_delete(&self, call: &Call, name: &str) -> Fut<bool>;
    /// Fast-forwards the user's `base` to origin's, never anything more invasive (edge case Git 8).
    fn sync_base(&self, call: &Call, base: &str) -> Fut<Synced>;
    /// The folder as it is, as a commit on top of HEAD no branch points at (untracked included).
    fn snapshot(&self, call: &Call) -> Fut<Option<String>>;
    /// A binary patch of the folder against `base`, untracked included; "" when nothing changed.
    fn patch(&self, call: &Call, base: &str) -> Fut<String>;

    fn on_change(
        &self,
        call: &Call,
        owner: &CancellationToken,
        cb: ChangeFn,
    ) -> Result<Subscription>;
    /// Something outside the service changed the repo (a turn ended): drop caches, tell subscribers.
    fn touch(&self, call: &Call, kind: &str) -> Result<()>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub from: String,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    /// "origin" when None
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub refspec: Option<String>,
    /// a whole-remote fetch younger than this is reused (60 s for launches, edge case Git 4)
    #[serde(default)]
    pub max_age_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdd {
    pub path: String,
    pub branch: String,
    /// Some: a new branch from this ref (`--no-track -b`); None: check out the existing branch
    #[serde(default)]
    pub start: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRequest {
    pub paths: Vec<String>,
    #[serde(default)]
    pub unstage: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub patch: String,
    #[serde(default)]
    pub cached: bool,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub three_way: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub applied: bool,
    #[serde(default)]
    pub merged: bool,
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub message: String,
    #[serde(default)]
    pub body: String,
    /// `add -A` first
    #[serde(default)]
    pub all: bool,
    /// conclude a merge with its own message (`--no-edit`)
    #[serde(default)]
    pub no_edit: bool,
    /// skip the repo's commit hooks (Ship it does; a commit from the panel doesn't)
    #[serde(default)]
    pub no_verify: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub remote: String,
    /// `HEAD:refs/heads/<branch>`, or the branch to delete with `delete`
    pub refspec: String,
    #[serde(default)]
    pub set_upstream: bool,
    #[serde(default)]
    pub delete: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Synced {
    pub ok: bool,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub url: String,
    pub parent: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cloned {
    pub dir: String,
    pub existed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolSetup {
    pub tip: String,
    pub command: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    pub installed: bool,
    /// gh only: None when its answer isn't one we know (offline), so nothing nags
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<ToolSetup>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tools {
    pub git: ToolState,
    pub gh: ToolState,
}
