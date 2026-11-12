//! This Mac's process view (v1 Machine.snapshot, routes/machine.js): every tick that something runs, a run
//! ended in the last 3 minutes, or the page was read in the last 30 s (and once a minute otherwise), one
//! `ps` (macOS with `-E`, so each process's `WISP_TASK` tag shows; Linux reads `/proc/<pid>/environ` once
//! per process), attributed by `wisp_machine_core::this_mac::attribute`, summed per task, with the
//! leftovers, Clean up's groups and a day of 1-minute points. Two rows carry it, so clients watch instead of
//! polling: `machine.snapshot` (the whole reading, topic `plugin:wisp.machine:snapshot`) and
//! `machine.load` (the chip's cheap one, `plugin:wisp.machine:load`), both id `this`.
//!
//! The runs: `machine.runs@1` contributors, else each running task's harness CLI is the process wisp
//! started whose tag names it.
//!
//! size-ok: one sampling pass and the three commands that act on it

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_machine_api::this_mac::commands::{self as c, Cleaned, FixFiled, Stopped};
use wisp_machine_api::this_mac::{FACTS, FIXER, Facts, HARNESS_DISK, HistoryPoint, LeftoverGroup, LiveRun, LoadReading, MachineView, MemoryPer, RUNS, WispUse};
use wisp_machine_core::this_mac::attribute::{Attributor, Placed};
use wisp_machine_core::this_mac::history::History;
use wisp_machine_core::this_mac::load::Load;
use wisp_machine_core::this_mac::view::{self, TaskInfo, ViewInput, WtItem, WtLeftover, WtView};
use wisp_machine_core::this_mac::{AFTER_MS, KILL_MS, POINT_MS, Platform, READ_MS, Refusal, RefusalKind, holds, parse};
use wisp_store::{Col, EntityDef, Migration, Row, Store};

use crate::this_mac::{Guard, lock, run};

pub const OWNER: &str = "machine";
pub const SNAPSHOT_TOPIC: &str = "plugin:wisp.machine:snapshot";
pub const LOAD_TOPIC: &str = "plugin:wisp.machine:load";
/// Sampling when nothing runs and nobody reads the page: once a minute (the history's pace).
const IDLE_MS: i64 = 60_000;

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE machine_snapshot (id TEXT PRIMARY KEY, at INTEGER NOT NULL, platform TEXT NOT NULL, mem TEXT, cpu TEXT, disk TEXT, wisp TEXT,
       guard TEXT, tasks TEXT, crew TEXT, leftovers TEXT, leftover_groups TEXT, history TEXT, reclaim TEXT, cleanup TEXT) STRICT;
     CREATE TABLE machine_load (id TEXT PRIMARY KEY, at INTEGER NOT NULL, platform TEXT NOT NULL, mem_free_pct REAL, runs INTEGER NOT NULL,
       held TEXT, limits TEXT, paused_until INTEGER NOT NULL, left_behind INTEGER NOT NULL) STRICT;",
),
// v1's Now line reads the CPU too ("CPU at 50% of its cores"): the guard's reading, as a share of all cores
Migration::sql(2, "ALTER TABLE machine_load ADD COLUMN cpu REAL;")];

fn snapshot_topics(_: &Row) -> Vec<String> {
    vec![SNAPSHOT_TOPIC.into()]
}
fn load_topics(_: &Row) -> Vec<String> {
    vec![LOAD_TOPIC.into()]
}

pub const SNAPSHOT: EntityDef = EntityDef {
    kind: "machine.snapshot",
    table: "machine_snapshot",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("at", Col::Int),
        ("platform", Col::Text),
        ("mem", Col::Text),
        ("cpu", Col::Text),
        ("disk", Col::Text),
        ("wisp", Col::Text),
        ("guard", Col::Text),
        ("tasks", Col::Text),
        ("crew", Col::Text),
        ("leftovers", Col::Text),
        ("leftover_groups", Col::Text),
        ("history", Col::Text),
        ("reclaim", Col::Text),
        ("cleanup", Col::Text),
    ],
    json_columns: &["mem", "cpu", "disk", "wisp", "guard", "tasks", "crew", "leftovers", "leftover_groups", "history", "reclaim"],
    parent: None,
    seq: None,
    topics: snapshot_topics,
};

