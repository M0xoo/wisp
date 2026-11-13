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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_machine_api::this_mac::commands::{self as c, Cleaned, FixFiled, Stopped};
use wisp_machine_api::this_mac::{FACTS, FIXER, HARNESS_DISK, HistoryPoint, LeftoverGroup, LiveRun, MachineView, MemoryPer, RUNS, WispUse};
use wisp_machine_core::this_mac::attribute::{Attributor, Placed};
use wisp_machine_core::this_mac::history::History;
use wisp_machine_core::this_mac::load::Load;
use wisp_machine_core::this_mac::view::{self, TaskInfo, ViewInput};
use wisp_machine_core::this_mac::{AFTER_MS, KILL_MS, POINT_MS, Platform, READ_MS, Refusal, RefusalKind, holds, parse};
use wisp_runtime_api::model::SessionState;
use wisp_store::Store;

use crate::calls;
use crate::rows::{LOAD, SNAPSHOT, platform_name, rows};
use crate::this_mac::{Guard, lock, run};

/// Sampling when nothing runs and nobody reads the page: once a minute (the history's pace).
const IDLE_MS: i64 = 60_000;

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
            Platform::Mac => run(proc, "ps", &["-E", "-axww", "-o", "pid=,ppid=,rss=,%cpu=,etime=,command="])
                .await
                .map(|t| parse::parse_ps(&t, now, true))
                .unwrap_or_default(),
            Platform::Linux => run(proc, "ps", &["-axww", "-o", "pid=,ppid=,rss=,%cpu=,etime=,command="])
                .await
                .map(|t| parse::parse_ps(&t, now, false))
                .unwrap_or_default(),
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
            let text =
                tokio::fs::read(format!("/proc/{pid}/environ")).await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            if let Some(p) = procs.iter().find(|p| p.pid == pid) {
                let since = p.since;
                lock(&self.attr).set_environ(pid, since, parse::tag_in_environ(&text));
            }
        }
        let list = calls::tasks(ctx, &call, Some(false)).await;
        let running: HashSet<String> = list.iter().filter(|t| t.state == SessionState::Running).map(|t| t.id.0.clone()).collect();
        let mut tasks: HashMap<String, TaskInfo> = list.iter().map(calls::task_of).map(|t| (t.id.clone(), t)).collect();
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
        let wt = calls::worktrees(ctx, &call).await;
        // the facts other plugins add, for the tasks the page names
        let named: HashSet<String> = usage
            .keys()
            .cloned()
            .chain(leftovers.iter().filter_map(|l| l.task.clone()))
            .chain(wt.iter().flat_map(|w| w.items.iter().map(|i| i.id.clone())))
            .collect();
        let facts = ctx.contributions(&FACTS);
        if !facts.is_empty() {
            let ids: Vec<String> = named.into_iter().filter(|id| tasks.contains_key(id)).collect();
            for id in &ids {
                let session = match calls::session(ctx, &call, id).await {
                    Ok(s) => s,
                    Err(err) => {
                        tracing::warn!(error = %err.message, task = %id, "machine: runtime.get for its facts");
                        continue;
                    }
                };
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
                h.push(HistoryPoint {
                    at: now,
                    free_pct: reading.mem_free_pct,
                    cpu: reading.cpu,
                    runs: reading.runs,
                    held: hold.is_some(),
                    worktree_bytes: wt.as_ref().and_then(|w| w.size),
                });
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
            match wisp_proc::signal_pid(pid, wisp_proc::Signal::Kill) {
                Ok(()) | Err(wisp_proc::ProcError::Exited) => {}
                Err(e) => tracing::warn!(error = %e, pid, "machine: SIGKILL after SIGTERM"),
            }
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
        Some(t) => calls::session(ctx, call, t)
            .await
            .map(|s| calls::task_of_session(&s))
            .map_err(|err| tracing::warn!(error = %err.message, task = %t, "machine: runtime.get for a fix"))
            .ok(),
        None => None,
    };
    let project = view::project_of(task.as_ref());
    let prompt = view::fix_prompt(&g, task.as_ref(), project.as_deref(), &v.leftovers, now);
    for f in ctx.contributions(&FIXER) {
        if let Some(filed) = f.file(call, prompt.clone()).await? {
            return Ok(filed);
        }
    }
    let id = calls::create(ctx, call, prompt, format!("Fix: {} left running", g.command), project.as_deref()).await?;
    Ok(FixFiled { session: Some(id), ..FixFiled::default() })
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
            let commands: Vec<String> =
                lock(&p.last).as_ref().map(|(v, _, _)| v.leftovers.iter().map(|l| l.command.clone()).collect()).unwrap_or_default();
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
    use serde_json::json;
    use wisp_machine_api::this_mac::{Limits, LoadReading};

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

    /// Stop takes only what the last sample placed as a task's (a leftover, a run's tree): never wisp,
    /// never what started it, never a stranger; a pid that isn't a number is refused before any signal.
    #[test]
    fn stop_refuses_wisp_its_parents_and_strangers() {
        let p = Procs::new("/h");
        let me = std::process::id();
        let reading = LoadReading { mem_free_pct: None, cpu: None, pressure: None, at: 0, runs: 0, limits: Limits::default(), held: None };
        let v = view::build(
            ViewInput {
                now: 0,
                mem_total: 0,
                cores: 1,
                memory: MemoryPer::Rss,
                reading: &reading,
                hold: None,
                paused_until: 0,
                battery: None,
                battery_hold: None,
                rows: &std::collections::BTreeMap::default(),
                tasks: &HashMap::new(),
                worktrees: None,
                harness: None,
                wisp: WispUse { rss: 0, cpu: None },
                leftovers: Vec::new(),
                groups: Vec::new(),
                history: Vec::new(),
            },
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
