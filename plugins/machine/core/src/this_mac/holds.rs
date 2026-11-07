//! The user's and the power's holds on automations (v1 Machine.hold, pause), and the checks on
//! `POST /machine/stop` and `POST /automations/pause`. Both holds reach exactly what the RAM/CPU guard
//! holds: they are its `extra`.

use serde_json::Value;
use wisp_machine_api::this_mac::{Hold, HoldKind};

use super::load::{Knobs, battery_limit};
use super::parse::{Battery, until_text};
use super::{RETRY_MS, Refusal, RefusalKind, js_number};

const DAY_MS: i64 = 86_400_000;
/// A pause is at most this far away.
pub const PAUSE_MAX_MS: i64 = 30 * DAY_MS;

/// The pause in force (ms), or 0 when there is none or it ran out.
pub fn paused_until(k: &Knobs, now: i64) -> i64 {
    k.automations_paused_until.filter(|u| *u > now).unwrap_or(0)
}

/// Pause automations, or on battery under batteryHold, or `None`. `until` is a minute off at most, so
/// Resume now (or the charger) lets held work go within one. `tz`: the local offset, for "until 20:00".
pub fn machine_hold(k: &Knobs, battery: Option<Battery>, now: i64, tz: i64) -> Option<Hold> {
    let paused = paused_until(k, now);
    if paused > 0 {
        let why = format!("Automations paused until {}", until_text(paused, now, tz));
        return Some(Hold { load: true, kind: HoldKind::Paused, why, until: paused.min(now + RETRY_MS) });
    }
    let at = battery_limit(k)?;
    let b = battery.filter(|b| !b.charging && b.pct < at)?;
    Some(Hold { load: true, kind: HoldKind::Battery, why: format!("Waiting for power: battery at {}%, needs {at}% or the charger", b.pct), until: now + RETRY_MS })
}

/// `POST /automations/pause {until}`: the new pause (ms), or `None` to resume (0).
pub fn check_pause(until: Option<&Value>, now: i64) -> Result<Option<i64>, Refusal> {
    let bad = |m: &str| Err(Refusal::new(RefusalKind::Invalid, m));
    // a body without `until` is NaN in v1 (Number(undefined)); `null` is 0
    let u = until.map_or(f64::NAN, js_number);
    if !u.is_finite() || u < 0.0 {
        return bad("until must be a time in ms, or 0 to resume");
    }
    if u == 0.0 {
        return Ok(None);
    }
    #[allow(clippy::cast_precision_loss)] // ms since the epoch fit an f64 exactly
    let (now_f, max_f) = (now as f64, (now + PAUSE_MAX_MS) as f64);
    if u <= now_f {
        return bad("until must be in the future (0 resumes)");
    }
    if u > max_f {
        return bad("until is at most 30 days away");
    }
    #[allow(clippy::cast_possible_truncation)] // between now and 30 days on
    Ok(Some((u + 0.5).floor() as i64))
}

/// `POST /machine/stop {pid}`: a whole number over 1, or 400.
pub fn check_pid(pid: &Value) -> Result<u64, Refusal> {
    let n = js_number(pid);
    if !n.is_finite() || n.fract() != 0.0 || n <= 1.0 {
        return Err(Refusal::new(RefusalKind::Invalid, "pid must be a process id"));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // whole and > 1; saturates past u64
    Ok(n as u64)
}

/// May wisp stop `pid`? Never itself or what started it; only what a task of its started (`mine`: a
/// leftover, or in a running task's tree).
pub fn check_stop(pid: u64, me: u32, ancestor: bool, mine: bool) -> Result<u32, Refusal> {
    if pid == u64::from(me) || ancestor {
        return Err(Refusal::new(RefusalKind::Forbidden, "That is wisp itself: it isn’t stopped from here."));
    }
    match u32::try_from(pid) {
        Ok(p) if mine => Ok(p),
        _ => Err(Refusal::new(RefusalKind::Forbidden, "Not a process a task of wisp’s started, or it already ended.")),
    }
}