pub const LOAD: EntityDef = EntityDef {
    kind: "machine.load",
    table: "machine_load",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("at", Col::Int),
        ("platform", Col::Text),
        ("mem_free_pct", Col::Real),
        ("cpu", Col::Real),
        ("runs", Col::Int),
        ("held", Col::Text),
        ("limits", Col::Text),
        ("paused_until", Col::Int),
        ("left_behind", Col::Int),
    ],
    json_columns: &["held", "limits"],
    parent: None,
    seq: None,
    topics: load_topics,
};

pub fn install(store: &Store) -> wisp_store::Result<()> {
    store.migrate(OWNER, MIGRATIONS)?;
    store.define_entity(SNAPSHOT)?;
    store.define_entity(LOAD)?;
    Ok(())
}

/// `darwin`, `linux`, `win32`: the page names itself from it (This Mac, This computer, This PC).
pub fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

/// The two rows, from a view and the guard's reading. `cleanup`: Settings → Worktrees' idle days, or `off`.
pub fn rows(v: &MachineView, reading: &LoadReading, paused_until: i64, cleanup: Option<&str>, platform: &str) -> (Row, Row) {
    let Value::Object(f) = serde_json::to_value(v).unwrap_or(Value::Null) else { return (Row::new(), Row::new()) };
    let mut snap = Row::new();
    snap.insert("id".into(), json!("this"));
    snap.insert("platform".into(), json!(platform));
    for (col, key) in [("at", "at"), ("mem", "mem"), ("cpu", "cpu"), ("disk", "disk"), ("wisp", "wisp"), ("guard", "guard"), ("tasks", "tasks"), ("crew", "crew"), ("leftovers", "leftovers"), ("leftover_groups", "leftoverGroups"), ("history", "history"), ("reclaim", "reclaim")] {
        snap.insert(col.into(), f.get(key).cloned().unwrap_or(Value::Null));
    }
    snap.insert("cleanup".into(), cleanup.map_or(Value::Null, |c| json!(c)));
    let mut load = Row::new();
    load.insert("id".into(), json!("this"));
    load.insert("at".into(), json!(reading.at));
    load.insert("platform".into(), json!(platform));
    load.insert("mem_free_pct".into(), reading.mem_free_pct.map_or(Value::Null, |n| json!(n)));
    load.insert("cpu".into(), reading.cpu.map_or(Value::Null, |n| json!(n)));
    load.insert("runs".into(), json!(reading.runs));
    load.insert("held".into(), serde_json::to_value(&reading.held).unwrap_or(Value::Null));
    load.insert("limits".into(), serde_json::to_value(reading.limits).unwrap_or(Value::Null));
    load.insert("paused_until".into(), json!(paused_until));
    load.insert("left_behind".into(), json!(v.leftovers.len()));
    (snap, load)
}

/// The last view, the pids Stop may take, and what started wisp.
type Last = (MachineView, HashSet<u32>, HashSet<u32>);

/// What sampling keeps between ticks.
pub struct Procs {
    attr: Mutex<Attributor>,
    history: Mutex<History>,
    /// the last view, and the pids Stop may take (leftovers and the runs' trees)
    last: Mutex<Option<Last>>,
    read_at: Mutex<i64>,
    sampled_at: Mutex<i64>,
    point_at: Mutex<i64>,
    ran_at: Mutex<i64>,
}

impl std::fmt::Debug for Procs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Procs").finish_non_exhaustive()
    }
}

fn this_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Mac
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

fn refusal(r: Refusal) -> WireError {
    match r.kind {
        RefusalKind::Invalid => WireError::invalid(r.message),
        RefusalKind::Forbidden => WireError::forbidden(r.message),
        RefusalKind::NotFound => WireError::not_found(r.message),
        RefusalKind::Conflict => WireError::conflict(r.message),
    }
}

