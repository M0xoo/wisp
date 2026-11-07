//! The cleanup policy (v1 services/worktrees.js). Each task keeps its checkout; left alone they fill the
//! disk. The hourly sweep removes, of the idle ones: a clean task whose PR merged or closed at once; a
//! Done one after a day; the rest after `worktreeCleanup` days (counted from the upgrade for those who
//! never chose); past `worktreeMax` folders the oldest until it fits; under 10 GB free the oldest until
//! 15 GB. Only what can come back goes (the branch stays). In use, kept, parked, on an open PR, or
//! holding anything only its folder has: skipped. Leftovers are only ever removed by hand.
//! Pure: the host gathers `TaskSnap`s (from runtime) and the last look, then does what this decides.

use wisp_worktrees_api::{Disk, Standing};

pub const CLEANUP_DEFAULT: &str = "7";
pub const MAX_DEFAULT: &str = "40";
pub const DAY: i64 = 86_400_000;
pub const HOUR: i64 = 3_600_000;
const GB: u64 = 1024 * 1024 * 1024;
pub const SWEEP_MS: u64 = 3_600_000;
pub const FIRST_SWEEP_MS: u64 = 120_000;
/// a look this recent stands (each one runs git in every worktree)
pub const FRESH_MS: i64 = 60_000;
/// gits side by side
pub const LOOKS: usize = 6;
pub const LOW_DISK: u64 = 10 * GB;
/// a low-disk sweep stops here, so it doesn't run again next hour
pub const ENOUGH_DISK: u64 = 15 * GB;
/// the least idle a folder is for Clean up now or a low disk to take it
pub const MIN_IDLE: i64 = DAY;
pub const DONE_IDLE: i64 = DAY;
/// the cap never takes a folder used this recently
pub const CAP_IDLE: i64 = HOUR;
/// sizes this recent stand, unless a folder came or went
pub const DU_MS: i64 = 6 * HOUR;
/// a new folder past the cap: a sweep this long after
pub const CAP_DELAY_MS: u64 = 3 * 60_000;

/// One of a task's folders as the last look saw it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TreeSnap {
    pub path: String,
    pub branch: String,
    pub on_disk: bool,
    /// None: not looked at yet; Some(None): git couldn't tell; Some(Some(n)): what only it holds
    pub only: Option<Option<u32>>,
    pub touched: i64,
    pub size: Option<u64>,
}

/// A task (and its `also` runs) as the sweep needs it. `busy`: running, waiting, asking, shipping,
/// queued, or a shell/app/side discussion in it, for it or its lead.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskSnap {
    pub id: String,
    pub title: String,
    pub project: String,
    pub done: bool,
    pub busy: bool,
    pub kept: bool,
    pub parked: bool,
    pub pr_open: bool,
    /// a PR of it merged or closed
    pub pr_ended: bool,
    pub updated_at: i64,
    pub created_at: i64,
    pub trees: Vec<TreeSnap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// None: cleanup off
    pub idle_days: Option<i64>,
    /// the upgrade's time when the user never chose (so no folder goes the day it arrives), else 0
    pub clock_from: i64,
    /// None: no cap
    pub max: Option<usize>,
}

impl Policy {
    /// `cleanup`/`max` as Settings stores them (None: never chosen, the default).
    pub fn from_settings(cleanup: Option<&str>, max: Option<&str>, cleanup_from: i64) -> Self {
        let c = cleanup.unwrap_or(CLEANUP_DEFAULT);
        let m = max.unwrap_or(MAX_DEFAULT);
        Self {
            idle_days: if c == "off" { None } else { c.parse().ok() },
            clock_from: if cleanup.is_none() { cleanup_from } else { 0 },
            max: if m == "off" { None } else { m.parse().ok().filter(|n| *n > 0) },
        }
    }
}

