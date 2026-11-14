//! When a member's check-in is due (v1 crew.js `nextCheckin`, `dueNow`, `applyMemory`'s wake-up): its
//! cron, at most once per cron minute, or a wake-up it asked for, once. Pure: `now` comes in.

use wisp_crew_api::{Member, WAKE_MAX, WAKE_MIN};

use crate::cron::{Zone, parse};

const MIN: i64 = 60_000;

/// The minute a timestamp is in (what `lastMinute` stores): zone-free, ms / 60 000.
pub fn minute_of(ms: i64) -> i64 {
    ms.div_euclid(MIN)
}

/// When the member's next check-in is due: its schedule or a wake-up it asked for. `None`: none.
/// The minute `now` is in counts until its check-in has run (`lastMinute`, v1 crew.js:259-260).
pub fn next_checkin(m: &Member, now: i64, zone: &dyn Zone) -> Option<i64> {
    if m.paused {
        return None;
    }
    let mut at = None;
    if !m.cron.is_empty()
        && let Ok(c) = parse(&m.cron)
    {
        at = c.next_run(now - MIN, zone);
        if let Some(t) = at
            && Some(minute_of(t)) == m.last_minute
        {
            at = c.next_run(t, zone);
        }
    }
    match (m.wake_at, at) {
        (Some(w), Some(a)) if w < a => Some(w),
        (Some(w), None) => Some(w),
        _ => at,
    }
}

/// Whether a check-in is due now: a wake-up that has come, or a cron minute that hasn't run yet.
pub fn due_now(m: &Member, now: i64, zone: &dyn Zone) -> bool {
    if m.paused {
        return false;
    }
    if m.wake_at.is_some_and(|w| w <= now) {
        return true;
    }
    if m.cron.is_empty() || m.last_minute == Some(minute_of(now)) {
        return false;
    }
    parse(&m.cron).is_ok_and(|c| c.matches_at(now, zone))
}

/// A wake-up `minutes` from now, clamped to 5 minutes .. 7 days (v1 crew.js:387).
#[allow(clippy::cast_possible_truncation)] // clamped first, then rounded: well inside i64
pub fn wake_at(now: i64, minutes: f64) -> i64 {
    let m = if minutes.is_finite() { minutes.round() } else { 0.0 };
    #[allow(clippy::cast_precision_loss)] // the bounds are small integers
    let m = m.clamp(WAKE_MIN as f64, WAKE_MAX as f64) as i64;
    now + m * MIN
}