/// A list row's task, as This Mac reads it.
fn task_of(row: &Value) -> Option<TaskInfo> {
    let s = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let id = s("id");
    (!id.is_empty()).then(|| TaskInfo { id, title: s("title"), state: s("state"), cwd: s("cwd"), facts: Facts::default() })
}

/// Settings → Worktrees' answer, as much as This Mac reads.
fn wt_of(v: &Value) -> Option<WtView> {
    let items = v.get("items")?.as_array()?;
    let leftovers = v.get("leftovers").and_then(Value::as_array).cloned().unwrap_or_default();
    let n = |x: &Value, k: &str| x.get(k).and_then(Value::as_u64);
    Some(WtView {
        items: items.iter().map(|x| WtItem { id: x.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(), idle: x.get("status").and_then(Value::as_str) == Some("idle"), size: n(x, "size") }).collect(),
        leftovers: leftovers
            .iter()
            .map(|x| WtLeftover { name: x.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(), size: n(x, "size"), only: n(x, "only").and_then(|o| u32::try_from(o).ok()) })
            .collect(),
        size: n(v, "size"),
        disk: v.get("disk").and_then(|d| Some((n(d, "free")?, n(d, "total")?))),
    })
}

/// The runs going now: the contributors' (runtime), else for each running task the process wisp itself
/// started whose `WISP_TASK` names it (the harness CLI the runner spawned).
pub fn live_runs(contributed: Vec<LiveRun>, procs: &[parse::Proc], me: u32, running: &HashSet<String>) -> Vec<LiveRun> {
    if !contributed.is_empty() {
        return contributed;
    }
    let mut out: Vec<LiveRun> = Vec::new();
    for p in procs.iter().filter(|p| p.ppid == me) {
        if let Some(t) = p.task.as_ref().filter(|t| running.contains(*t))
            && !out.iter().any(|r| &r.task == t)
        {
            out.push(LiveRun { task: t.clone(), pid: p.pid });
        }
    }
    out
}

impl Procs {
    fn new(home: &str) -> Self {
        Self {
            attr: Mutex::new(Attributor::new(this_platform(), std::process::id(), home)),
            history: Mutex::new(History::default()),
            last: Mutex::new(None),
            read_at: Mutex::new(0),
            sampled_at: Mutex::new(0),
            point_at: Mutex::new(0),
            ran_at: Mutex::new(0),
        }
    }

    /// Samples when it's due (see the module's doc), then writes the rows.
    pub async fn tick(&self, ctx: &Ctx, g: &Guard, proc: &wisp_proc::Proc, now: i64) {
        let runs = g.with(Load::reading).runs;
        if runs > 0 {
            *lock(&self.ran_at) = now;
        }
        let busy = runs > 0 || now - *lock(&self.ran_at) < AFTER_MS || now - *lock(&self.read_at) < READ_MS;
        if !busy && now - *lock(&self.sampled_at) < IDLE_MS {
            return;
        }
        *lock(&self.sampled_at) = now;
        let v = self.sample(ctx, g, proc, now).await;
        self.publish(ctx, g, &v, now).await;
    }

    async fn ps(proc: &wisp_proc::Proc, platform: Platform, now: i64) -> Vec<parse::Proc> {
        match platform {
            Platform::Mac => run(proc, "ps", &["-E", "-axww", "-o", "pid=,ppid=,rss=,%cpu=,etime=,command="]).await.map(|t| parse::parse_ps(&t, now, true)).unwrap_or_default(),
            Platform::Linux => run(proc, "ps", &["-axww", "-o", "pid=,ppid=,rss=,%cpu=,etime=,command="]).await.map(|t| parse::parse_ps(&t, now, false)).unwrap_or_default(),
            // Win32_Process through PowerShell is v1's; not sampled here yet (the page shows the guard only)
            Platform::Windows => Vec::new(),
        }
    }

