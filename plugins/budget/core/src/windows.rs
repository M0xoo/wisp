//! The plan's usage windows (v1 server/budget.js:37-116, 666-682): names, the Automations stop at
//! choices, and the small pure rules every side shares.

use std::collections::BTreeMap;

use wisp_budget_api::{Drain, UNATTENDED_BY, settings};

pub const H: i64 = 3_600_000;
pub const MIN: i64 = 60_000;
/// Two readings closer than this are the same period: Codex's "resets in n s" drifts (budget.js:58).
pub const SAME_PERIOD_MS: i64 = 10 * MIN;
/// At or past this share a window is full (`resetAt`, budget.js:472).
pub const FULL: f64 = 0.995;

/// What wisp calls each known window, and how long it is when the CLI doesn't say.
const KNOWN: [(&str, &str, i64); 4] = [
    ("five_hour", "5-hour", 5 * H),
    ("seven_day", "Weekly", 7 * 24 * H),
    ("seven_day_opus", "Weekly Opus", 7 * 24 * H),
    ("seven_day_sonnet", "Weekly Sonnet", 7 * 24 * H),
];

/// The length of a window wisp knows by name.
pub fn known_ms(id: &str) -> Option<i64> {
    KNOWN.iter().find(|(k, _, _)| *k == id).map(|(_, _, ms)| *ms)
}

/// Windows wisp knows first, in their order; the rest after.
pub fn rank(id: &str) -> usize {
    KNOWN.iter().position(|(k, _, _)| *k == id).unwrap_or(KNOWN.len())
}

/// A window wisp has no name for, by its length: "30-day", "12-hour".
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn label_of(ms: Option<i64>) -> String {
    match ms {
        Some(ms) if ms > 0 => {
            if ms >= 24 * H {
                format!("{}-day", (ms as f64 / (24 * H) as f64).round() as i64)
            } else {
                format!("{}-hour", (ms as f64 / H as f64).round() as i64)
            }
        }
        _ => "Usage".to_owned(),
    }
}

pub fn window_label(id: &str, ms: Option<i64>) -> String {
    KNOWN.iter().find(|(k, _, _)| *k == id).map_or_else(|| label_of(ms), |(_, l, _)| (*l).to_owned())
}

/// Settings → Usage → Automations stop at: 'off', or the percent of a window.
pub const STOP_AT: [&str; 4] = ["off", "50", "75", "90"];
/// A harness's own row adds 'same': follow Automations stop at.
pub const STOP_BY: [&str; 5] = ["same", "off", "50", "75", "90"];

/// The line a setting value draws (0..1), or None: off, unset or not one of the choices.
pub fn stop_at_of(v: Option<&str>) -> Option<f64> {
    match v? {
        "50" => Some(0.5),
        "75" => Some(0.75),
        "90" => Some(0.9),
        _ => None,
    }
}

/// The settings key of a harness's own line (budget.js:51).
pub fn stop_key(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some(settings::AUTO_STOP_CLAUDE),
        "codex" => Some(settings::AUTO_STOP_CODEX),
        _ => None,
    }
}

/// One harness's line: its own if it is one of the choices ('off' included), else Automations stop
/// at: 'same', unset or an unknown value falls back (budget.js:53-56, edge case Top-10 #1).
pub fn stop_for(defaults: &BTreeMap<String, String>, agent: &str) -> Option<f64> {
    let own = stop_key(agent).and_then(|k| defaults.get(k)).map(String::as_str).filter(|v| STOP_AT.contains(v));
    stop_at_of(own.or_else(|| defaults.get(settings::AUTO_STOP).map(String::as_str)))
}

/// Two reports of the same window period (budget.js:58).
pub fn same_period(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) if a != 0 && b != 0 => (a - b).abs() < SAME_PERIOD_MS,
        _ => false,
    }
}

/// A window that reset before its time (a banked reset, budget.js:61-62): its old reset hadn't come,
/// the new one is more than 10 minutes later, and use fell by 25 points, or from 10%+ to under 5%.
pub fn reset_early(was: Option<(f64, Option<i64>)>, next: (f64, Option<i64>), now: i64) -> bool {
    let Some((was_used, Some(was_at))) = was else { return false };
    let (used, Some(at)) = next else { return false };
    if was_at <= now || at - was_at <= SAME_PERIOD_MS {
        return false;
    }
    was_used - used >= 0.25 || (used < 0.05 && was_used >= 0.1)
}

/// When you'd use the whole window at the pace since it started, or None: not before the reset,
/// already used up, or too early to tell (under 5% gone, or the first half hour) (budget.js:102).
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn pace_of(used: f64, resets_at: Option<i64>, ms: Option<i64>, now: i64) -> Option<i64> {
    let (ms, resets_at) = (ms.filter(|m| *m > 0)?, resets_at.filter(|r| *r > now)?);
    if used <= 0.0 || used >= 1.0 || used < 0.05 {
        return None;
    }
    let spent = now - (resets_at - ms);
    if spent < (ms / 10).min(H / 2) {
        return None;
    }
    let at = (now as f64 + (1.0 - used) * spent as f64 / used).round() as i64;
    (at < resets_at).then_some(at)
}

