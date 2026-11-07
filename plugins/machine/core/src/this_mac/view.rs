//! What the page shows (v1 Machine.view, #rows, #settleRes, reclaim, fileFix's prompt), from the
//! placed snapshot, the guard and the tables the host looked up.

use std::collections::{BTreeMap, HashMap};

use serde_json::Map;
use wisp_machine_api::this_mac::{
    BatteryState, CpuInfo, CrewUse, DiskInfo, Facts, Guard, HistoryPoint, Hold, Leftover, LeftoverGroup, LoadReading, MachineView, MemInfo, MemoryPer, ReclaimGroup, Res, TaskUse, WispUse,
};

use super::attribute::Placed;
use super::parse::Battery;
use super::{RES_CPU, RES_MOVE, RES_RSS, round, round1};

/// A task, as This Mac needs it: from `runtime.get` and the `machine.facts@1` contributors.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    /// `running`, `review`, `done`, `error`
    pub state: String,
    pub cwd: String,
    pub facts: Facts,
}

/// Settings → Worktrees' last look, as much of it as This Mac reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WtView {
    pub items: Vec<WtItem>,
    pub leftovers: Vec<WtLeftover>,
    pub size: Option<u64>,
    /// (free, total)
    pub disk: Option<(u64, u64)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WtItem {
    pub id: String,
    /// nothing keeps it (Settings → Worktrees' `idle`)
    pub idle: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WtLeftover {
    pub name: String,
    pub size: Option<u64>,
    /// files of its own nobody else has; `None`: unread
    pub only: Option<u32>,
}

/// One running task's tree, summed.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    pub rss: u64,
    pub cpu: f64,
    pub procs: u32,
}

/// Per running task: `{rss, cpu, procs}` over its tree.
pub fn rows(placed: &Placed) -> BTreeMap<String, Usage> {
    placed
        .trees
        .iter()
        .map(|(id, set)| {
            let ps: Vec<_> = set.iter().filter_map(|pid| placed.get(*pid)).collect();
            let u = Usage { rss: ps.iter().map(|p| p.rss).sum(), cpu: round1(ps.iter().map(|p| p.cpu).sum()), procs: u32::try_from(ps.len()).unwrap_or(u32::MAX) };
            (id.clone(), u)
        })
        .collect()
}

fn moved(a: f64, b: f64) -> bool {
    (a - b).abs() > a.max(1.0) * RES_MOVE
}

/// A heavy run's summary carries `res`; it changes only when it moved 20% (or went light, or ended).
/// Returns the tasks whose summary to send again.
#[allow(clippy::cast_precision_loss)] // bytes compared as a share
pub fn settle_res(rows: &BTreeMap<String, Usage>, res: &mut HashMap<String, Res>) -> Vec<String> {
    let mut changed = Vec::new();
    for (id, r) in rows {
        let heavy = r.rss > RES_RSS || r.cpu > RES_CPU;
        match res.get(id) {
            Some(prev) if heavy && !moved(prev.rss as f64, r.rss as f64) && !moved(prev.cpu, r.cpu) => continue,
            _ if heavy => {
                res.insert(id.clone(), Res { rss: r.rss, cpu: r.cpu });
            }
            Some(_) => {
                res.remove(id);
            }
            None => continue,
        }
        changed.push(id.clone());
    }
    let gone: Vec<String> = res.keys().filter(|id| !rows.contains_key(*id)).cloned().collect();
    for id in gone {
        res.remove(&id);
        changed.push(id);
    }
    changed
}

