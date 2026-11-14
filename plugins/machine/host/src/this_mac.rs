//! `this_mac`, the load guard (v1 server/load.js, the RAM/CPU half of routes/machine.js): a sample every 10 s of
//! free memory (macOS `kern.memorystatus_level`, else `vm_stat`; Linux `/proc/meminfo` and PSI) and CPU (the
//! 1-minute load over the cores), fed to `wisp_machine_core::this_mac::load::Load`'s hysteresis against the
//! knobs (`machine.memoryFloor`, `.cpuCeiling`, `.maxRuns`, `.batteryHold`) and the user's pause. It answers
//! `machine.service@1` (what holds unattended work: crew, triggers, Later, goal rounds), `machine.load`, and
//! `machine.automations.pause`; when a hold lifts it says so (`machine.load_free`), and held work goes.
//!
//! The process view (`machine.read`, attribution, `machine.stop`, `.fix`, `.harness.clean`, the rows the
//! page and the chip watch) is `procs`.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_machine_api::this_mac::commands::{self as c, LoadFree, Paused};
use wisp_machine_api::this_mac::service::{Hold, LoadReading, MachineApi, MachineService, PERM_LOAD, Short};
use wisp_machine_core::this_mac::holds;
use wisp_machine_core::this_mac::load::{self as core, Against, Knobs, Load, Sample};
use wisp_machine_core::this_mac::parse;

const SAMPLE_MS: u64 = 10_000;

pub struct Guard {
    load: Mutex<Load>,
    pub(crate) knobs: Mutex<Knobs>,
    pub(crate) total: Mutex<u64>,
    runs: Mutex<u32>,
    pub(crate) battery: Mutex<Option<parse::Battery>>,
    tz: Mutex<i64>,
    now: Mutex<i64>,
    pub(crate) mac: bool,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guard").field("mac", &self.mac).finish_non_exhaustive()
    }
}

impl Guard {
    pub fn new(mac: bool) -> Self {
        Self {
            load: Mutex::default(),
            knobs: Mutex::default(),
            total: Mutex::new(0),
            runs: Mutex::new(0),
            battery: Mutex::new(None),
            tz: Mutex::new(0),
            now: Mutex::new(0),
            mac,
        }
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Load, &Against<'_>, Option<Hold>) -> T) -> T {
        let knobs = lock(&self.knobs).clone();
        let now = *lock(&self.now);
        let a = Against { knobs: &knobs, total: *lock(&self.total), runs: *lock(&self.runs), now, mac: self.mac };
        let extra = holds::machine_hold(&knobs, *lock(&self.battery), now, *lock(&self.tz));
        f(&mut lock(&self.load), &a, extra)
    }

    /// A sample in; true when held work may go now.
    pub fn feed(&self, s: Sample) -> bool {
        self.with(|l, a, extra| l.feed(s, a, extra))
    }
}

impl MachineApi for Guard {
    fn hold(&self, call: &Call) -> Result<Option<Hold>> {
        call.require(PERM_LOAD)?;
        Ok(self.with(Load::hold))
    }
    fn busy(&self, call: &Call) -> Result<bool> {
        call.require(PERM_LOAD)?;
        Ok(self.with(Load::busy))
    }
    fn short(&self, call: &Call) -> Result<Option<Short>> {
        call.require(PERM_LOAD)?;
        Ok(self.with(|l, a, _| l.short(a)))
    }
    fn reading(&self, call: &Call) -> Result<LoadReading> {
        call.require(PERM_LOAD)?;
        Ok(self.with(Load::reading))
    }
}

pub(crate) async fn run(proc: &wisp_proc::Proc, bin: &str, args: &[&str]) -> Option<String> {
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    let r = proc
        .exec(bin, &args, wisp_proc::ExecOpts { timeout: Some(Duration::from_secs(5)), ..wisp_proc::ExecOpts::default() })
        .await
        .ok()?;
    r.exit.success().then(|| r.stdout_text())
}

pub(crate) fn cores() -> f64 {
    f64::from(u32::try_from(std::thread::available_parallelism().map_or(1, std::num::NonZero::get)).unwrap_or(1))
}

/// One reading of memory and CPU (and Linux's memory pressure); `None` for what can't be read here.
async fn sample(proc: &wisp_proc::Proc, mac: bool, total: u64) -> Sample {
    if mac {
        let mem = match run(proc, "sysctl", &["-n", "kern.memorystatus_level"]).await.and_then(|t| core::parse_memorystatus(&t)) {
            Some(m) => Some(m),
            None => run(proc, "vm_stat", &[]).await.and_then(|t| core::parse_vm_stat(&t, total)),
        };
        let cpu = run(proc, "sysctl", &["-n", "vm.loadavg"]).await.and_then(|t| parse::parse_loadavg(&t)).map(|l| l / cores() * 100.0);
        return Sample { mem_free_pct: mem, cpu, pressure: None };
    }
    let mem = tokio::fs::read_to_string("/proc/meminfo").await.ok().and_then(|t| core::parse_meminfo(&t));
    let pressure = tokio::fs::read_to_string("/proc/pressure/memory").await.ok().and_then(|t| core::parse_pressure(&t));
    let cpu = tokio::fs::read_to_string("/proc/loadavg").await.ok().and_then(|t| parse::parse_loadavg(&t)).map(|l| l / cores() * 100.0);
    Sample { mem_free_pct: mem, cpu, pressure }
}

