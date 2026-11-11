//! What a unit of work takes of a window (v1 budget.js:489-538, 612-616): `learn` is Ask near the
//! limit's rate, `drain` is Drain watch's samples, kept run by run for two weeks, so a plan that
//! suddenly moves much faster for the same work stands out (design/budget.md).

use std::collections::BTreeMap;

use wisp_budget_api::{Drain, DrainFailed};

use crate::state::{Acc, DrainSample};
use crate::windows::{H, window_label};

/// Two points moved before a rate counts (the CLI reports whole percents).
pub const LEARN_MIN: f64 = 0.02;
/// Past this many points, halve: the rate follows the recent runs.
pub const LEARN_KEEP: f64 = 0.3;
const DRAIN_KEEP: usize = 40;
const DRAIN_AGE: i64 = 14 * 24 * H;
const DRAIN_RECENT: i64 = 2 * H;
const DRAIN_RATIO: f64 = 2.0;
/// What "usual" needs before it means anything: runs and points moved.
const DRAIN_MIN: (usize, f64) = (5, 0.03);
/// And the recent runs.
const DRAIN_NOW: (usize, f64) = (2, 0.05);
/// The phone hears of one window's drain at most once per this long (index.js:151).
pub const DRAIN_NOTE_MS: i64 = 2 * H;

/// A run on the account ended: its units of work count against what the windows moved. Runs at the
/// same time share what moved in between: the first to end takes it, which evens out over a few
/// runs. Returns whether anything changed.
pub fn spend(acc: &mut Acc, units: f64, failed: bool, now: i64) -> bool {
    if units.is_nan() || units <= 0.0 {
        return false;
    }
    let ids: Vec<String> = acc.windows.keys().cloned().collect();
    for id in ids {
        let l = acc.learn.entry(id.clone()).or_default();
        l.units += units;
        if l.du > LEARN_KEEP {
            l.du /= 2.0;
            l.units /= 2.0;
        }
        let du = acc.run.get(&id).copied().unwrap_or(0.0).max(0.0);
        let list = acc.drain.entry(id).or_default();
        list.retain(|x| x.at > now - DRAIN_AGE);
        list.push(DrainSample { at: now, du, units, failed });
        if list.len() > DRAIN_KEEP {
            let extra = list.len() - DRAIN_KEEP;
            list.drain(..extra);
        }
    }
    acc.run.clear();
    true
}

/// A run's units of work (v1 budget.js `unitsOf`): its cost when it reported one, else its tokens in millions;
/// 0 is no sample. `in_usd`: whether they're dollars (the phone's words say which).
#[allow(clippy::cast_precision_loss, reason = "a token count well under 2^52")]
pub fn units_of(cost_usd: Option<f64>, tokens: Option<u64>) -> (f64, bool) {
    match cost_usd.filter(|c| c.is_finite() && *c > 0.0) {
        Some(c) => (c, true),
        None => (tokens.map_or(0.0, |t| t as f64 / 1e6), false),
    }
}

fn sum(xs: &[&DrainSample], f: fn(&DrainSample) -> f64) -> f64 {
    xs.iter().map(|x| f(x)).sum()
}

