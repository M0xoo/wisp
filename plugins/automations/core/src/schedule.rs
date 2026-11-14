//! When a `schedule` trigger is due (ADR-0043), decided on local wall-clock minutes. The last fired local
//! minute is kept, and a tick fires the latest matching minute after it, up to now:
//! - a restart in the minute it fired doesn't fire it again;
//! - a computer that slept through runs fires once, marked `late`, not once per missed run;
//! - a daylight-saving gap (02:30 never happens) fires once, at the first tick after it; an overlap (02:30
//!   happens twice) fires once.
//!
//! A schedule never seen before starts from now: nothing from before it existed is run.

use wisp_automations_api::{Cron, Zone, matches_local};

const MINUTE: i64 = 60_000;
/// How far back a missed run is looked for.
const LOOKBACK_MIN: i64 = 7 * 24 * 60;

/// The local minute (ms / 60 000, local wall clock) it's now.
pub fn local_minute(now_utc: i64, zone: &dyn Zone) -> i64 {
    (now_utc + zone.offset_ms(now_utc)).div_euclid(MINUTE)
}

/// What a tick should fire: the local minute it's for, and whether that's late (a missed run).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    pub minute: i64,
    pub late: bool,
}

pub fn due(c: &Cron, zone: &dyn Zone, last: Option<i64>, now_utc: i64) -> Option<Due> {
    let now = local_minute(now_utc, zone);
    let Some(last) = last else {
        return matches_local(c, now * MINUTE).then_some(Due { minute: now, late: false });
    };
    if now <= last {
        return None;
    }
    let from = (last + 1).max(now - LOOKBACK_MIN);
    (from..=now).rev().find(|m| matches_local(c, m * MINUTE)).map(|m| Due { minute: m, late: m < now })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::assert_is_empty)]
mod tests {
    use wisp_automations_api::{Utc, parse_cron};

    use super::*;

    /// Runs ticks every minute from `from` to `to` (UTC ms), as the engine would, keeping `last`.
    fn run(c: &Cron, zone: &dyn Zone, mut last: Option<i64>, from: i64, to: i64, step: i64) -> (Vec<Due>, Option<i64>) {
        let mut fired = Vec::new();
        let mut t = from;
        while t <= to {
            if let Some(d) = due(c, zone, last, t) {
                last = Some(d.minute);
                fired.push(d);
            }
            t += step;
        }
        (fired, last)
    }

    const DAY0: i64 = 1_794_000_000_000 / 86_400_000 * 86_400_000; // a midnight UTC

    #[test]
    fn schedule_fires_once_per_minute_across_restart() {
        let c = parse_cron("0 9 * * *").unwrap();
        let nine = DAY0 + 9 * 3_600_000;
        let d = due(&c, &Utc, None, nine + 5_000).unwrap();
        assert_eq!(d, Due { minute: nine / MINUTE, late: false });
        // restarted 20 s later, in the same minute: the kept minute stops a second run
        assert_eq!(due(&c, &Utc, Some(d.minute), nine + 25_000), None);
        // and every tick of that minute and the next hours
        let (fired, _) = run(&c, &Utc, Some(d.minute), nine, nine + 3 * 3_600_000, 10_000);
        assert!(fired.is_empty());
    }

    #[test]
    fn missed_schedule_while_asleep_fires_once_not_n_times() {
        let c = parse_cron("0 * * * *").unwrap();
        let start = DAY0;
        let last = due(&c, &Utc, None, start).unwrap().minute;
        // asleep 8 h: 8 hourly runs missed; the first tick after waking fires once, late
        let woke = start + 8 * 3_600_000 + 17 * MINUTE;
        let d = due(&c, &Utc, Some(last), woke).unwrap();
        assert!(d.late);
        assert_eq!(d.minute, (start + 8 * 3_600_000) / MINUTE, "the latest missed run");
        assert_eq!(due(&c, &Utc, Some(d.minute), woke + MINUTE), None);
    }

    /// Europe/Zurich-like: +1 h, then +2 h from `switch` (spring forward at local 02:00 → 03:00), or the reverse.
    struct Dst {
        switch: i64,
        before: i64,
        after: i64,
    }
    impl Zone for Dst {
        fn offset_ms(&self, utc: i64) -> i64 {
            if utc < self.switch { self.before } else { self.after }
        }
    }

    #[test]
    fn dst_gap_and_overlap_fire_once() {
        let c = parse_cron("30 2 * * *").unwrap();
        let h = 3_600_000;
        // spring: at 01:00 UTC local goes 02:00 → 03:00; 02:30 never happens
        let spring = Dst { switch: DAY0 + h, before: h, after: 2 * h };
        let last = Some(local_minute(DAY0 - 2 * h, &spring));
        let (fired, _) = run(&c, &spring, last, DAY0 - 2 * h, DAY0 + 6 * h, MINUTE);
        assert_eq!(fired.len(), 1, "{fired:?}");
        // autumn: at 01:00 UTC local goes 03:00 → 02:00; 02:30 happens twice
        let autumn = Dst { switch: DAY0 + h, before: 2 * h, after: h };
        let last = Some(local_minute(DAY0 - 2 * h, &autumn));
        let (fired, _) = run(&c, &autumn, last, DAY0 - 2 * h, DAY0 + 6 * h, MINUTE);
        assert_eq!(fired.len(), 1, "{fired:?}");
        assert!(!fired[0].late);
    }
}
