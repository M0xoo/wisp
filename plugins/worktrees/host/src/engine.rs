//! A session's worktree: made (v1 createWorktree), brought back (ensureWorktree), read (worktreeStatus,
//! folderOnly) and removed (removeWorktree). Every git call goes through git.service@1 with the caller's
//! `Call`, so its permissions are checked there; the decisions are wisp-worktrees-core's.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use wisp_git_api::{GitService, Repo, WorktreeAdd};
use wisp_kernel::{Call, CancellationToken, Clock};
use wisp_proc::Proc;
use wisp_worktrees_api::{CreateArgs, Prepared, RemoveOpts, Removed, SetupSource, Worktree, WorktreeStatus};
use wisp_worktrees_core::{naming, removal};

use crate::error::{Result, WtError};
use crate::fsx;

/// The longest a turn's claim on its folder holds when runtime never says the turn started (a turn refused after
/// its `ready`): its `ready` (at most `READY_MS`) and the save that marks it running, with room to spare.
pub const CLAIM_MS: i64 = 150_000;

/// Who claims a folder: a task's turn (`turn`: its id, let go by that turn's `turn.started` or `turn.held`), or a
/// side run of the task (`turn` None: a /btw or a quick run, which no event confirms; it lapses after `CLAIM_MS`).
#[derive(Debug, Clone, Copy)]
pub struct Claimant<'a> {
    pub task: &'a str,
    pub turn: Option<&'a str>,
}

impl<'a> Claimant<'a> {
    pub fn turn(task: &'a str, turn: &'a str) -> Self {
        Self { task, turn: Some(turn) }
    }
    pub fn side(task: &'a str) -> Self {
        Self { task, turn: None }
    }
}

/// One turn's (or side run's) claim on one folder: its number on the claims' counter, when, and whether it still
/// holds (false once runtime saved that turn running or held: from then the task's state says it's in use, its own
/// folder by its slot, an extra folder by its `dirs`, `Port::extra_in_use`).
#[derive(Debug, Clone)]
struct Claim {
    n: u64,
    at: i64,
    live: bool,
}

/// The claims, by (folder, task, turn; "" for a side run). Per turn: a late `turn.started` of a turn that failed
/// at once lets go of its own claims only, never the next queued turn's (ADR-0053).
type Claims = HashMap<(String, String, String), Claim>;

