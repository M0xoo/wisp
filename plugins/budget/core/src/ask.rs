//! Ask near the limit (v1 web/js/limit-hold.js and server/guard.js, design/hold.md): before a task or a follow-up
//! goes, how much of its account's windows it will likely take, and whether that crosses the line you set
//! (Settings → Usage, `budget.limitHold`: off | 80 | 90 | 95, default 90). Yours are refused until you say yes; an
//! automation's waits as a held turn.
//!
//! The estimate, in two halves: units of work (what past runs like this one took, p50 / p75 / p90 of the last 50;
//! a follow-up at least this task's own median), and the share of the window per unit (`Budget::rate`), never more
//! than the window's whole use over wisp's units in it. Runs going on the same account count at half their estimate.

use wisp_budget_api::WindowNow;

pub const LINES: [&str; 4] = ["off", "80", "90", "95"];
pub const DEFAULT: &str = "90";
/// After a yes, the next ask for that window comes at these, then not until the reset.
const STEPS: [f64; 2] = [0.95, 0.99];
const SAMPLES: usize = 50;
/// Runs of a kind before they say anything.
pub const CLASS_MIN: usize = 3;
pub const LOOKBACK_MS: i64 = 30 * 24 * 3_600_000;
/// No reset time: a held run looks again in an hour.
pub const UNKNOWN_RESET_MS: i64 = 3_600_000;

/// The setting as a share (0.9), or None when it's off. Anything unknown reads as the default.
pub fn line(setting: Option<&str>) -> Option<f64> {
    let v = setting.filter(|s| LINES.contains(s)).unwrap_or(DEFAULT);
    (v != "off").then(|| v.parse::<f64>().map(|p| p / 100.0).ok()).flatten()
}

/// The line for a window you already said yes to (at `acked`): the next step above it, or None.
pub fn next_line(line: Option<f64>, acked: f64) -> Option<f64> {
    let line = line?;
    if acked <= 0.0 {
        return Some(line);
    }
    std::iter::once(line).chain(STEPS).find(|x| *x > acked + 1e-9)
}

/// `[p50, p75, p90]` of the newest runs, or None with fewer than `min`.
pub fn spread(xs: &[f64], min: usize) -> Option<[f64; 3]> {
    if xs.len() < min || xs.is_empty() {
        return None;
    }
    let mut v: Vec<f64> = xs[xs.len().saturating_sub(SAMPLES)..].to_vec();
    v.sort_by(f64::total_cmp);
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let q = |p: f64| v[((v.len() as f64 * p).floor() as usize).min(v.len() - 1)];
    Some([q(0.5), q(0.75), q(0.9)])
}

fn median(xs: &[f64]) -> f64 {
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

/// A run wisp counted, for the estimate (v1 builds the same from every task's turns).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Run {
    pub at: i64,
    pub account: String,
    /// the task it was a turn of (a follow-up's estimate reads its own task's runs)
    #[serde(default)]
    pub session: String,
    pub units: f64,
    /// a task's first turn (else a follow-up)
    pub first: bool,
    /// inside a task you already said yes to (a subagent, wisp's own rounds, a compaction): counts for the
    /// window's use, not for what a run like yours takes
    #[serde(default)]
    pub inner: bool,
}

/// What the next run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    First,
    FollowUp,
}

/// A run's estimate in units, or None when wisp has nothing to go on. `mine`: this task's own runs' units.
pub fn units(runs: &[Run], kind: Kind, mine: &[f64]) -> Option<[f64; 3]> {
    let pick = |first: bool| runs.iter().filter(|r| !r.inner && r.first == first).map(|r| r.units).collect::<Vec<_>>();
    let first = spread(&pick(true), CLASS_MIN);
    if kind == Kind::First {
        return first;
    }
    let base = spread(&pick(false), CLASS_MIN).or(first);
    if mine.is_empty() {
        return base;
    }
    let m = median(mine);
    Some(base.map_or([m, m, m], |b| [b[0], b[1].max(m), b[2].max(m)]))
}

/// A launch's runs starting at once on one account are asked about as one (v1 guard.js `together`): the estimate
/// for `n` of them (Try it two ways' pair: 2). 0 or 1 is this run alone; runs already going are added apart.
pub fn together(units: Option<[f64; 3]>, n: u32) -> Option<[f64; 3]> {
    let n = f64::from(n.max(1));
    units.map(|u| u.map(|x| x * n))
}