impl TaskSnap {
    fn held(&self) -> impl Iterator<Item = &TreeSnap> {
        self.trees.iter().filter(|t| t.on_disk)
    }
    pub fn held_count(&self) -> usize {
        self.held().count()
    }
    pub fn used_at(&self) -> i64 {
        self.trees.iter().map(|t| t.touched).fold(self.updated_at.max(self.created_at), i64::max)
    }
    /// None while any folder's size is unknown
    pub fn size(&self) -> Option<u64> {
        self.held().map(|t| t.size).sum()
    }
    pub fn only(&self) -> u32 {
        self.trees.iter().filter_map(|t| t.only.flatten()).sum()
    }
}

pub fn standing(s: &TaskSnap) -> Standing {
    if s.busy {
        return Standing::Busy;
    }
    if s.kept {
        return Standing::Kept;
    }
    if s.parked {
        return Standing::Parked;
    }
    if s.pr_open {
        return Standing::Pr;
    }
    let looked: Vec<Option<u32>> = s.trees.iter().filter_map(|t| t.only).collect();
    if looked.is_empty() {
        Standing::Checking
    } else if looked.iter().any(Option::is_none) {
        Standing::Unreadable
    } else if looked.iter().any(|n| n.is_some_and(|n| n > 0)) {
        Standing::Dirty
    } else {
        Standing::Idle
    }
}