/// Drain watch: the window whose last two hours of runs took twice or more its usual share per unit
/// of work, or None. Dismissed (`drain_seen`) until a run after that says so again.
#[allow(clippy::cast_possible_truncation)]
pub fn drain_of(acc: &Acc, now: i64) -> Option<Drain> {
    let mut best: Option<Drain> = None;
    for (id, all) in &acc.drain {
        let list: Vec<&DrainSample> = all.iter().filter(|x| x.at > now - DRAIN_AGE).collect();
        let (recent, before): (Vec<&DrainSample>, Vec<&DrainSample>) = list.iter().partition(|x| x.at > now - DRAIN_RECENT);
        let (bu, bd, ru, rd) = (sum(&before, |x| x.units), sum(&before, |x| x.du), sum(&recent, |x| x.units), sum(&recent, |x| x.du));
        if before.len() < DRAIN_MIN.0 || bd < DRAIN_MIN.1 || bu <= 0.0 || recent.len() < DRAIN_NOW.0 || rd < DRAIN_NOW.1 || ru <= 0.0 {
            continue;
        }
        let (Some(first), Some(last)) = (recent.first(), recent.last()) else { continue };
        if acc.drain_seen.get(id).is_some_and(|seen| *seen >= last.at) {
            continue;
        }
        let usual = bd / bu;
        let ratio = rd / ru / usual;
        if ratio < DRAIN_RATIO || best.as_ref().is_some_and(|b| b.ratio >= ratio) {
            continue;
        }
        let failed: Vec<&DrainSample> = recent.iter().copied().filter(|x| x.failed).collect();
        best = Some(Drain {
            id: id.clone(),
            label: window_label(id, acc.windows.get(id).and_then(|w| w.ms)),
            ratio,
            since: first.at,
            runs: recent.len() as u32,
            units: ru,
            du: rd,
            usual,
            failed: DrainFailed { runs: failed.len() as u32, du: sum(&failed, |x| x.du) },
        });
    }
    best
}

/// What a unit of work takes of the window, from the runs so far (kept across resets), or None.
pub fn rate_of(acc: &Acc, id: &str) -> Option<f64> {
    acc.learn.get(id).filter(|l| l.du >= LEARN_MIN && l.units > 0.0).map(|l| l.du / l.units)
}

/// The phone's Drain watch notes: one per window per two hours, only with Drain watch on.
#[derive(Debug, Clone, Default)]
pub struct DrainNotes {
    sent: BTreeMap<String, i64>,
}

impl DrainNotes {
    /// Whether this drain's note goes now; if so it is marked sent.
    pub fn due(&mut self, key: &str, window: &str, watch_on: bool, now: i64) -> bool {
        if !watch_on {
            return false;
        }
        let k = format!("{key}:{window}");
        if self.sent.get(&k).is_some_and(|last| now - last < DRAIN_NOTE_MS) {
            return false;
        }
        self.sent.insert(k, now);
        true
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use wisp_budget_api::{LimitWindow, LimitsReport};

    use super::*;
    use crate::Budget;

    fn at(used: f64) -> LimitsReport {
        LimitsReport { windows: vec![LimitWindow { id: "five_hour".into(), used, resets_at: Some(30 * 24 * H), ms: Some(5 * H), slot: None }], ..LimitsReport::default() }
    }

    /// v1 test/budget.test.js "drain watch": two weeks of usual runs, then two recent runs that take four times the
    /// window for the same work; the phone hears once per two hours, and only with the watch on.
    #[test]
    fn runs_that_take_twice_their_usual_share_show_a_drain_and_the_phone_hears_once() {
        let mut b = Budget::load(Vec::new());
        let (mut used, mut t) = (0.0, H);
        // each run reads the windows as it starts and as it ends: what moved in between is its
        for _ in 0..6 {
            b.record("claude", "default", &at(used), t - 60_000);
            used += 0.01;
            b.record("claude", "default", &at(used), t);
            assert!(b.spend("claude", "default", 1.0, false, t).is_none(), "usual runs drain nothing");
            t += H;
        }
        t += 10 * H;
        let mut last = None;
        for failed in [false, true] {
            b.record("claude", "default", &at(used), t - 60_000);
            used += 0.04;
            b.record("claude", "default", &at(used), t);
            last = b.spend("claude", "default", 1.0, failed, t);
            t += 10 * 60_000;
        }
        let d = last.unwrap();
        assert_eq!((d.id.as_str(), d.runs, d.failed.runs), ("five_hour", 2, 1));
        assert!(d.ratio >= 3.9, "{}", d.ratio);
        let mut notes = DrainNotes::default();
        assert!(!notes.due("claude@default", &d.id, false, t), "off: no note");
        assert!(notes.due("claude@default", &d.id, true, t));
        assert!(!notes.due("claude@default", &d.id, true, t + H), "once per two hours");
        assert!(notes.due("claude@default", &d.id, true, t + 2 * H));
        assert!(b.dismiss_drain("claude", "default", &d.id, t));
        assert!(b.drain("claude", "default", t).is_none(), "dismissed until a later run shows it again");
    }
}