/// Share of the window per unit: the learned rate, never more than the window's whole use over the units wisp ran
/// in it (that puts all of the window on wisp).
pub fn rate(learned: Option<f64>, w: &WindowNow, runs: &[Run], account: &str) -> Option<f64> {
    let r = learned?;
    let (Some(resets), Some(ms)) = (w.resets_at, w.ms) else { return Some(r) };
    if w.used <= 0.0 {
        return Some(r);
    }
    let start = resets - ms;
    let spent: f64 = runs.iter().filter(|x| x.account == account && x.at >= start).map(|x| x.units).sum();
    Some(if spent > 0.0 { r.min(w.used / spent) } else { r })
}

/// One window as the rule reads it: its line (after any yes), and what a run like this adds, as shares.
#[derive(Debug, Clone, PartialEq)]
pub struct Win {
    pub id: String,
    pub label: String,
    pub used: f64,
    pub resets_at: Option<i64>,
    pub line: Option<f64>,
    /// `[lo, mid, hi]` this run adds, running ones included
    pub est: [f64; 3],
}

/// The window a run would take past its line (the one nearest its limit when several would).
#[derive(Debug, Clone, PartialEq)]
pub struct Hold {
    pub id: String,
    pub label: String,
    pub used: f64,
    /// where it would end up, low and high
    pub to: [f64; 2],
    pub resets_at: Option<i64>,
    pub line: f64,
}

pub fn hold_for(windows: &[Win]) -> Option<Hold> {
    let mut out: Option<(f64, Hold)> = None;
    for w in windows {
        let Some(line) = w.line.filter(|l| *l > 0.0) else { continue };
        if !w.used.is_finite() {
            continue;
        }
        let at = w.used + w.est[1];
        if at < line || out.as_ref().is_some_and(|(o, _)| at <= *o) {
            continue;
        }
        out = Some((
            at,
            Hold {
                id: w.id.clone(),
                label: w.label.clone(),
                used: w.used,
                to: [(w.used + w.est[0]).min(1.0), (w.used + w.est[2]).min(1.0)],
                resets_at: w.resets_at,
                line,
            },
        ));
    }
    out.map(|(_, h)| h)
}

/// How a window would end up: "about 93%", "88–96%" or "past the limit".
#[allow(clippy::cast_possible_truncation)]
pub fn hold_to(h: &Hold) -> String {
    let (lo, hi) = ((h.to[0] * 100.0).floor() as i64, (h.to[1] * 100.0).floor() as i64);
    if lo >= 100 {
        return "past the limit".into();
    }
    if hi - lo > 2 {
        return format!("{lo}–{}%", hi.min(100));
    }
    format!("about {}%", hi.min(99))
}

/// The refusal, for whoever has no card (the CLI, MCP, the API).
#[allow(clippy::cast_possible_truncation)]
pub fn message(h: &Hold) -> String {
    let pct = |x: f64| format!("{}%", (x * 100.0).floor() as i64);
    let where_ = if h.used >= 1.0 {
        "is used up".to_owned()
    } else if h.to[1] - h.used < 0.005 {
        format!("is at {}", pct(h.used))
    } else {
        let to = hold_to(h);
        format!("is at {}; this would likely take it {}", pct(h.used), if to == "past the limit" { to } else { format!("to {to}") })
    };
    format!(
        "{} usage window {where_}, past your {} line (Settings → Usage → Ask near the limit). Send it again with confirmLimit: true (the CLI: --yes) to go ahead anyway, only if the user agreed.",
        h.label,
        pct(h.line)
    )
}

/// When a held run goes by itself: its window's reset, or in an hour when that isn't known.
pub fn until(h: &Hold, now: i64) -> i64 {
    h.resets_at.filter(|r| *r > now).unwrap_or(now + UNKNOWN_RESET_MS)
}

