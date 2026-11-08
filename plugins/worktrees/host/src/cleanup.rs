//! Settings → Worktrees and the hourly sweep (v1 services/worktrees.js): looks (git status only in a
//! folder that moved, du at most every 6 h), the view, Clean up now, and the sweep that prunes every repo
//! tasks know and removes what wisp-worktrees-core's policy picks. Removals re-check right before.
//!
//! size-ok: the pane, Clean up now and the sweep share one look cache and one per-repo lock

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use tokio::sync::{Mutex, Semaphore};
use wisp_kernel::Call;
use wisp_proc::ExecOpts;
use wisp_worktrees_api::{
    CleanArgs, CleanOut, CleanedRecord, Disk, ItemRow, LeftoverRow, Progress, RemoveOpts, Standing,
    SweepOut, Worktree, WorktreesView,
};
use wisp_worktrees_core::sweep::{self, DiskLimits, Policy, TaskSnap, TreeSnap};

use crate::engine::Engine;
use crate::error::{Result, WtError};
use crate::fsx;
use crate::ports::{Port, TaskInfo};

#[derive(Debug, Clone, Copy)]
struct Look {
    only: Option<u32>,
    touched: i64,
    used: i64,
}

#[derive(Debug, Default)]
struct Seen {
    at: i64,
    trees: HashMap<String, Look>,
    sizes: HashMap<String, u64>,
    sized: i64,
    leftovers: Vec<String>,
    disk: Option<Disk>,
    /// a folder came or went since the last du
    changed: bool,
}

enum Job {
    Task(String, bool),
    Leftover(String),
}

pub struct Cleanup {
    pub engine: Arc<Engine>,
    pub port: Arc<dyn Port>,
    /// the call background work speaks as (the plugin's own root call)
    pub call: Call,
    seen: Mutex<Seen>,
    queue: Mutex<VecDeque<Job>>,
    cleaning: std::sync::Mutex<Option<Progress>>,
    scanning: Mutex<()>,
}

impl std::fmt::Debug for Cleanup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cleanup").finish_non_exhaustive()
    }
}

fn dir_of(e: &Engine) -> String {
    format!("{}/worktrees", e.home.trim_end_matches('/'))
}

/// A task's folders that are wisp's (foreign ones are never counted or touched).
fn own_trees<'a>(e: &Engine, t: &'a TaskInfo) -> Vec<&'a Worktree> {
    t.trees
        .iter()
        .map(|x| &x.worktree)
        .filter(|w| !w.path.is_empty() && !e.foreign(w))
        .collect()
}

impl Cleanup {
    pub fn new(engine: Arc<Engine>, port: Arc<dyn Port>, call: Call) -> Arc<Self> {
        let seen = Seen {
            changed: true,
            ..Seen::default()
        };
        Arc::new(Self {
            engine,
            port,
            call,
            seen: Mutex::new(seen),
            queue: Mutex::new(VecDeque::new()),
            cleaning: std::sync::Mutex::new(None),
            scanning: Mutex::new(()),
        })
    }

    fn cleaning(&self) -> Option<Progress> {
        self.cleaning.lock().ok().and_then(|c| *c)
    }

    fn set_cleaning(&self, v: Option<Progress>) {
        if let Ok(mut c) = self.cleaning.lock() {
            *c = v;
        }
    }

    /// A new folder: sizes are stale.
    pub async fn added(&self) {
        self.seen.lock().await.changed = true;
    }

    async fn du(&self, dir: &str) -> Option<HashMap<String, u64>> {
        let r = self
            .engine
            .proc
            .exec(
                "du",
                &["-k".into(), "-d".into(), "1".into(), dir.into()],
                ExecOpts {
                    timeout: Some(std::time::Duration::from_secs(120)),
                    ..ExecOpts::default()
                },
            )
            .await
            .ok()?;
        Some(sweep::parse_du(&r.stdout_text(), dir).into_iter().collect())
    }

    async fn disk(&self, dir: &str) -> Option<Disk> {
        let r = self
            .engine
            .proc
            .exec(
                "df",
                &["-Pk".into(), dir.into()],
                ExecOpts {
                    timeout: Some(std::time::Duration::from_secs(10)),
                    ..ExecOpts::default()
                },
            )
            .await
            .ok()?;
        sweep::parse_df(&r.stdout_text())
    }