/// Everything a worktree operation needs. Cheap to share (`Arc<Engine>`).
pub struct Engine {
    pub git: Arc<dyn GitService>,
    pub proc: Proc,
    pub clock: Arc<dyn Clock>,
    /// wisp's home (`~/.wisp`): worktrees go under `<home>/worktrees`
    pub home: String,
    /// the user's home, for Conductor's folders
    pub user_home: String,
    /// "macos" | "linux" | "windows"
    pub platform: &'static str,
    pub sources: Vec<Arc<dyn SetupSource>>,
    /// the plugin's scope: repo handles are released with it
    pub owner: CancellationToken,
    /// one operation at a time per folder: a bring-back waits for a removal under way
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// each turn's claim on each folder (`claim`), by (folder, task, turn), on one counter
    claims: std::sync::Mutex<(u64, Claims)>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").field("home", &self.home).finish_non_exhaustive()
    }
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        git: Arc<dyn GitService>,
        proc: Proc,
        clock: Arc<dyn Clock>,
        home: String,
        user_home: String,
        platform: &'static str,
        sources: Vec<Arc<dyn SetupSource>>,
        owner: CancellationToken,
    ) -> Self {
        Self {
            git,
            proc,
            clock,
            home,
            user_home,
            platform,
            sources,
            owner,
            locks: Mutex::new(HashMap::new()),
            claims: std::sync::Mutex::new((0, HashMap::new())),
        }
    }

    pub async fn repo(&self, call: &Call, path: &str) -> Result<Arc<dyn Repo>> {
        Ok(self.git.repo(call, &self.owner, path).await?)
    }

    async fn lock(&self, path: &str) -> Arc<Mutex<()>> {
        self.locks.lock().await.entry(path.to_owned()).or_default().clone()
    }

    /// Where the claims stand now: a removal decided after this mark asks `claimed_since` last thing.
    pub fn mark(&self) -> u64 {
        self.claims.lock().unwrap_or_else(std::sync::PoisonError::into_inner).0
    }

    /// `who`'s turn (or side run) is about to run in `path`: a removal of it decided before now stands down, and so
    /// does one decided after, until runtime says that turn started (`release`; till then the task still reads
    /// archived and idle) or `CLAIM_MS` passes.
    /// The path is kept as the disk sees it (`fsx::norm`), as `claimed_since` is asked.
    pub async fn claim(&self, path: &str, who: Claimant<'_>) {
        let path = fsx::norm(path).await;
        let now = self.clock.now_ms();
        let mut c = self.claims.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        c.0 += 1;
        let n = c.0;
        // a look older than this is long over; a released claim still answers looks made before it
        c.1.retain(|_, k| now - k.at < 4 * CLAIM_MS);
        let key = (path, who.task.to_owned(), who.turn.unwrap_or_default().to_owned());
        c.1.insert(key, Claim { n, at: now, live: true });
    }

    /// Runtime saved `task`'s turn `turn` (running, or held): its own state guards the folders from here. Only that
    /// turn's claims let go; a side run's, and another turn's of the same task, hold on.
    pub fn release(&self, task: &str, turn: &str) {
        let mut c = self.claims.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for (_, k) in c.1.iter_mut().filter(|((_, t, u), _)| t == task && !u.is_empty() && u == turn) {
            k.live = false;
        }
    }

    /// Whether a turn claimed `path` after `mark`, or is still starting in it. `path` as the disk sees it
    /// (`fsx::norm`, as the claims are kept): a claim on it through a symlink or with `..` counts.
    pub fn claimed_since(&self, path: &str, mark: u64) -> bool {
        let now = self.clock.now_ms();
        self.claims
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .1
            .iter()
            // a claim on the folder, or on a folder inside it (an extra folder that's a worktree's subfolder)
            .filter(|((p, _, _), _)| fsx::within(p, path))
            .any(|(_, k)| k.n > mark || (k.live && now - k.at < CLAIM_MS))
    }

    pub fn foreign(&self, wt: &Worktree) -> bool {
        removal::is_foreign(wt, &self.user_home, self.sources.iter().any(|s| s.owns(&wt.path)))
    }

    /// A fresh worktree and branch under `<home>/worktrees`; None outside a repo with commits.
    /// `hold`: the setup steps to keep back until the repo is trusted (decided by the caller).
    pub async fn create(
        &self,
        call: &Call,
        args: &CreateArgs,
        hold: Option<Vec<wisp_worktrees_api::TrustItem>>,
    ) -> Result<Option<Worktree>> {
        let Ok(here) = self.repo(call, &args.cwd).await else {
            return Ok(None);
        };
        let Some(base) = here.base(call, true).await? else {
            return Ok(None);
        };
        let info = here.info().clone();
        let root = self.repo(call, &info.root).await?;
        let short = naming::short_branch(&args.title, &args.session_id);
        let taken = root.rev_parse(call, &format!("refs/heads/{short}")).await?.is_some();
        let branch = naming::branch_for(&args.title, &args.session_id, taken);
        let dir = naming::worktree_dir(&self.home, &info.root, &args.session_id);
        fsx::mkdirp(fsx::parent(&dir)).await?;
        root.worktree_add(call, WorktreeAdd { path: dir.clone(), branch: branch.clone(), start: Some(base.reference.clone()) }).await?;
        let prepared = crate::prepare::prepare(self, &info.root, &dir, hold, &base.branch).await;
        if !prepared.problems.is_empty() {
            tracing::warn!(dir = %dir, problems = ?prepared.problems, "worktree prepared with problems");
        }
        let cwd = if info.sub.is_empty() { dir.clone() } else { format!("{dir}/{}", info.sub) };
        Ok(Some(Worktree {
            path: dir,
            cwd,
            branch,
            base: base.branch,
            base_ref: base.reference,
            head: Some(base.sha).filter(|s| !s.is_empty()),
            remote: base.remote,
            root: info.root,
            created_at: self.clock.now_ms(),
            prepared: prepared_or_none(prepared),
            ..Worktree::default()
        }))
    }

    /// Brings a cleaned-up worktree back from its branch (its ignored files again, not its setup).
    pub async fn ensure(&self, call: &Call, wt: &Worktree) -> Result<()> {
        let lock = self.lock(&wt.path).await;
        let _held = lock.lock().await;
        match removal::ensure_plan(fsx::exists(&wt.path).await, self.foreign(wt), &wt.path) {
            removal::EnsurePlan::Nothing => Ok(()),
            removal::EnsurePlan::Refuse(m) => Err(WtError::Conflict(m)),
            removal::EnsurePlan::Restore => {
                let root = self.repo(call, &wt.root).await?;
                let _ = root.worktree_prune(call).await;
                root.worktree_add(call, WorktreeAdd { path: wt.path.clone(), branch: wt.branch.clone(), start: None }).await?;
                let _ = crate::prepare::copy_included(self, &wt.root, &wt.path).await;
                Ok(())
            }
        }
    }

    /// Changed paths, commits past the base, commits not on the remote (from the merged PR's head first).
    pub async fn status(&self, call: &Call, wt: &Worktree, merged: Option<&str>) -> Result<WorktreeStatus> {
        if !fsx::exists(&wt.path).await {
            return Ok(WorktreeStatus::default());
        }
        let repo = self.repo(call, &wt.path).await?;
        let base_range = format!("{}..HEAD", wt.base_ref);
        let (st, ahead) = tokio::join!(repo.status(call), repo.count(call, &base_range));
        let ahead = ahead.ok().flatten().unwrap_or(0);
        let mut counts = Vec::new();
        for r in removal::pushed_refs(merged, wt.remote.as_deref(), &wt.branch) {
            let n = repo.count(call, &format!("{r}..HEAD")).await.ok().flatten();
            counts.push(n);
            if n.is_some() {
                break;
            }
        }
        let dirty = st.map_or(0, |s| u32::try_from(s.dirty()).unwrap_or(u32::MAX));
        Ok(WorktreeStatus { exists: true, dirty, ahead, unpushed: removal::unpushed(ahead, &counts) })
    }

    /// What only this folder holds; Err when git can't tell (a repo that moved).
    pub async fn folder_only(&self, call: &Call, wt: &Worktree) -> Result<u32> {
        let repo = self.repo(call, &wt.path).await?;
        let root = self.repo(call, &wt.root).await?;
        let tip_ref = format!("refs/heads/{}", wt.branch);
        let (st, head, tip) = tokio::join!(repo.status(call), repo.rev_parse(call, "HEAD"), async {
            if wt.branch.is_empty() { Ok(None) } else { root.rev_parse(call, &tip_ref).await }
        });
        let st = st?;
        let head = head?.ok_or_else(|| WtError::Conflict("no HEAD".into()))?;
        let tip = tip?;
        if !wt.branch.is_empty() && tip.is_none() {
            return Err(WtError::Conflict(format!("branch {} is gone", wt.branch)));
        }
        Ok(removal::folder_only(u32::try_from(st.dirty()).unwrap_or(u32::MAX), &head, tip.as_deref()))
    }

    /// Removes the folder only when nothing would be lost (or forced); the branch per `opts.branch`.
    /// `still`: asked last thing before the folder goes.
    pub async fn remove(
        &self,
        call: &Call,
        wt: &Worktree,
        opts: RemoveOpts,
        still: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> Result<Removed> {
        let lock = self.lock(&wt.path).await;
        let _held = lock.lock().await;
        let foreign = self.foreign(wt);
        let exists = !foreign && fsx::exists(&wt.path).await;
        let dirt = if exists {
            if opts.strict {
                removal::removal_dirt(true, self.folder_only(call, wt).await.ok(), 0)
            } else {
                self.status(call, wt, None).await.map_or(0, |s| s.dirty)
            }
        } else {
            0
        };
        match removal::decide_removal(foreign, exists, dirt, opts.force, still.map(|f| f())) {
            removal::RemoveStep::Foreign => {
                return Ok(Removed { foreign: true, ..Removed::default() });
            }
            removal::RemoveStep::KeepDirty(n) => {
                return Ok(Removed { dirty: Some(n), ..Removed::default() });
            }
            removal::RemoveStep::Overtaken => return Ok(Removed::default()),
            removal::RemoveStep::Remove => match self.repo(call, &wt.root).await {
                Ok(root) => {
                    if root.worktree_remove(call, &wt.path).await.is_err() {
                        fsx::rm_rf(&wt.path).await; // git lost track of it: the folder goes anyway
                        let _ = root.worktree_prune(call).await;
                    }
                }
                Err(_) => fsx::rm_rf(&wt.path).await, // a leftover no repo knows: only the folder goes
            },
            removal::RemoveStep::Gone => {}
        }
        let branch_deleted = self.drop_branch(call, wt, opts).await;
        Ok(Removed { removed: true, branch_deleted, ..Removed::default() })
    }

    async fn drop_branch(&self, call: &Call, wt: &Worktree, opts: RemoveOpts) -> bool {
        if wt.branch.is_empty() || opts.branch == wisp_worktrees_api::BranchMode::Keep {
            return false;
        }
        let Ok(root) = self.repo(call, &wt.root).await else {
            return false;
        };
        let unique = root.count(call, &format!("{}..{}", wt.base_ref, wt.branch)).await.ok().flatten();
        removal::delete_branch(opts.branch, unique) && root.branch_delete(call, &wt.branch).await.unwrap_or(false)
    }
}

/// `prepared` stays off the record unless it says something.
pub fn prepared_or_none(p: Prepared) -> Option<Prepared> {
    (!p.is_empty()).then_some(p)
}
