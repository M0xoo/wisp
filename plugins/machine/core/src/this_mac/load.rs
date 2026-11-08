//! The RAM/CPU guard (v1 server/load.js, design/budget.md → Machine load). Work nobody started by hand
//! waits while free memory is under the floor, the load is over the ceiling for 60 s, or wisp's own runs
//! fill `maxRuns`; it goes on once memory is back 5 points above the floor, the load is under the ceiling
//! and a run slot is free. Never the OS's "free" pages on macOS: a Mac caches files in all of them.

use wisp_machine_api::this_mac::{Held, Hold, HoldKind, Limits, LoadReading, Short};

use super::RETRY_MS;

pub const MEMORY_FLOORS: &[&str] = &["off", "10", "15", "20", "25"];
pub const CPU_CEILINGS: &[&str] = &["off", "100", "150", "200"];
pub const MAX_RUNS: &[&str] = &["off", "4", "6", "8", "12", "16", "auto"];
pub const BATTERY_HOLDS: &[&str] = &["off", "20", "40"];
/// The load stays over the ceiling this long before work waits. A minute, and 200% by default: macOS's
/// load average also counts processes waiting on I/O, so a test run reads far over 100%.
pub const CPU_HOLD_MS: i64 = 60_000;
/// Points above the floor before held work goes on (no flapping).
pub const MARGIN: u32 = 5;
/// Linux PSI: the share of the last 10 s some task stalled on memory. Over this the machine is short
/// whatever `MemAvailable` says; under `PSI_CLEAR` it can go on.
pub const PSI_HOLD: f64 = 25.0;
pub const PSI_CLEAR: f64 = 10.0;
const GB: u64 = 1024 * 1024 * 1024;

/// The settings this plugin reads (v1 `config.defaults`), as stored: a value off its list is the default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Knobs {
    pub memory_floor: Option<String>,
    pub cpu_ceiling: Option<String>,
    pub max_runs: Option<String>,
    pub battery_hold: Option<String>,
    /// ms since the epoch
    pub automations_paused_until: Option<i64>,
}

// ---------- parsing, one per source ----------

/// `sysctl -n kern.memorystatus_level`: the free percentage `memory_pressure` prints (macOS, no root).
pub fn parse_memorystatus(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<u64>()
        .ok()
        .filter(|n| *n <= 100)
        .map(|n| f64::from(u32::try_from(n).unwrap_or(100)))
}

/// The number after `^<name>:\s+` on some line.
fn field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let rest = l.strip_prefix(name)?.strip_prefix(':')?;
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let rest = rest.trim_start();
        let n = rest.bytes().take_while(u8::is_ascii_digit).count();
        rest[..n].parse().ok()
    })
}

#[allow(clippy::cast_precision_loss)] // byte counts: a percent needs no more than f64 holds
fn share(part: u64, total: u64) -> f64 {
    (part as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
}

/// `vm_stat`: pages free + inactive + speculative + purgeable, of the machine's memory.
pub fn parse_vm_stat(text: &str, total: u64) -> Option<f64> {
    let size = text
        .find("page size of ")
        .and_then(|i| {
            let r = &text[i + "page size of ".len()..];
            let n = r.bytes().take_while(u8::is_ascii_digit).count();
            r[n..]
                .starts_with(" bytes")
                .then(|| r[..n].parse::<u64>().ok())
                .flatten()
        })
        .filter(|n| *n > 0)
        .unwrap_or(4096);
    let free = field(text, "Pages free")?;
    if total == 0 {
        return None;
    }
    let pages = ["Pages inactive", "Pages speculative", "Pages purgeable"]
        .iter()
        .filter_map(|n| field(text, n))
        .fold(free, u64::saturating_add);
    Some(share(pages.saturating_mul(size), total))
}

/// `/proc/meminfo`: `MemAvailable` of `MemTotal` (both kB).
pub fn parse_meminfo(text: &str) -> Option<f64> {
    let total = field(text, "MemTotal").filter(|t| *t > 0)?;
    let avail = field(text, "MemAvailable")?;
    Some(share(avail, total))
}

/// `/proc/pressure/memory`: `some avg10=…`.
pub fn parse_pressure(text: &str) -> Option<f64> {
    text.lines().find_map(|l| {
        let rest = l.strip_prefix("some")?;
        if rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        let i = rest
            .split_whitespace()
            .find_map(|w| w.strip_prefix("avg10="))?;
        let n = i
            .bytes()
            .take_while(|b| b.is_ascii_digit() || *b == b'.')
            .count();
        i[..n].parse::<f64>().ok()
    })
}

/// One core's times, as Windows counts them (any unit, the same in both samples).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CoreTimes {
    pub user: f64,
    pub nice: f64,
    pub sys: f64,
    pub idle: f64,
    pub irq: f64,
}