    /// One look; a look already under way is joined, not repeated.
    pub async fn scan(&self) {
        let Ok(_one) = self.scanning.try_lock() else {
            let _wait = self.scanning.lock().await;
            return;
        };
        let now = self.engine.clock.now_ms();
        let dir = dir_of(&self.engine);
        let (prev_trees, sized, changed) = {
            let s = self.seen.lock().await;
            (s.trees.clone(), s.sized, s.changed)
        };
        let du = sweep::du_due(changed, sized, now, self.port.machine_short());
        let (sizes, disk) = tokio::join!(
            async { if du { self.du(&dir).await } else { None } },
            self.disk(&dir)
        );
        let tasks = self.port.tasks().await;
        let known: HashSet<String> = tasks
            .iter()
            .flat_map(|t| own_trees(&self.engine, t))
            .map(|w| w.path.clone())
            .collect();
        let leftovers: Vec<String> = fsx::entries(&dir)
            .await
            .into_iter()
            .filter(|(n, d)| *d && !known.contains(&fsx::join(&dir, n)))
            .map(|(n, _)| n)
            .collect();
        let mut all: Vec<(Worktree, i64)> = tasks
            .iter()
            .flat_map(|t| {
                own_trees(&self.engine, t)
                    .into_iter()
                    .map(|w| (w.clone(), t.updated_at))
            })
            .collect();
        for name in &leftovers {
            let path = fsx::join(&dir, name);
            all.push((self.leftover(&path).await, 0));
        }
        let found = self.look_all(all, &prev_trees).await;
        let mut s = self.seen.lock().await;
        if let Some(z) = sizes {
            s.sizes = z;
            s.sized = now;
            s.changed = false;
        }
        s.trees = found;
        s.leftovers = leftovers;
        s.disk = disk.or(s.disk);
        s.at = self.engine.clock.now_ms().max(1);
    }

    async fn look_all(
        &self,
        all: Vec<(Worktree, i64)>,
        prev: &HashMap<String, Look>,
    ) -> HashMap<String, Look> {
        let gate = Arc::new(Semaphore::new(sweep::LOOKS));
        let mut set = tokio::task::JoinSet::new();
        for (wt, used) in all {
            let Some(touched) = fsx::mtime_ms(&wt.path).await else {
                continue;
            };
            let was = prev.get(&wt.path).map(|l| (l.only, l.touched, l.used));
            if !sweep::needs_look(was, touched, used) {
                if let Some(l) = prev.get(&wt.path) {
                    set.spawn(std::future::ready((wt.path, *l)));
                }
                continue;
            }
            let (e, call, gate) = (self.engine.clone(), self.call.clone(), gate.clone());
            set.spawn(async move {
                let _p = gate.acquire_owned().await;
                let only = e.folder_only(&call, &wt).await.ok();
                (
                    wt.path,
                    Look {
                        only,
                        touched,
                        used,
                    },
                )
            });
        }
        let mut out = HashMap::new();
        while let Some(r) = set.join_next().await {
            if let Ok((p, l)) = r {
                out.insert(p, l);
            }
        }
        out
    }

    /// A folder no task knows: git says which repo it belongs to. Without one, only the folder goes.
    async fn leftover(&self, path: &str) -> Worktree {
        let dot = fsx::read_opt(fsx::join(path, ".git")).await;
        let root = dot
            .as_deref()
            .and_then(wisp_worktrees_core::removal::leftover_root)
            .unwrap_or_else(|| path.to_owned());
        Worktree {
            path: path.to_owned(),
            cwd: path.to_owned(),
            root,
            ..Worktree::default()
        }
    }

    async fn snaps(&self, tasks: &[TaskInfo]) -> Vec<TaskSnap> {
        let s = self.seen.lock().await;
        let mut out = Vec::with_capacity(tasks.len());
        for t in tasks {
            let mut trees = Vec::new();
            for w in own_trees(&self.engine, t) {
                let l = s.trees.get(&w.path);
                let on_disk = fsx::exists(&w.path).await;
                trees.push(TreeSnap {
                    path: w.path.clone(),
                    branch: w.branch.clone(),
                    on_disk,
                    only: l.map(|l| l.only),
                    touched: l.map_or(0, |l| l.touched),
                    size: s.sizes.get(&w.path).copied(),
                });
            }
            let prs = || t.trees.iter().filter_map(|x| x.pr.as_ref());
            out.push(TaskSnap {
                id: t.id.clone(),
                title: t.title.clone(),
                project: t.project.clone(),
                done: t.done,
                busy: t.busy,
                kept: t.kept,
                parked: t.parked,
                pr_open: prs().any(|p| p.state == "OPEN"),
                pr_ended: prs().any(|p| p.state == "MERGED" || p.state == "CLOSED"),
                updated_at: t.updated_at,
                created_at: t.created_at,
                trees,
            });
        }
        out
    }

    async fn policy(&self) -> (Policy, crate::ports::WtSettings) {
        let st = self.port.settings().await;
        (
            Policy::from_settings(st.cleanup.as_deref(), st.max.as_deref(), st.cleanup_from),
            st,
        )
    }

