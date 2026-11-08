//! This Mac's pure logic (v1 server/machine.js, server/load.js). Sans-IO: the host runs `ps`, `sysctl`,
//! `vm_stat`, `pmset` or PowerShell and hands the text in, with the time (`now`, ms) and the tables
//! (live runs, which tasks exist, the settings). Nothing here reads a clock, a file or a process.
//!
//! - [`parse`]: one parser per source; none panics on any input (property-tested).
//! - [`load`]: the RAM/CPU guard: memory parsers, the knobs, the hysteresis.
//! - [`attribute`]: whose each process is: a run's tree, tags kept past a reparent, leftovers.
//! - [`holds`]: Pause automations, the battery hold, and the checks on stop and pause.
//! - [`view`]: per-task rows, `res` on a heavy task's summary, reclaim groups, File a fix's prompt,
//!   and `GET /machine`.
//! - [`history`]: a day of 1-minute points.

pub mod attribute;
pub mod history;
pub mod holds;
pub mod load;
pub mod parse;
pub mod view;

/// Sampling while something runs, a run ended < `AFTER_MS` ago, or someone read the page < `READ_MS` ago.
pub const TICK_MS: i64 = 10_000;
/// A read of `GET /machine` keeps the ticks going this long.
pub const READ_MS: i64 = 30_000;
/// ...and so does a run that just ended: what it left behind shows.
pub const AFTER_MS: i64 = 180_000;
/// A finished run's process this old is left behind.
pub const LEFT_MS: i64 = 120_000;
pub const POINT_MS: i64 = 60_000;
pub const HISTORY_MS: i64 = 24 * 3_600_000;
/// SIGTERM, then SIGKILL this long after.
pub const KILL_MS: i64 = 5_000;
/// A task's summary shows its `res` over these...
pub const RES_RSS: u64 = 500 * 1024 * 1024;
pub const RES_CPU: f64 = 50.0;
/// ...and is sent again only when it moved this much.
pub const RES_MOVE: f64 = 0.2;
/// History points between writes.
pub const SAVE_EVERY: u32 = 5;
/// A command line is cut to this many characters.
pub const COMMAND_MAX: usize = 200;
/// Held work looks again this soon (it has no reset to wait for).
pub const RETRY_MS: i64 = 60_000;
/// A pid the OS gave to another process doesn't keep its tag: start times this far apart are two processes.
pub const SAME_SINCE_MS: i64 = 5_000;

/// The OS wisp runs on: it decides the `ps` flavour, the path rules and where tags come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Mac,
    Linux,
    Windows,
}

/// A refusal, as data: the host maps it to its wire error (400, 403, 404, 409).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub kind: RefusalKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalKind {
    Invalid,
    Forbidden,
    NotFound,
    Conflict,
}

impl Refusal {
    pub fn new(kind: RefusalKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// JavaScript's `Math.round(n * 10^d) / 10^d`, or `None` for a value that isn't finite (v1 `round`).
pub fn round(n: f64, d: i32) -> Option<f64> {
    if !n.is_finite() {
        return None;
    }
    let k = 10f64.powi(d);
    // Math.round rounds half up (towards +∞), not away from zero
    Some((n * k + 0.5).floor() / k)
}

/// `round(n, 1)`, 0 for a value that isn't finite (where v1 summed numbers it knew were finite).
pub fn round1(n: f64) -> f64 {
    round(n, 1).unwrap_or(0.0)
}

/// JavaScript's `Number(v)` for what a request body may carry: `null` and `""` are 0, a numeric string
/// is its number, anything else NaN.
pub fn js_number(v: &serde_json::Value) -> f64 {
    use serde_json::Value;
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'))
            {
                t.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}