/// Two samples: the busy share of every core, as a percent of one (0–100 on Windows).
pub fn cpu_busy(a: &[CoreTimes], b: &[CoreTimes]) -> Option<f64> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let (mut busy, mut all) = (0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let d = [
            y.user - x.user,
            y.nice - x.nice,
            y.sys - x.sys,
            y.idle - x.idle,
            y.irq - x.irq,
        ];
        let total: f64 = d.iter().sum();
        all += total;
        busy += total - d[3];
    }
    (all > 0.0).then(|| busy / all * 100.0)
}

// ---------- the knobs ----------

fn pick<'a>(v: Option<&'a str>, list: &[&str], dflt: &'a str) -> &'a str {
    v.filter(|x| list.contains(x)).unwrap_or(dflt)
}

/// `maxRuns: auto`: a run (a CLI plus the tests and builds it starts) can reach 3 GB.
pub fn auto_runs(total_bytes: u64) -> u32 {
    u32::try_from(total_bytes / GB / 3)
        .unwrap_or(u32::MAX)
        .max(2)
}

pub fn limits_of(k: &Knobs, total_bytes: u64) -> Limits {
    let n = |s: &str| if s == "off" { None } else { s.parse().ok() };
    let runs = pick(k.max_runs.as_deref(), MAX_RUNS, "auto");
    Limits {
        floor: n(pick(k.memory_floor.as_deref(), MEMORY_FLOORS, "15")),
        ceiling: n(pick(k.cpu_ceiling.as_deref(), CPU_CEILINGS, "200")),
        max_runs: if runs == "auto" {
            Some(auto_runs(total_bytes))
        } else {
            n(runs)
        },
    }
}

/// The batteryHold percent in force, or `None` when it is off (`20` unless set).
pub fn battery_limit(k: &Knobs) -> Option<u32> {
    let v = pick(k.battery_hold.as_deref(), BATTERY_HOLDS, "20");
    if v == "off" { None } else { v.parse().ok() }
}

// ---------- the guard ----------

/// One reading from the sources (`None`: no reading).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Sample {
    pub mem_free_pct: Option<f64>,
    pub cpu: Option<f64>,
    pub pressure: Option<f64>,
}

/// What the guard is weighed against, as it is now: a changed knob counts at once.
#[derive(Debug, Clone, Copy)]
pub struct Against<'a> {
    pub knobs: &'a Knobs,
    pub total: u64,
    /// wisp's own runs going now
    pub runs: u32,
    pub now: i64,
    pub mac: bool,
}

/// JavaScript's `Math.round(n)%`.
pub fn pct(n: f64) -> String {
    format!("{}%", (n + 0.5).floor())
}

fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The hysteresis, fed one sample every 10 s. `off`: never holds on its readings (a test server's).
#[derive(Debug, Clone, Default)]
pub struct Load {
    pub last: Sample,
    /// when `last` was sampled (0: never)
    pub at: i64,
    mem_held: bool,
    /// since when the load has been over the ceiling
    cpu_over: Option<i64>,
    was_free: Option<bool>,
    pub off: bool,
}

impl Load {
    /// A sample in. `extra`: the user's or the power's hold (a pause, the battery). True when held
    /// work may go now: it was held at the last sample and isn't any more.
    pub fn feed(&mut self, s: Sample, a: &Against<'_>, extra: Option<Hold>) -> bool {
        self.last = s;
        self.at = a.now;
        let free = self.hold(a, extra).is_none();
        let lifted = self.was_free == Some(false) && free;
        self.was_free = Some(free);
        lifted
    }

    #[allow(
        clippy::many_single_char_names,
        reason = "m, p: memory and pressure, as in v1 load.js"
    )]
    fn settle(&mut self, a: &Against<'_>) {
        let l = limits_of(a.knobs, a.total);
        let Sample {
            mem_free_pct: m,
            pressure: p,
            cpu,
        } = self.last;
        self.mem_held = match l.floor.map(f64::from) {
            None => false,
            Some(floor) if !self.mem_held => {
                m.is_some_and(|m| m < floor) || p.is_some_and(|p| p >= PSI_HOLD)
            }
            Some(floor) => {
                !(m.is_none_or(|m| m >= floor + f64::from(MARGIN))
                    && p.is_none_or(|p| p < PSI_CLEAR))
            }
        };
        match (l.ceiling, cpu) {
            (Some(c), Some(cpu)) if cpu > f64::from(c) => {
                self.cpu_over.get_or_insert(self.at);
            }
            _ => self.cpu_over = None,
        }
    }

    /// What holds back work nobody started by hand, or `None`. `extra` holds even when the readings
    /// are off: the user asked for it.
    pub fn hold(&mut self, a: &Against<'_>, extra: Option<Hold>) -> Option<Hold> {
        if extra.is_some() {
            return extra;
        }
        if self.off {
            return None;
        }
        self.settle(a);
        let l = limits_of(a.knobs, a.total);
        let Sample {
            mem_free_pct: m,
            pressure: p,
            cpu,
        } = self.last;
        let hold = |kind, why| {
            Some(Hold {
                load: true,
                kind,
                why,
                until: a.now + RETRY_MS,
            })
        };
        if let Some(floor) = l.floor.filter(|_| self.mem_held) {
            let needs = f64::from(floor + MARGIN);
            let why = match m {
                Some(m) if m < needs => {
                    format!("Waiting for memory: {} free, needs {}", pct(m), pct(needs))
                }
                _ => format!(
                    "Waiting for memory: the system is stalling on it ({} of the last 10 s)",
                    pct(p.unwrap_or(0.0))
                ),
            };
            return hold(HoldKind::Memory, why);
        }
        if let (Some(c), Some(since)) = (l.ceiling, self.cpu_over)
            && a.now - since >= CPU_HOLD_MS
        {
            let why = format!(
                "Waiting for the CPU: load at {} of its cores, needs under {}",
                pct(cpu.unwrap_or(0.0)),
                pct(f64::from(c))
            );
            return hold(HoldKind::Cpu, why);
        }
        match l.max_runs {
            Some(max) if a.runs >= max => hold(
                HoldKind::Runs,
                format!(
                    "Waiting for a run slot: {} run{} going, at most {max}",
                    a.runs,
                    plural(a.runs)
                ),
            ),
            _ => None,
        }
    }

    /// The machine is short (memory, CPU): the worktree sweep waits. Full run slots aren't.
    pub fn busy(&mut self, a: &Against<'_>, extra: Option<Hold>) -> bool {
        matches!(
            self.hold(a, extra).map(|h| h.kind),
            Some(HoldKind::Memory | HoldKind::Cpu)
        )
    }

    /// A run you start by hand goes anyway; when memory is under the floor the page says so.
    pub fn short(&self, a: &Against<'_>) -> Option<Short> {
        if self.off {
            return None;
        }
        let floor = f64::from(limits_of(a.knobs, a.total).floor?);
        let m = self.last.mem_free_pct.filter(|m| *m < floor)?;
        let machine = if a.mac { "Your Mac" } else { "This computer" };
        Some(Short {
            why: format!(
                "{machine} is short on memory: {} free, {} run{} going",
                pct(m),
                a.runs,
                plural(a.runs)
            ),
        })
    }

    /// What the page and `GET /load` see.
    pub fn reading(&mut self, a: &Against<'_>, extra: Option<Hold>) -> LoadReading {
        let held = self.hold(a, extra).map(|h| Held {
            kind: h.kind,
            why: h.why,
        });
        LoadReading {
            mem_free_pct: self.last.mem_free_pct,
            cpu: self.last.cpu,
            pressure: self.last.pressure,
            at: self.at,
            runs: a.runs,
            limits: limits_of(a.knobs, a.total),
            held,
        }
    }
}