/// Groups of folders Clean up can take, each a list for `POST /worktrees/clean`: merged or closed PRs,
/// Done tasks, finished crew jobs, and leftover folders that hold nothing of their own. Only idle ones.
pub fn reclaim(wt: Option<&WtView>, task: &dyn Fn(&str) -> Option<TaskInfo>) -> Vec<ReclaimGroup> {
    let mut groups: [(&str, Vec<String>, u64); 4] = [("merged", vec![], 0), ("done", vec![], 0), ("crew", vec![], 0), ("leftover", vec![], 0)];
    let Some(wt) = wt else { return Vec::new() };
    for it in wt.items.iter().filter(|it| it.idle) {
        let Some(s) = task(&it.id) else { continue };
        let i = if s.facts.pr_closed {
            0
        } else if s.facts.crew.is_some() && matches!(s.state.as_str(), "done" | "review") {
            2
        } else if s.state == "done" {
            1
        } else {
            continue;
        };
        groups[i].1.push(it.id.clone());
        groups[i].2 += it.size.unwrap_or(0);
    }
    // a leftover that holds work of its own, or wasn't read, is for Settings → Worktrees, by hand
    for l in wt.leftovers.iter().filter(|l| l.only == Some(0)) {
        groups[3].1.push(l.name.clone());
        groups[3].2 += l.size.unwrap_or(0);
    }
    groups
        .into_iter()
        .filter(|g| !g.1.is_empty())
        .map(|(kind, ids, bytes)| ReclaimGroup { kind: kind.to_owned(), count: u32::try_from(ids.len()).unwrap_or(u32::MAX), bytes, ids, extra: Map::new() })
        .collect()
}

/// What File a fix asks for, word for word v1's.
pub fn fix_prompt(g: &LeftoverGroup, task: Option<&TaskInfo>, project: Option<&str>, leftovers: &[Leftover], now: i64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    #[allow(clippy::cast_precision_loss)]
    let mins = |since: i64| format!("{} min", round((now - since) as f64 / 60_000.0, 0).unwrap_or(0.0).max(1.0));
    #[allow(clippy::cast_precision_loss)]
    let mb = |b: u64| format!("{} MB", round(b as f64 / MB, 0).unwrap_or(0.0));
    let n = g.count;
    let mut out = vec![
        format!("A run left {n} process{} running after it ended: wisp found {} on this computer, and the user asked for a fix.", if n == 1 { "" } else { "es" }, if n == 1 { "it" } else { "them" }),
        String::new(),
        match task {
            Some(s) => {
                let title = if s.title.is_empty() { &s.id } else { &s.title };
                format!("From the task \"{title}\" ({}){}.", s.id, project.map(|p| format!(", in {p}")).unwrap_or_default())
            }
            None => "No task is known for them: their folder is under wisp’s worktrees.".to_owned(),
        },
        format!("Started by: {}", g.command),
        "Still running:".to_owned(),
    ];
    let rows = g.pids.iter().filter_map(|pid| leftovers.iter().find(|l| l.pid == *pid)).take(20);
    out.extend(rows.map(|l| format!("- pid {}, {}, up {}: {}", l.pid, mb(l.rss), mins(l.since), l.command)));
    out.push(String::new());
    out.push("Find what starts these (a test helper, a QA script, a dev server a script forgets) and make it kill what it spawns, even when the run is stopped or fails: spawn in a process group of its own (detached) and kill the group on exit, SIGINT and SIGTERM, and in the tests' after() hooks. Don't stop these processes yourself: the user does that from This Mac. Say which file and what you changed.".to_owned());
    out.join("\n")
}

/// Where a fix for `task`'s leftovers is filed: its project, else its folder.
pub fn project_of(task: Option<&TaskInfo>) -> Option<String> {
    let s = task?;
    s.facts.project.clone().filter(|p| !p.is_empty()).or_else(|| (!s.cwd.is_empty()).then(|| s.cwd.clone()))
}