    /// Settings → Worktrees. `look`: start a look when the last is stale (false: read the last only).
    pub async fn view(self: &Arc<Self>, look: bool) -> WorktreesView {
        let now = self.engine.clock.now_ms();
        let stale = now - self.seen.lock().await.at > sweep::FRESH_MS;
        if look && stale {
            let me = self.clone();
            let owner = self.engine.owner.clone();
            tokio::spawn(async move {
                tokio::select! { () = owner.cancelled() => {}, () = me.scan() => {} }
            });
        }
        let tasks = self.port.tasks().await;
        let snaps = self.snaps(&tasks).await;
        let (p, st) = self.policy().await;
        let items: Vec<ItemRow> = snaps
            .iter()
            .filter(|s| s.held_count() > 0)
            .map(|s| {
                let status = sweep::standing(s);
                ItemRow {
                    id: s.id.clone(),
                    title: s.title.clone(),
                    project: s.project.clone(),
                    branch: s
                        .trees
                        .first()
                        .map(|t| t.branch.clone())
                        .unwrap_or_default(),
                    status,
                    only: s.only(),
                    size: s.size(),
                    used_at: s.used_at(),
                    clean_at: (status == Standing::Idle)
                        .then(|| sweep::clean_at(s, &p))
                        .flatten(),
                }
            })
            .collect();
        let seen = self.seen.lock().await;
        let dir = dir_of(&self.engine);
        let mut leftovers = Vec::new();
        for name in &seen.leftovers {
            let path = fsx::join(&dir, name);
            if fsx::exists(&path).await {
                let l = seen.trees.get(&path);
                leftovers.push(LeftoverRow {
                    name: name.clone(),
                    size: seen.sizes.get(&path).copied(),
                    only: l.and_then(|l| l.only),
                    used_at: l.map_or(0, |l| l.touched),
                });
            }
        }
        let sized: Vec<u64> = items
            .iter()
            .filter_map(|x| x.size)
            .chain(leftovers.iter().filter_map(|x| x.size))
            .collect();
        let ready = items
            .iter()
            .filter(|x| x.status == Standing::Idle && now - x.used_at >= sweep::MIN_IDLE)
            .count();
        WorktreesView {
            cleanup: st
                .cleanup
                .clone()
                .unwrap_or_else(|| sweep::CLEANUP_DEFAULT.into()),
            max: st.max.clone().unwrap_or_else(|| sweep::MAX_DEFAULT.into()),
            size: (!sized.is_empty()).then(|| sized.iter().sum()),
            items,
            leftovers,
            disk: seen.disk,
            ready: u32::try_from(ready).unwrap_or(u32::MAX),
            looking: seen.at == 0 || self.scanning.try_lock().is_err(),
            cleaning: self.cleaning(),
            last: st.last,
        }
    }

    /// Clean up now / one task / named leftovers. Runs in the background; `view` shows `cleaning`.
    pub async fn clean(self: &Arc<Self>, args: CleanArgs) -> Result<CleanOut> {
        if self.seen.lock().await.at == 0 {
            self.scan().await; // what it finds stale, the removal reads again
        }
        let tasks = self.port.tasks().await;
        let snaps = self.snaps(&tasks).await;
        let known = self.seen.lock().await.leftovers.clone();
        let picked = sweep::pick_clean(
            &snaps,
            args.ids.as_deref(),
            &args.leftovers,
            &known,
            args.force,
            self.engine.clock.now_ms(),
        )
        .map_err(|e| match e {
            sweep::PickError::NotALeftover(n) => {
                WtError::Invalid(format!("Not a leftover worktree: {n}"))
            }
            sweep::PickError::InUse => {
                WtError::Conflict("That worktree is in use or holds uncommitted work.".into())
            }
        })?;
        let queued = picked.jobs.len() + args.leftovers.len();
        {
            let mut q = self.queue.lock().await;
            q.extend(picked.jobs.into_iter().map(|(id, f)| Job::Task(id, f)));
            q.extend(args.leftovers.into_iter().map(Job::Leftover));
        }
        if queued > 0 && self.cleaning().is_none() {
            let me = self.clone();
            tokio::spawn(async move { me.work(false).await });
        }
        Ok(CleanOut {
            queued: u32::try_from(queued).unwrap_or(u32::MAX),
            skipped: picked.skipped,
        })
    }