    #[allow(clippy::too_many_lines)] // one pass: ps, attribution, the tables, the view
    async fn sample(&self, ctx: &Ctx, g: &Guard, proc: &wisp_proc::Proc, now: i64) -> MachineView {
        let call = ctx.root_call();
        let platform = this_platform();
        let me = std::process::id();
        let mut procs = Self::ps(proc, platform, now).await;
        // Linux: each new process's environ, once
        let wanted = lock(&self.attr).environ_wanted(&procs);
        for pid in wanted.into_iter().take(256) {
            let text = tokio::fs::read(format!("/proc/{pid}/environ")).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            if let Some(p) = procs.iter().find(|p| p.pid == pid) {
                let since = p.since;
                lock(&self.attr).set_environ(pid, since, parse::tag_in_environ(&text));
            }
        }
        let list = ctx.run_json(&call, "runtime.list", json!({ "archived": false })).await.unwrap_or_default();
        let mut tasks: HashMap<String, TaskInfo> = list.as_array().into_iter().flatten().filter_map(task_of).map(|t| (t.id.clone(), t)).collect();
        let running: HashSet<String> = tasks.values().filter(|t| t.state == "running").map(|t| t.id.clone()).collect();
        let contributed: Vec<LiveRun> = ctx.contributions(&RUNS).iter().flat_map(|r| r.live()).collect();
        if platform == Platform::Mac {
            let pids: Vec<u32> = procs.iter().map(|p| p.pid).collect();
            let got = tokio::task::spawn_blocking(move || wisp_proc::footprints(&pids)).await.unwrap_or_default();
            for p in &mut procs {
                if let Some(b) = got.get(&p.pid) {
                    p.rss = *b;
                }
            }
        }
        let runs = live_runs(contributed, &procs, me, &running);
        let known = |t: &str| tasks.contains_key(t);
        let (placed, leftovers, groups): (Placed, _, _) = {
            let mut a = lock(&self.attr);
            let placed = a.place(procs, &runs, &known);
            let (l, gr) = a.leftovers(&placed, &known, now);
            (placed, l, gr)
        };
        let usage = view::rows(&placed);
        let wisp = placed.get(me).map_or(WispUse { rss: 0, cpu: None }, |p| WispUse { rss: p.rss, cpu: Some(p.cpu) });
        let wt = ctx.run_json(&call, "worktrees.view", json!({})).await.ok().as_ref().and_then(wt_of);
        // the facts other plugins add, for the tasks the page names
        let named: HashSet<String> = usage.keys().cloned().chain(leftovers.iter().filter_map(|l| l.task.clone())).chain(wt.iter().flat_map(|w| w.items.iter().map(|i| i.id.clone()))).collect();
        let facts = ctx.contributions(&FACTS);
        if !facts.is_empty() {
            let ids: Vec<String> = named.into_iter().filter(|id| tasks.contains_key(id)).collect();
            for id in &ids {
                let Ok(full) = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await else { continue };
                let Ok(session) = serde_json::from_value::<wisp_runtime_api::Session>(full) else { continue };
                if let Some(t) = tasks.get_mut(id) {
                    for f in &facts {
                        f.facts(&session, &mut t.facts);
                    }
                }
            }
        }
        let reclaim = view::reclaim(wt.as_ref(), &|id| tasks.get(id).cloned());
        let harness = ctx.contributions(&HARNESS_DISK).iter().find_map(|h| h.view());
        let reading = g.with(Load::reading);
        let hold = g.with(Load::hold);
        let knobs = lock(&g.knobs).clone();
        let paused_until = holds::paused_until(&knobs, now);
        let battery = *lock(&g.battery);
        let history = {
            let mut h = lock(&self.history);
            let mut at = lock(&self.point_at);
            if now - *at >= POINT_MS {
                *at = now;
                h.push(HistoryPoint { at: now, free_pct: reading.mem_free_pct, cpu: reading.cpu, runs: reading.runs, held: hold.is_some(), worktree_bytes: wt.as_ref().and_then(|w| w.size) });
            }
            h.points()
        };
        let stoppable: HashSet<u32> = placed.trees.values().flatten().copied().chain(leftovers.iter().map(|l| l.pid)).collect();
        let v = view::build(
            ViewInput {
                now,
                mem_total: *lock(&g.total),
                cores: u32::try_from(std::thread::available_parallelism().map_or(1, std::num::NonZero::get)).unwrap_or(1),
                memory: if platform == Platform::Mac { MemoryPer::Footprint } else { MemoryPer::Rss },
                reading: &reading,
                hold: hold.as_ref(),
                paused_until,
                battery,
                battery_hold: knobs.battery_hold.as_deref().and_then(|b| b.parse().ok()),
                rows: &usage,
                tasks: &tasks,
                worktrees: wt.as_ref(),
                harness,
                wisp,
                leftovers,
                groups,
                history,
            },
            reclaim,
        );
        *lock(&self.last) = Some((v.clone(), stoppable, placed.ancestors));
        v
    }