/// A run's stats as harnesses store them, the fields `units_of` reads.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct UnitStats {
    pub cost_usd: Option<f64>,
    pub input_tokens: f64,
    pub cached_input_tokens: f64,
    pub output_tokens: f64,
    /// a brought-in chat's first turn: no cost of its own
    pub baseline: bool,
}

/// A run's units of work: its cost where the harness says it, else its tokens in millions.
pub fn units_of(s: &UnitStats) -> f64 {
    if s.baseline {
        return 0.0;
    }
    if let Some(c) = s.cost_usd.filter(|c| *c > 0.0) {
        return c;
    }
    let tokens = s.input_tokens - s.cached_input_tokens + s.output_tokens;
    if tokens > 0.0 { tokens / 1e6 } else { 0.0 }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or_else(String::new, |f| f.to_lowercase().chain(c).collect())
}

#[allow(clippy::cast_possible_truncation)]
fn pct(x: f64) -> String {
    format!("{}%", (x * 100.0).round() as i64)
}

/// What holds the work back, after "Waits for your plan:" (budget.js:668):
/// "Claude Code’s weekly window is at 78%, past your 75%".
pub fn hold_why(label: &str, used: f64, stop: f64, name: &str, account_label: &str) -> String {
    let who = if account_label.is_empty() { name.to_owned() } else { format!("{name} ({account_label})") };
    format!("{who}’s {} window is at {}, past your {}", lower_first(label), pct(used), pct(stop))
}

/// Drain watch's units in words: dollars where the runs reported their cost (Claude Code), else millions of
/// tokens. `in_usd` comes from what was counted, so no harness is named here.
pub fn unit_words(in_usd: bool, u: f64) -> String {
    if in_usd {
        format!("${u:.2}")
    } else if u >= 0.1 {
        format!("{u:.1}M tokens")
    } else {
        format!("{u:.2}M tokens")
    }
}

/// "14:05" for ms since the epoch at a UTC offset in minutes (core has no time zone of its own).
pub fn clock_words(at: i64, offset_min: i32) -> String {
    let local = at + i64::from(offset_min) * MIN;
    let mins = local.rem_euclid(24 * H) / MIN;
    format!("{:02}:{:02}", mins / 60, mins % 60)
}

/// Drain watch's words for the phone (budget.js:676).
pub fn drain_why(d: &Drain, name: &str, account_label: &str, in_usd: bool, offset_min: i32) -> String {
    let who = if account_label.is_empty() { name.to_owned() } else { format!("{name} ({account_label})") };
    let failed = if d.failed.runs > 0 {
        format!(" {} of them ended in an error and still took {}.", d.failed.runs, pct(d.failed.du))
    } else {
        String::new()
    };
    format!(
        "Since {}, {} runs took {} of {who}’s {} window for {} of work: {:.1}× its usual share per unit of work over the last two weeks.{failed} Settings → Usage → Plan budget has the details and Copy report.",
        clock_words(d.since, offset_min),
        d.runs,
        pct(d.du),
        lower_first(&d.label),
        unit_words(in_usd, d.units),
        d.ratio,
    )
}

/// Drain watch's phone title (index.js:155).
pub fn drain_title(d: &Drain, name: &str) -> String {
    format!("⚠️ {name} is using your plan {:.1}× faster", d.ratio)
}

/// The phone's note when a plan reset early and the runs held for it start (v1 index.js `app.resetEarly`), for when
/// wisp.later is off and can't send it (with later on, later sends it, counting its follow-ups too; the same words as
/// `wisp_later_core::rules::early_note`). `label`: the account's when not the default. None when nothing started.
pub fn early_note(name: &str, label: &str, n: u32) -> Option<(String, String)> {
    if n == 0 {
        return None;
    }
    let label = if label.is_empty() { String::new() } else { format!(" ({label})") };
    let (s, verb) = if n == 1 { ("", "starts") } else { ("s", "start") };
    Some((format!("\u{21bb} {name}{label} reset early"), format!("Its plan reset before its time. {n} task{s} waiting on it {verb} now.")))
}

/// Nobody started it by hand: Automations stop at may hold it.
pub fn unattended(by: Option<&str>) -> bool {
    by.is_some_and(|b| UNATTENDED_BY.contains(&b))
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    /// The unit follows what was counted (a run's cost, or its tokens), never a harness's name.
    #[test]
    fn drain_units_are_dollars_when_runs_reported_their_cost_else_tokens() {
        assert_eq!(unit_words(true, 1.234), "$1.23");
        assert_eq!(unit_words(false, 1.25), "1.2M tokens");
        assert_eq!(unit_words(false, 0.05), "0.05M tokens");
    }
}