    async fn work(&self, auto: bool) -> Option<CleanedRecord> {
        if self.cleaning().is_some() {
            return None;
        }
        let total = u32::try_from(self.queue.lock().await.len()).unwrap_or(u32::MAX);
        self.set_cleaning(Some(Progress { done: 0, total }));
        let (mut count, mut freed) = (0u32, 0u64);
        loop {
            let Some(job) = self.queue.lock().await.pop_front() else {
                break;
            };
            let (gone, size) = self.run_job(job).await;
            if gone {
                count += 1;
                freed += size;
            }
            if let Ok(mut c) = self.cleaning.lock() {
                *c = c.map(|p| Progress {
                    done: p.done + 1,
                    total: p.total.max(total),
                });
            }
        }
        self.set_cleaning(None);
        let dir = dir_of(&self.engine);
        let disk = self.disk(&dir).await;
        let mut seen = self.seen.lock().await;
        seen.disk = disk.or(seen.disk);
        if count == 0 {
            return None;
        }
        seen.changed = true;
        drop(seen);
        let rec = CleanedRecord {
            at: self.engine.clock.now_ms(),
            count,
            freed,
            auto,
        };
        let mut st = self.port.settings().await;
        st.last = Some(rec);
        self.port.save_settings(st).await;
        tracing::info!(count, auto, "removed worktrees");
        Some(rec)
    }

    async fn run_job(&self, job: Job) -> (bool, u64) {
        let dir = dir_of(&self.engine);
        match job {
            Job::Leftover(name) => {
                let path = fsx::join(&dir, &name);
                let size = self
                    .seen
                    .lock()
                    .await
                    .sizes
                    .get(&path)
                    .copied()
                    .unwrap_or(0);
                let wt = self.leftover(&path).await;
                let r = self
                    .engine
                    .remove(
                        &self.call,
                        &wt,
                        RemoveOpts {
                            force: true,
                            ..RemoveOpts::default()
                        },
                        None,
                    )
                    .await;
                (r.is_ok_and(|r| r.removed), size)
            }
            Job::Task(id, force) => {
                let tasks = self.port.tasks().await;
                let Some(t) = tasks.iter().find(|t| t.id == id) else {
                    return (false, 0);
                };
                let size: u64 = {
                    let s = self.seen.lock().await;
                    own_trees(&self.engine, t)
                        .iter()
                        .filter_map(|w| s.sizes.get(&w.path))
                        .sum()
                };
                let mut gone = 0;
                for wt in own_trees(&self.engine, t) {
                    if !fsx::exists(&wt.path).await {
                        continue;
                    }
                    // re-check right before: a follow-up may have overtaken the cleanup
                    let busy = self.port.tasks().await.iter().any(|x| x.id == id && x.busy);
                    let still = move || !busy;
                    let opts = RemoveOpts {
                        force,
                        strict: !force,
                        ..RemoveOpts::default()
                    };
                    if self
                        .engine
                        .remove(&self.call, wt, opts, Some(&still))
                        .await
                        .is_ok_and(|r| r.removed)
                    {
                        gone += 1;
                        let mut s = self.seen.lock().await;
                        s.sizes.remove(&wt.path);
                        s.trees.remove(&wt.path);
                    }
                }
                (gone > 0, size)
            }
        }
    }

    /// Every repo tasks know, once each: what's gone from disk, git forgets (edge-case extra).
    pub async fn prune(&self) {
        let tasks = self.port.tasks().await;
        let roots: Vec<&str> = tasks
            .iter()
            .flat_map(|t| own_trees(&self.engine, t))
            .map(|w| w.root.as_str())
            .collect();
        for root in wisp_worktrees_core::prune_roots(roots) {
            if fsx::exists(&root).await
                && let Ok(repo) = self.engine.repo(&self.call, &root).await
            {
                let _ = repo.worktree_prune(&self.call).await;
            }
        }
    }

    /// The hourly look. Nothing while the machine is short (the next one catches up).
    pub async fn sweep(&self, limits: DiskLimits) -> SweepOut {
        if self.cleaning().is_some() {
            return SweepOut::default();
        }
        if self.port.machine_short() {
            return SweepOut {
                removed: 0,
                skipped: Some("busy".into()),
            };
        }
        self.scan().await;
        self.prune().await;
        let tasks = self.port.tasks().await;
        let snaps = self.snaps(&tasks).await;
        let (p, _) = self.policy().await;
        let disk = self.seen.lock().await.disk;
        let ids = sweep::plan_sweep(&snaps, &p, disk, limits, self.engine.clock.now_ms());
        if ids.is_empty() {
            return SweepOut::default();
        }
        let n = u32::try_from(ids.len()).unwrap_or(u32::MAX);
        self.queue
            .lock()
            .await
            .extend(ids.into_iter().map(|id| Job::Task(id, false)));
        self.work(true).await;
        SweepOut {
            removed: n,
            skipped: None,
        }
    }

    /// Is the count of task folders past the cap (a sweep comes a few minutes on)?
    pub async fn past_cap(&self) -> bool {
        let tasks = self.port.tasks().await;
        let (p, _) = self.policy().await;
        let mut count = 0;
        for t in &tasks {
            for w in own_trees(&self.engine, t) {
                count += usize::from(fsx::exists(&w.path).await);
            }
        }
        sweep::past_cap(count, &p)
    }
}