    async fn publish(&self, ctx: &Ctx, g: &Guard, v: &MachineView, now: i64) {
        let Ok(store) = ctx.service::<Store>() else { return };
        let reading = g.with(Load::reading);
        let paused = holds::paused_until(&lock(&g.knobs), now);
        let cleanup = ctx.setting("worktrees.cleanup").and_then(|v| v.as_str().map(str::to_owned));
        let (snap, load) = rows(v, &reading, paused, cleanup.as_deref(), platform_name());
        if let Err(e) = store.write(move |w| w.upsert(SNAPSHOT.kind, snap).and_then(|_| w.upsert(LOAD.kind, load)).map(|_| ())).await {
            tracing::warn!(error = %e, "machine: writing the snapshot");
        }
    }

    fn group(&self, id: &str) -> Option<(LeftoverGroup, MachineView)> {
        let last = lock(&self.last);
        let (v, _, _) = last.as_ref()?;
        v.leftover_groups.iter().find(|g| g.id == id).cloned().map(|g| (g, v.clone()))
    }
}

/// Stop: SIGTERM, then SIGKILL `KILL_MS` on if it's still there. Only a leftover or a process in a running
/// task's tree, as the last sample placed it; never wisp or what started it.
fn stop(p: &Procs, pid: &Value) -> Result<Stopped> {
    let pid = holds::check_pid(pid).map_err(refusal)?;
    let (mine, ancestor, since) = {
        let last = lock(&p.last);
        last.as_ref().map_or((false, false, None), |(v, ok, anc)| {
            let n = u32::try_from(pid).unwrap_or(0);
            (ok.contains(&n), anc.contains(&n), v.leftovers.iter().find(|l| l.pid == n).map(|l| l.since))
        })
    };
    let pid = holds::check_stop(pid, std::process::id(), ancestor, mine).map_err(refusal)?;
    match wisp_proc::signal_pid(pid, wisp_proc::Signal::Term) {
        Ok(()) => {}
        Err(wisp_proc::ProcError::Exited) => return Ok(Stopped { stopped: 0, since }),
        Err(e) => return Err(WireError::internal(e.to_string())),
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(u64::try_from(KILL_MS).unwrap_or(5_000))).await;
        if wisp_proc::pid_alive(pid) {
            let _ = wisp_proc::signal_pid(pid, wisp_proc::Signal::Kill);
        }
    });
    if let Some(l) = lock(&p.last).as_mut() {
        l.0.leftovers.retain(|x| x.pid != pid);
    }
    Ok(Stopped { stopped: 1, since })
}