async fn total_memory(proc: &wisp_proc::Proc, mac: bool) -> u64 {
    if mac {
        return run(proc, "sysctl", &["-n", "hw.memsize"]).await.and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    }
    tokio::fs::read_to_string("/proc/meminfo")
        .await
        .ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("MemTotal:").and_then(|r| r.split_whitespace().next()?.parse::<u64>().ok())))
        .map_or(0, |kb| kb * 1024)
}

fn knob(ctx: &Ctx, key: &str) -> Option<String> {
    ctx.setting(key).and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_u64().map(|n| n.to_string())))
}

/// The knobs as set now (a changed one counts at the next sample).
fn read_knobs(ctx: &Ctx, paused: Option<i64>) -> Knobs {
    Knobs {
        memory_floor: knob(ctx, "machine.memoryFloor"),
        cpu_ceiling: knob(ctx, "machine.cpuCeiling"),
        max_runs: knob(ctx, "machine.maxRuns"),
        battery_hold: knob(ctx, "machine.batteryHold"),
        automations_paused_until: paused,
    }
}

async fn tick(ctx: &Ctx, g: &Guard, proc: &wisp_proc::Proc, procs: &crate::procs::Procs) {
    let now = ctx.clock().map_or(0, |c| c.now_ms());
    *lock(&g.now) = now;
    let paused = lock(&g.knobs).automations_paused_until;
    *lock(&g.knobs) = read_knobs(ctx, paused);
    let list = crate::calls::tasks(ctx, &ctx.root_call(), None).await;
    *lock(&g.runs) =
        u32::try_from(list.iter().filter(|s| s.state == wisp_runtime_api::model::SessionState::Running).count()).unwrap_or(u32::MAX);
    if g.mac {
        *lock(&g.battery) = run(proc, "pmset", &["-g", "batt"]).await.and_then(|t| parse::parse_batt(&t));
    }
    let total = *lock(&g.total);
    let s = sample(proc, g.mac, total).await;
    if g.feed(s) {
        let reading = g.with(Load::reading);
        ctx.emit(&ctx.root_call(), &LoadFree { reading });
    }
    procs.tick(ctx, g, proc, now).await;
}

pub(crate) fn setup(s: &mut Setup) {
    let g = Arc::new(Guard::new(cfg!(target_os = "macos")));
    let procs = crate::procs::setup(s, &g);
    s.provide::<MachineService>(g.clone());
    let r = g.clone();
    s.command::<c::Load, _, _>(move |_ctx, call, _| {
        let g = r.clone();
        async move { g.reading(&call) }
    });
    let p = g.clone();
    s.command::<c::AutomationsPause, _, _>(move |ctx, call, a| {
        let g = p.clone();
        async move {
            let now = ctx.clock()?.now_ms();
            let until = holds::check_pause(Some(&a.until), now).map_err(|e| WireError::invalid(e.message))?;
            lock(&g.knobs).automations_paused_until = until;
            *lock(&g.now) = now;
            let paused = Paused { paused_until: until.unwrap_or(0) };
            ctx.emit(&call, &c::AutomationsPaused { paused });
            // resumed: what the pause held may go now
            if until.is_none() && g.with(Load::hold).is_none() {
                let reading = g.with(Load::reading);
                ctx.emit(&call, &LoadFree { reading });
            }
            Ok(paused)
        }
    });
    s.on_start(move |ctx| async move {
        let proc = ctx.service::<wisp_proc::Proc>()?;
        if let Ok(store) = ctx.service::<wisp_store::Store>() {
            crate::rows::install(&store).map_err(|e| WireError::internal(e.to_string()))?;
        }
        let total = total_memory(&proc, g.mac).await;
        *lock(&g.total) = total;
        if let Some(tz) = run(&proc, "date", &["+%z"]).await.and_then(|t| parse::parse_tz_offset(&t)) {
            *lock(&g.tz) = tz;
        }
        let clock = ctx.clock()?;
        let c2 = ctx.clone();
        ctx.spawn(async move {
            loop {
                tick(&c2, &g, &proc, &procs).await;
                clock.sleep(SAMPLE_MS).await;
            }
        });
        Ok(())
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_guard_holds_under_the_memory_floor_and_lets_go_with_a_margin() {
        let g = Guard::new(false);
        *lock(&g.total) = 16 << 30;
        *lock(&g.knobs) = Knobs { memory_floor: Some("15".into()), ..Knobs::default() };
        *lock(&g.now) = 1_000;
        assert!(!g.feed(Sample { mem_free_pct: Some(40.0), cpu: Some(10.0), pressure: None }));
        assert!(!g.feed(Sample { mem_free_pct: Some(9.0), cpu: Some(10.0), pressure: None }), "held, not lifted");
        assert!(g.with(Load::hold).is_some());
        assert!(
            !g.feed(Sample { mem_free_pct: Some(17.0), cpu: Some(10.0), pressure: None }),
            "over the floor, under the margin: still held"
        );
        assert!(g.feed(Sample { mem_free_pct: Some(25.0), cpu: Some(10.0), pressure: None }), "freed: held work goes");
        // a pause holds whatever the readings say
        *lock(&g.knobs) = Knobs { automations_paused_until: Some(10_000), ..Knobs::default() };
        let h = g.with(Load::hold).unwrap();
        assert!(h.why.contains("paused"), "{}", h.why);
    }
}