/// Everything `GET /machine` is made of.
#[derive(Debug, Clone)]
pub struct ViewInput<'a> {
    pub now: i64,
    pub mem_total: u64,
    pub cores: u32,
    pub memory: MemoryPer,
    pub reading: &'a LoadReading,
    /// the guard's hold, the user's and the power's included
    pub hold: Option<&'a Hold>,
    pub paused_until: i64,
    pub battery: Option<Battery>,
    pub battery_hold: Option<u32>,
    pub rows: &'a BTreeMap<String, Usage>,
    pub tasks: &'a HashMap<String, TaskInfo>,
    pub worktrees: Option<&'a WtView>,
    /// the harnesses' own reclaim group
    pub harness: Option<ReclaimGroup>,
    pub wisp: WispUse,
    pub leftovers: Vec<Leftover>,
    pub groups: Vec<LeftoverGroup>,
    pub history: Vec<HistoryPoint>,
}

fn tasks_and_crew(v: &ViewInput<'_>) -> (Vec<TaskUse>, Vec<CrewUse>) {
    let sizes: HashMap<&str, Option<u64>> = v.worktrees.map(|w| w.items.iter().map(|x| (x.id.as_str(), x.size)).collect()).unwrap_or_default();
    let mut tasks: Vec<TaskUse> = v
        .rows
        .iter()
        .map(|(id, x)| {
            let s = v.tasks.get(id);
            TaskUse { id: id.clone(), title: s.map(|s| s.title.clone()).unwrap_or_default(), crew: s.and_then(|s| s.facts.crew.clone()), rss: x.rss, cpu: x.cpu, procs: x.procs, worktree_bytes: sizes.get(id.as_str()).copied().flatten() }
        })
        .collect();
    tasks.sort_by(|a, b| b.rss.cmp(&a.rss));
    let mut crew: Vec<CrewUse> = Vec::new();
    for t in &tasks {
        let Some(c) = &t.crew else { continue };
        let i = crew.iter().position(|x| &x.id == c).unwrap_or_else(|| {
            let name = v.tasks.get(&t.id).and_then(|s| s.facts.crew_name.clone()).unwrap_or_default();
            crew.push(CrewUse { id: c.clone(), name, rss: 0, cpu: 0.0, jobs: 0 });
            crew.len() - 1
        });
        if let Some(x) = crew.get_mut(i) {
            x.rss += t.rss;
            x.cpu = round1(x.cpu + t.cpu);
            x.jobs += 1;
        }
    }
    crew.sort_by(|a, b| b.rss.cmp(&a.rss));
    (tasks, crew)
}

/// `GET /machine`, from `v` and the reclaim groups (worktrees' then the harnesses').
pub fn build(v: ViewInput<'_>, mut reclaim: Vec<ReclaimGroup>) -> MachineView {
    let (tasks, crew) = tasks_and_crew(&v);
    if let Some(h) = v.harness.clone() {
        reclaim.push(h);
    }
    let r = v.reading;
    let wt = v.worktrees;
    MachineView {
        at: v.now,
        mem: MemInfo { total: v.mem_total, free_pct: r.mem_free_pct.and_then(|n| round(n, 1)), pressure: r.pressure, per: v.memory },
        cpu: CpuInfo { pct: r.cpu.and_then(|n| round(n, 1)), cores: v.cores },
        disk: DiskInfo { free: wt.and_then(|w| w.disk).map(|d| d.0), total: wt.and_then(|w| w.disk).map(|d| d.1), worktrees: wt.and_then(|w| w.size), reclaimable: reclaim.iter().map(|g| g.bytes).sum() },
        wisp: v.wisp,
        guard: Guard {
            held: v.hold.map(|h| h.kind),
            why: v.hold.map(|h| h.why.clone()),
            floor: r.limits.floor,
            ceiling: r.limits.ceiling,
            max_runs: r.limits.max_runs,
            runs: r.runs,
            paused_until: v.paused_until,
            battery: v.battery.map(|b| BatteryState { pct: b.pct, charging: b.charging, hold: v.battery_hold }),
        },
        tasks,
        crew,
        leftovers: v.leftovers,
        leftover_groups: v.groups,
        history: v.history,
        reclaim,
    }
}