/// File a fix: the crew's fixer takes it (`machine.fixer@1`), else a task in the project the processes
/// came from, with v1's prompt.
async fn fix(p: &Procs, ctx: &Ctx, call: &Call, group: &Value, now: i64) -> Result<FixFiled> {
    let id = group.as_str().unwrap_or_default();
    let Some((g, v)) = p.group(id) else {
        return Err(WireError::not_found("That group of processes is gone: look again."));
    };
    let task = match g.task.as_deref() {
        Some(t) => ctx.run_json(call, "runtime.get", json!({ "id": t })).await.ok().as_ref().and_then(task_of),
        None => None,
    };
    let project = view::project_of(task.as_ref());
    let prompt = view::fix_prompt(&g, task.as_ref(), project.as_deref(), &v.leftovers, now);
    for f in ctx.contributions(&FIXER) {
        if let Some(filed) = f.file(call, prompt.clone()).await? {
            return Ok(filed);
        }
    }
    let mut args = json!({ "prompt": prompt, "title": format!("Fix: {} left running", g.command) });
    if let Some(cwd) = project {
        args["cwd"] = json!(cwd);
    }
    let made = ctx.run_json(call, "runtime.create", args).await?;
    Ok(FixFiled { session: made.get("id").and_then(Value::as_str).map(str::to_owned), ..FixFiled::default() })
}