/// The windows for the rule: each with its line after any yes (`acked`), and est = (units + running) × rate.
pub fn windows(
    list: &[WindowNow],
    line: Option<f64>,
    units: Option<[f64; 3]>,
    running_units: f64,
    rate: &dyn Fn(&WindowNow) -> Option<f64>,
    acked: &dyn Fn(&WindowNow) -> f64,
) -> Vec<Win> {
    list.iter()
        .map(|w| {
            let est = rate(w).map_or([0.0; 3], |r| units.unwrap_or([0.0; 3]).map(|x| (x + running_units) * r));
            Win { id: w.id.clone(), label: w.label.clone(), used: w.used, resets_at: w.resets_at, line: next_line(line, acked(w)), est }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1 guard.js `together`: a trial's two runs on one account cross a line one run alone stays under.
    #[test]
    fn runs_starting_together_on_one_account_are_summed_so_a_trial_asks_where_one_run_would_not_v1_together() {
        let list = [WindowNow { id: "5h".into(), label: "5-hour".into(), used: 0.75, resets_at: None, ms: None }];
        let one = Some([0.1, 0.1, 0.1]);
        let wins = |u| windows(&list, Some(0.9), u, 0.0, &|_| Some(1.0), &|_| 0.0);
        assert!(hold_for(&wins(together(one, 1))).is_none(), "one run: 85%, under the line");
        assert!(hold_for(&wins(together(one, 0))).is_none(), "0 is one run");
        let h = hold_for(&wins(together(one, 2))).unwrap();
        assert!((h.to[0] - 0.95).abs() < 1e-9, "both runs: 95%, past 90%: {h:?}");
        assert_eq!(together(None, 2), None, "nothing learned yet: nothing to sum");
    }

    fn run(units: f64, first: bool) -> Run {
        Run { at: 0, account: "default".into(), session: "t".into(), units, first, inner: false }
    }

    /// v1 test/limit-hold.test.js: the line, the steps after a yes, and the window nearest its limit.
    #[test]
    fn a_run_that_would_cross_your_line_is_asked_about_and_a_yes_moves_the_line_up() {
        assert_eq!((line(None), line(Some("off")), line(Some("80")), line(Some("x"))), (Some(0.9), None, Some(0.8), Some(0.9)));
        assert_eq!(next_line(Some(0.9), 0.0), Some(0.9));
        assert_eq!(next_line(Some(0.9), 0.9), Some(0.95));
        assert_eq!(next_line(Some(0.9), 0.95), Some(0.99));
        assert_eq!(next_line(Some(0.9), 0.99), None, "then not until the reset");
        let w = |id: &str, used: f64, mid: f64| Win {
            id: id.into(),
            label: id.into(),
            used,
            resets_at: Some(9),
            line: Some(0.9),
            est: [mid / 2.0, mid, mid * 2.0],
        };
        assert!(hold_for(&[w("5h", 0.5, 0.1)]).is_none(), "60%: under the line");
        let h = hold_for(&[w("5h", 0.85, 0.06), w("week", 0.88, 0.04)]).unwrap();
        assert_eq!(h.id, "week", "the one nearest its limit");
        assert_eq!(hold_to(&h), "90–96%");
        assert!(message(&h).starts_with("week usage window is at 88%; this would likely take it to 90–96%, past your 90% line"));
        let full = Hold { id: "5h".into(), label: "5-hour".into(), used: 1.0, to: [1.0, 1.0], resets_at: None, line: 0.9 };
        assert!(message(&full).contains("is used up"));
        assert_eq!(until(&full, 100), 100 + UNKNOWN_RESET_MS);
    }

    #[test]
    fn the_estimate_is_what_runs_like_this_took_and_a_follow_up_at_least_this_tasks_median() {
        let runs: Vec<Run> = [1.0, 2.0, 3.0, 4.0]
            .into_iter()
            .map(|u| run(u, true))
            .chain([run(0.5, false), Run { inner: true, ..run(50.0, false) }])
            .collect();
        assert_eq!(units(&runs, Kind::First, &[]), Some([3.0, 4.0, 4.0]));
        assert_eq!(
            units(&runs, Kind::FollowUp, &[]),
            Some([3.0, 4.0, 4.0]),
            "too few follow-ups: the first runs'; a subagent's never counts"
        );
        assert_eq!(units(&runs, Kind::FollowUp, &[6.0]), Some([3.0, 6.0, 6.0]), "this task's runs are big");
        assert_eq!(units(&runs[..2], Kind::First, &[]), None, "nothing to go on yet");
        let w = WindowNow { id: "5h".into(), label: "5-hour".into(), used: 0.5, resets_at: Some(10), ms: Some(10) };
        assert_eq!(
            rate(Some(0.2), &w, &runs, "default"),
            Some(0.2f64.min(0.5 / 60.5)),
            "never more than the window's use over wisp's units"
        );
        assert_eq!(rate(None, &w, &runs, "default"), None);
        let ws = windows(&[w], Some(0.9), Some([1.0, 2.0, 3.0]), 1.0, &|_| Some(0.1), &|_| 0.0);
        assert!(ws[0].est.iter().zip([0.2, 0.3, 0.4]).all(|(a, b)| (a - b).abs() < 1e-9), "{:?}", ws[0].est);
    }
}
