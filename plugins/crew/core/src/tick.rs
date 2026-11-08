//! The scheduler's look at one member (v1 crew.js `tick`, every [`wisp_crew_api::TICK_MS`]): whether
//! a check-in is due, and the bookkeeping that goes with firing it. Pure: the host starts the job.

use wisp_crew_api::Member;

use crate::cron::Zone;
use crate::schedule::{due_now, minute_of};

/// A check-in the tick fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fire {
    /// a wake-up the member asked for (not its cron)
    pub wake: bool,
}

/// If a check-in is due now, mark the minute as run (`lastMinute`), clear a wake-up that came, and
/// say what to fire. The check-in is unattended: the budget may hold it.
pub fn tick(m: &mut Member, now: i64, zone: &dyn Zone) -> Option<Fire> {
    if !due_now(m, now, zone) {
        return None;
    }
    let wake = m.wake_at.is_some_and(|w| w <= now);
    m.last_minute = Some(minute_of(now));
    if wake {
        m.wake_at = None;
    }
    Some(Fire { wake })
}

/// The soonest check-in across the crew (v1 `nextWake`, for a host that wakes this wisp for it).
pub fn next_wake(crew: &[Member], now: i64, zone: &dyn Zone) -> Option<i64> {
    crew.iter().filter_map(|m| crate::schedule::next_checkin(m, now, zone)).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::Utc;

    fn member(cron: &str) -> Member {
        Member { id: "m".into(), name: "Ada".into(), agent: "claude".into(), mode: "auto".into(), cron: cron.into(), parallel: 2, ..Member::default() }
    }

    #[test]
    fn fires_once_per_cron_minute() {
        let mut m = member("* * * * *");
        let now = 1_700_000_000_000;
        assert_eq!(tick(&mut m, now, &Utc), Some(Fire { wake: false }));
        assert_eq!(tick(&mut m, now + 5_000, &Utc), None);
        assert!(tick(&mut m, now + 60_000, &Utc).is_some());
    }

    #[test]
    fn a_wake_up_fires_and_clears() {
        let mut m = member("");
        let now = 1_700_000_000_000;
        m.wake_at = Some(now - 1);
        assert_eq!(tick(&mut m, now, &Utc), Some(Fire { wake: true }));
        assert_eq!(m.wake_at, None);
        assert_eq!(tick(&mut m, now + 1, &Utc), None);
    }

    #[test]
    fn paused_never_fires() {
        let mut m = member("* * * * *");
        m.paused = true;
        assert_eq!(tick(&mut m, 1_700_000_000_000, &Utc), None);
        assert_eq!(next_wake(&[m], 1_700_000_000_000, &Utc), None);
    }
}