pub(crate) fn setup(s: &mut Setup, g: &Arc<Guard>) -> Arc<Procs> {
    let home = std::env::var("WISP_HOME").ok().or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.wisp"))).unwrap_or_default();
    let p = Arc::new(Procs::new(&home));
    let (rp, rg) = (p.clone(), g.clone());
    s.command::<c::Read, _, _>(move |ctx, _call, _| {
        let (p, g) = (rp.clone(), rg.clone());
        async move {
            let now = ctx.clock()?.now_ms();
            *lock(&p.read_at) = now;
            let proc = ctx.service::<wisp_proc::Proc>()?;
            let v = p.sample(&ctx, &g, &proc, now).await;
            p.publish(&ctx, &g, &v, now).await;
            Ok(v)
        }
    });
    let sp = p.clone();
    s.command::<c::Stop, _, _>(move |_ctx, _call, a| {
        let p = sp.clone();
        async move { stop(&p, &a.pid) }
    });
    let fp = p.clone();
    s.command::<c::Fix, _, _>(move |ctx, call, a| {
        let p = fp.clone();
        async move {
            let now = ctx.clock()?.now_ms();
            fix(&p, &ctx, &call, &a.group, now).await
        }
    });
    let hp = p.clone();
    s.command::<c::HarnessClean, _, _>(move |ctx, _call, a| {
        let p = hp.clone();
        async move {
            let commands: Vec<String> = lock(&p.last).as_ref().map(|(v, _, _)| v.leftovers.iter().map(|l| l.command.clone()).collect()).unwrap_or_default();
            let Some(h) = ctx.contributions(&HARNESS_DISK).into_iter().next() else { return Ok(Cleaned::default()) };
            h.clean(a.ids, commands).await
        }
    });
    p
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use wisp_machine_api::this_mac::{Leftover, Limits};
    use wisp_store::{Location, SystemClock};

    fn proc(pid: u32, ppid: u32, task: Option<&str>) -> parse::Proc {
        parse::Proc { pid, ppid, rss: 1, cpu: 0.0, since: 0, command: "claude".into(), task: task.map(str::to_owned), time: 0 }
    }

    /// Without a runtime contribution, a running task's run is the process wisp started whose tag names it;
    /// a tagged child of something else, or a task that isn't running, is no run.
    #[test]
    fn a_running_tasks_run_is_the_tagged_process_wisp_started() {
        let me = 100;
        let procs = vec![proc(200, me, Some("t1")), proc(201, 200, Some("t1")), proc(300, me, Some("t2")), proc(400, 1, Some("t1"))];
        let running: HashSet<String> = ["t1".to_owned()].into();
        let runs = live_runs(Vec::new(), &procs, me, &running);
        assert_eq!(runs, vec![LiveRun { task: "t1".into(), pid: 200 }]);
        let given = vec![LiveRun { task: "t9".into(), pid: 9 }];
        assert_eq!(live_runs(given.clone(), &procs, me, &running), given, "runtime's own answer wins");
    }

    /// The page and the chip read two flat rows, id `this`, on the topics they watch; the two-word fields are
    /// the store's snake-case columns (`leftover_groups`, `mem_free_pct`, `paused_until`, `left_behind`).
    #[tokio::test]
    async fn the_snapshot_and_load_rows_are_published_on_the_topics_the_ui_watches() {
        let db = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
        install(&db).unwrap();
        let reading = LoadReading { mem_free_pct: Some(42.5), cpu: Some(10.0), pressure: None, at: 7, runs: 2, limits: Limits { floor: Some(15), ..Limits::default() }, held: None };
        let left = Leftover { pid: 9, command: "node dev".into(), rss: 5, cpu: 0.0, task: Some("t1".into()), since: 1 };
        let v = view::build(
            ViewInput { now: 7, mem_total: 16, cores: 8, memory: MemoryPer::Rss, reading: &reading, hold: None, paused_until: 0, battery: None, battery_hold: None, rows: &std::collections::BTreeMap::default(), tasks: &HashMap::new(), worktrees: None, harness: None, wisp: WispUse { rss: 3, cpu: Some(1.0) }, leftovers: vec![left], groups: Vec::new(), history: Vec::new() },
            Vec::new(),
        );
        let (snap, load) = rows(&v, &reading, 99, Some("7"), "darwin");
        db.write(move |w| w.upsert(SNAPSHOT.kind, snap).and_then(|_| w.upsert(LOAD.kind, load)).map(|_| ())).await.unwrap();
        let s = db.read(|r| r.get("machine.snapshot", "this")).unwrap().unwrap();
        assert_eq!(s["platform"], "darwin");
        assert_eq!(s["mem"]["freePct"], 42.5);
        assert_eq!(s["leftovers"][0]["pid"], 9);
        assert!(s["leftover_groups"].is_array());
        assert_eq!(s["cleanup"], "7");
        let l = db.read(|r| r.get("machine.load", "this")).unwrap().unwrap();
        assert_eq!(l["mem_free_pct"], 42.5);
        assert_eq!(l["cpu"], 10.0, "v1's Now line: CPU at 10% of its cores");
        assert_eq!(l["paused_until"], 99);
        assert_eq!(l["left_behind"], 1);
        assert_eq!(l["limits"]["floor"], 15);
        assert_eq!((SNAPSHOT.topics)(&s), vec!["plugin:wisp.machine:snapshot".to_owned()]);
        assert_eq!((LOAD.topics)(&l), vec!["plugin:wisp.machine:load".to_owned()]);
    }

    /// Stop takes only what the last sample placed as a task's (a leftover, a run's tree): never wisp,
    /// never what started it, never a stranger; a pid that isn't a number is refused before any signal.
    #[test]
    fn stop_refuses_wisp_its_parents_and_strangers() {
        let p = Procs::new("/h");
        let me = std::process::id();
        let reading = LoadReading { mem_free_pct: None, cpu: None, pressure: None, at: 0, runs: 0, limits: Limits::default(), held: None };
        let v = view::build(
            ViewInput { now: 0, mem_total: 0, cores: 1, memory: MemoryPer::Rss, reading: &reading, hold: None, paused_until: 0, battery: None, battery_hold: None, rows: &std::collections::BTreeMap::default(), tasks: &HashMap::new(), worktrees: None, harness: None, wisp: WispUse { rss: 0, cpu: None }, leftovers: Vec::new(), groups: Vec::new(), history: Vec::new() },
            Vec::new(),
        );
        *lock(&p.last) = Some((v, HashSet::from([4_000_000]), HashSet::from([4_000_001])));
        assert!(stop(&p, &json!(me)).is_err(), "wisp itself");
        assert!(stop(&p, &json!(4_000_001)).is_err(), "what started wisp");
        assert!(stop(&p, &json!(4_000_002)).is_err(), "not a task's");
        assert!(stop(&p, &json!("abc")).is_err(), "not a pid");
        // a placed pid that already ended: nothing to stop, not an error
        assert_eq!(stop(&p, &json!(4_000_000)).unwrap().stopped, 0);
    }
}