/// When an idle task's folder goes on its own: a merged or closed PR at once, Done after a day, the rest
/// after the days set. None: never (cleanup off).
pub fn clean_at(s: &TaskSnap, p: &Policy) -> Option<i64> {
    let days = p.idle_days?;
    if s.pr_ended {
        return Some(0);
    }
    let after = s.used_at().max(p.clock_from) + days * DAY;
    Some(if s.done { after.min(s.used_at() + DONE_IDLE) } else { after })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskLimits {
    pub low: u64,
    pub enough: u64,
}

impl Default for DiskLimits {
    fn default() -> Self {
        Self { low: LOW_DISK, enough: ENOUGH_DISK }
    }
}

fn n64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// The ids the sweep removes, oldest first. Only task folders count toward the cap (leftovers never do,
/// so they can't push idle task folders out in their place every sweep).
pub fn plan_sweep(tasks: &[TaskSnap], p: &Policy, disk: Option<Disk>, limits: DiskLimits, now: i64) -> Vec<String> {
    let mut idle: Vec<&TaskSnap> = tasks.iter().filter(|s| s.held_count() > 0 && standing(s) == Standing::Idle).collect();
    idle.sort_by_key(|s| s.used_at());
    let mut jobs: Vec<&TaskSnap> = if p.idle_days.is_none() { Vec::new() } else { idle.iter().copied().filter(|s| clean_at(s, p).is_some_and(|t| now >= t)).collect() };
    let has = |jobs: &[&TaskSnap], s: &TaskSnap| jobs.iter().any(|j| j.id == s.id);
    // a disk running out doesn't wait for the days: the oldest go until there's room again
    if let (Some(_), Some(d)) = (p.idle_days, disk.filter(|d| d.free < limits.low)) {
        let mut free = d.free + jobs.iter().map(|s| s.size().unwrap_or(0)).sum::<u64>();
        for s in &idle {
            if free >= limits.enough {
                break;
            }
            if has(&jobs, s) || now - s.used_at() < MIN_IDLE {
                continue;
            }
            jobs.push(s);
            free += s.size().unwrap_or(0);
        }
    }
    // over the cap: the oldest idle go until it fits; what isn't idle stays, even over it
    if let Some(max) = p.max {
        let count: usize = tasks.iter().map(TaskSnap::held_count).sum();
        let going: usize = jobs.iter().map(|s| s.held_count()).sum();
        let mut over = n64(count) - n64(going) - n64(max);
        for s in &idle {
            if over <= 0 {
                break;
            }
            if has(&jobs, s) || now - s.used_at() < CAP_IDLE {
                continue;
            }
            jobs.push(s);
            over -= n64(s.held_count());
        }
    }
    jobs.into_iter().map(|s| s.id.clone()).collect()
}

/// Is a new folder past the cap (a sweep comes `CAP_DELAY_MS` later)?
pub fn past_cap(count: usize, p: &Policy) -> bool {
    p.max.is_some_and(|m| count > m)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picked {
    /// (task id, force)
    pub jobs: Vec<(String, bool)>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickError {
    /// 400
    NotALeftover(String),
    /// 409: every named one is in use or holds work
    InUse,
}

/// Clean up by hand: `ids` (None: every idle one used over a day ago), `leftovers` by folder name, `force`
/// for one with uncommitted work. In use or not yet looked at is always skipped.
pub fn pick_clean(tasks: &[TaskSnap], ids: Option<&[String]>, leftovers: &[String], known_leftovers: &[String], force: bool, now: i64) -> Result<Picked, PickError> {
    let picked: Vec<&TaskSnap> = match ids {
        Some(ids) => ids.iter().filter_map(|id| tasks.iter().find(|s| &s.id == id)).collect(),
        None if leftovers.is_empty() => tasks.iter().filter(|s| s.held_count() > 0 && standing(s) == Standing::Idle && now - s.used_at() >= MIN_IDLE).collect(),
        None => Vec::new(),
    };
    let mut out = Picked { jobs: Vec::new(), skipped: Vec::new() };
    for s in picked {
        match standing(s) {
            Standing::Busy | Standing::Checking => out.skipped.push(s.id.clone()),
            Standing::Dirty | Standing::Unreadable if !force => out.skipped.push(s.id.clone()),
            _ => out.jobs.push((s.id.clone(), force)),
        }
    }
    for name in leftovers {
        if !valid_leftover(name) || !known_leftovers.contains(name) {
            return Err(PickError::NotALeftover(name.clone()));
        }
    }
    if ids.is_some() && out.jobs.is_empty() && leftovers.is_empty() && !out.skipped.is_empty() {
        return Err(PickError::InUse);
    }
    Ok(out)
}

/// A folder name straight in worktrees/: no path, no `..`.
pub fn valid_leftover(name: &str) -> bool {
    !name.is_empty() && name != ".." && name != "." && !name.contains(['/', '\\'])
}

/// `du -k -d 1 <dir>` → (child path, bytes), the folder itself left out. Some of it unreadable: du still
/// prints the rest (and fails), so this never needs its exit code.
pub fn parse_du(out: &str, dir: &str) -> Vec<(String, u64)> {
    out.lines()
        .filter_map(|l| {
            let (k, p) = l.split_once('\t')?;
            let kb: u64 = k.trim().parse().ok()?;
            (p.trim_end_matches('/') != dir.trim_end_matches('/')).then(|| (p.to_owned(), kb * 1024))
        })
        .collect()
}

/// `df -Pk <dir>` (POSIX columns: filesystem, 1024-blocks, used, available, …) → free and total bytes.
pub fn parse_df(out: &str) -> Option<Disk> {
    let line = out.lines().nth(1)?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    let total: u64 = cols.get(1)?.parse().ok()?;
    let free: u64 = cols.get(3)?.parse().ok()?;
    Some(Disk { free: free * 1024, total: total * 1024 })
}

/// Does a folder need git status again? Only when it moved: its own mtime, or its task ran since.
pub fn needs_look(was: Option<(Option<u32>, i64, i64)>, touched: i64, used: i64) -> bool {
    !matches!(was, Some((Some(_), t, u)) if t == touched && u == used)
}

/// Should this look run du? When a folder came or went, or the sizes are older than `DU_MS`; a busy
/// machine skips it once sizes exist.
pub fn du_due(changed: bool, sized_at: i64, now: i64, short: bool) -> bool {
    let due = changed || sized_at == 0 || now - sized_at >= DU_MS;
    due && !(short && sized_at != 0)
}

#[cfg(test)]
#[path = "sweep_tests.rs"]
mod tests;
