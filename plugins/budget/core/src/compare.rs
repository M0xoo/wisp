//! Compare's numbers (v1 web/js/compare-metrics.js, "Try it two ways"): what each run of a task took
//! over all its turns, its plan share when runs overlap on one account (`plan_shares`), and a neutral
//! sentence against the first run. Pure: the page and the server read it as is.

use crate::plan_shares::{DASH, plan_shares};
use crate::receipt::{js_round, longest_first, pct, token_words};
use crate::work::{RunLike, TurnLike, by_age, letter, listed, own, tidy, turn_plan, work_of};

const STEP_KINDS: [&str; 7] = ["run", "tool", "read", "edit", "agent", "web", "search"];
/// A difference under this share says nothing about one run each.
const NEAR: f64 = 0.05;
const NEAR_MS: f64 = 5000.0;
pub const NOISE: &str = "One run each: the same setup varies run to run.";

fn is_live(s: &RunLike) -> bool {
    matches!(s.state.as_deref(), Some("running" | "waiting"))
}

/// Try it two ways: a run's variant in words. Its subagents on the task's model only say so when the
/// setting would have them on another.
pub fn variant_words(subagent_model: Option<&str>, skills: Option<&str>, setting: &str) -> Vec<String> {
    let mut out = Vec::new();
    match subagent_model {
        Some(m) if !m.is_empty() => out.push(format!("Subagents on {}", subagent_name(m))),
        Some(_) if !setting.is_empty() => out.push("Subagents on task’s model".to_owned()),
        _ => {}
    }
    if skills == Some("off") {
        out.push("Skills off".to_owned());
    }
    out
}

fn subagent_name(m: &str) -> String {
    match m {
        "haiku" => "Haiku".into(),
        "sonnet" => "Sonnet".into(),
        "fable" => "Fable".into(),
        _ => m.to_owned(),
    }
}

fn level(e: &str) -> String {
    match e {
        "" => "Default".into(),
        "xhigh" => "X-High".into(),
        _ => {
            let mut c = e.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    }
}

/// How `differs_words` names values; each defaults to the value itself.
pub struct DiffNames<'a> {
    pub agent: &'a dyn Fn(&str) -> String,
    pub model: &'a dyn Fn(&str) -> String,
    pub account: &'a dyn Fn(&str) -> String,
    pub task_model: &'a str,
}

impl std::fmt::Debug for DiffNames<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiffNames").field("task_model", &self.task_model).finish_non_exhaustive()
    }
}

/// `session.trial.differs` in words: "Subagents: Opus → Haiku · Skills: on → off".
pub fn differs_words(differs: &[(String, Vec<String>)], names: &DiffNames<'_>) -> String {
    if differs.is_empty() {
        return "Same setup on both runs".into();
    }
    let word = |key: &str, x: &str| -> String {
        match key {
            "agent" => (names.agent)(x),
            "model" | "account" if x.is_empty() => "Default".into(),
            "model" => (names.model)(x),
            "effort" => level(x),
            "account" => (names.account)(x),
            "subagentModel" if x.is_empty() => names.task_model.to_owned(),
            "subagentModel" => subagent_name(x),
            _ => x.to_owned(),
        }
    };
    let label = |key: &str| -> String {
        match key {
            "agent" => "Harness".into(),
            "model" => "Model".into(),
            "effort" => "Thinking".into(),
            "account" => "Account".into(),
            "subagentModel" => "Subagents".into(),
            "skills" => "Skills".into(),
            _ => key.to_owned(),
        }
    };
    differs
        .iter()
        .map(|(k, vs)| format!("{}: {}", label(k), vs.iter().map(|v| word(k, v)).collect::<Vec<_>>().join(" → ")))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// What the page's fmtDuration writes.
#[allow(clippy::cast_precision_loss)]
fn duration(ms: f64) -> String {
    let s = js_round(ms / 1000.0);
    if s < 1 {
        return format!("{}ms", js_round(ms));
    }
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 { format!("{m}m {:02}s", s % 60) } else { format!("{}h {}m", m / 60, m % 60) }
}

/// The same in a sentence: "40s", "3 min", "1h 5m".
#[allow(clippy::cast_precision_loss)]
fn span_words(ms: f64) -> String {
    let s = js_round(ms / 1000.0);
    if s < 60 {
        return format!("{s}s");
    }
    let m = js_round(s as f64 / 60.0);
    if m < 60 { format!("{m} min") } else { format!("{}h {}m", m / 60, m % 60) }
}

/// Lines added and removed by a file's edits (v1 web/js/diff.js countChanges, an LCS line diff).
pub fn count_changes(edits: &[(String, String)]) -> (usize, usize) {
    let (mut add, mut del) = (0, 0);
    for (before, after) in edits {
        let a: Vec<&str> = if before.is_empty() { Vec::new() } else { before.split('\n').collect() };
        let b: Vec<&str> = if after.is_empty() { Vec::new() } else { after.split('\n').collect() };
        let mut start = 0;
        while start < a.len() && start < b.len() && a[start] == b[start] {
            start += 1;
        }
        let (mut end_a, mut end_b) = (a.len(), b.len());
        while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
            end_a -= 1;
            end_b -= 1;
        }
        let (n, m) = (end_a - start, end_b - start);
        let common = if n * m > 4_000_000 { 0 } else { lcs(&a[start..end_a], &b[start..end_b]) };
        add += m - common;
        del += n - common;
    }
    (add, del)
}

fn lcs(a: &[&str], b: &[&str]) -> usize {
    let mut prev = vec![0usize; b.len() + 1];
    for x in a.iter().rev() {
        let mut cur = vec![0usize; b.len() + 1];
        for j in (0..b.len()).rev() {
            cur[j] = if *x == b[j] { prev[j + 1] + 1 } else { prev[j].max(cur[j + 1]) };
        }
        prev = cur;
    }
    prev[0]
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tests {
    pub passed: i64,
    pub failed: i64,
}

#[allow(clippy::cast_possible_truncation)]
fn tests_of(t: Option<&TurnLike>) -> Option<Tests> {
    let blocks: Vec<_> = t?.presentation.as_ref()?.blocks.iter().filter(|b| b.kind == "tests").collect();
    if blocks.is_empty() {
        return None;
    }
    let num =
        |v: &Option<serde_json::Value>| v.as_ref().and_then(serde_json::Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0) as i64;
    Some(Tests { passed: blocks.iter().map(|b| num(&b.passed)).sum(), failed: blocks.iter().map(|b| num(&b.failed)).sum() })
}

#[allow(clippy::cast_precision_loss)]
fn time_of(t: &TurnLike) -> Option<f64> {
    if t.status() == "running" {
        return None;
    }
    if let Some(d) = t.stats.as_ref().and_then(|s| s.duration_ms).filter(|d| *d > 0.0) {
        return Some(d);
    }
    t.ended_at.map(|e| (e - t.started_at.unwrap_or(0)) as f64)
}

/// One run's numbers (v1 `runMetrics`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunMetrics {
    pub id: Option<String>,
    pub agent: Option<String>,
    pub created_at: Option<i64>,
    pub live: bool,
    pub time: Option<f64>,
    pub cost: Option<f64>,
    pub cost_partial: bool,
    pub tokens: Option<f64>,
    pub cache: Option<f64>,
    pub steps: Option<usize>,
    /// (window, used), longest window first
    pub plan: Vec<(String, f64)>,
    pub files: usize,
    pub add: usize,
    pub del: usize,
    pub tests: Option<Tests>,
    pub asks: usize,
    pub follow_ups: usize,
    pub unfinished: bool,
}

/// Time, cost, tokens and steps over its turns; files, tests and asks from its last.
pub fn run_metrics(s: &RunLike) -> RunMetrics {
    let turns = own(s);
    let work = work_of(s);
    let mut m =
        RunMetrics { id: s.id.clone(), agent: s.agent.clone(), created_at: s.created_at, live: is_live(s), ..RunMetrics::default() };
    let (mut read, mut cached, mut output, mut missing) = (0.0, 0.0, 0.0, false);
    for (i, t) in &turns {
        if let Some(ms) = time_of(t) {
            m.time = Some(m.time.unwrap_or(0.0) + ms);
        }
        let w = work.get(i);
        match w.and_then(|w| w.cost) {
            Some(c) => m.cost = Some(tidy(m.cost.unwrap_or(0.0) + c)),
            None if w.is_some() && t.status() != "running" && t.ended_at.is_some_and(|e| e != 0) => missing = true,
            None => {}
        }
        if let Some(w) = w {
            read += w.tokens.read;
            cached += w.tokens.cached;
            output += w.tokens.output;
        }
        let steps = t.activity.iter().filter(|a| STEP_KINDS.contains(&a.kind.as_str())).count() + t.trimmed.unwrap_or(0) as usize;
        m.steps = Some(m.steps.unwrap_or(0) + steps);
        for p in turn_plan(t).into_iter().filter(|p| !p.window.is_empty() && p.used > 0.0) {
            match m.plan.iter_mut().find(|(w, _)| *w == p.window) {
                Some((_, u)) => *u += p.used,
                None => m.plan.push((p.window, p.used)),
            }
        }
    }
    m.plan.sort_by(|a, b| longest_first(&a.0, &b.0));
    let last = turns.last().map(|(_, t)| *t);
    let edits = |c: &crate::work::Change| c.edits.iter().map(|e| (e.before.clone(), e.after.clone())).collect::<Vec<_>>();
    for c in last.map(|t| t.changes.as_slice()).unwrap_or_default() {
        let (a, d) = count_changes(&edits(c));
        m.add += a;
        m.del += d;
    }
    m.cost_partial = m.cost.is_some() && missing;
    m.tokens = Some(read + output).filter(|x| *x != 0.0);
    // As on the receipt: a harness that doesn't report cached tokens has no cache number, not 0%.
    m.cache = (read != 0.0 && cached != 0.0).then(|| cached / read);
    m.files = last.map_or(0, |t| t.changes.len());
    m.tests = tests_of(last);
    m.asks = last.map_or(0, |t| t.activity.iter().filter(|a| a.kind == "ask").count());
    m.follow_ups = turns.iter().skip(1).filter(|(_, t)| !matches!(t.by.as_deref(), Some("wisp" | "compact"))).count(); // yours, as in the task's summary
    m.unfinished = !m.live && last.is_some_and(|t| matches!(t.status(), "error" | "stopped"));
    m
}

/// "62% fewer tokens": a percent, never the 100% of a number that isn't gone.
fn change(a: f64, b: f64) -> i64 {
    let by = js_round((b - a).abs() / a * 100.0);
    if b < a { by.min(99) } else { by }
}

fn deltas(a: &RunMetrics, b: &RunMetrics, name: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let (at, bt) = (a.tokens.unwrap_or(0.0), b.tokens.unwrap_or(0.0));
    let tokens = at > 0.0 && bt > 0.0;
    if tokens && (bt - at).abs() / at >= NEAR {
        parts.push(format!("used {}% {} tokens", change(at, bt), if bt < at { "fewer" } else { "more" }));
    }
    if let (Some(ac), Some(bc)) = (a.cost, b.cost)
        && ac > 0.0
        && (bc - ac).abs() / ac >= NEAR
    {
        parts.push(format!("cost {}% {}", change(ac, bc), if bc < ac { "less" } else { "more" }));
    }
    let time = a.time.zip(b.time);
    if let Some((x, y)) = time
        && (y - x).abs() >= NEAR_MS
    {
        parts.push(format!("took {} {}", span_words((y - x).abs()), if y < x { "less" } else { "longer" }));
    }
    if !parts.is_empty() {
        return format!("{name} {} than A.", listed(&parts));
    }
    if tokens && time.is_some() { format!("{name} used about the same tokens and time as A.") } else { String::new() }
}

/// What can honestly be said against run A, in numbers only.
pub fn compare_sentence(list: &[RunLike]) -> String {
    compare_sentence_of(&list.iter().map(run_metrics).collect::<Vec<_>>())
}

/// The same from metrics already worked out.
pub fn compare_sentence_of(list: &[RunMetrics]) -> String {
    let runs = by_age(list, |m| m.created_at.unwrap_or(0));
    let Some((a, rest)) = runs.split_first() else { return String::new() };
    let mut said: Vec<String> = Vec::new(); // a clause several runs share is said once
    let mut say = |s: String| {
        if !s.is_empty() && !said.contains(&s) {
            said.push(s);
        }
    };
    for (i, b) in rest.iter().enumerate() {
        let name = letter(i + 1);
        if a.live || b.live {
            continue;
        }
        if a.unfinished || b.unfinished {
            let who: Vec<String> =
                [a.unfinished.then(|| "A".to_owned()), b.unfinished.then(|| name.clone())].into_iter().flatten().collect();
            say(format!("{} didn't finish, so there's no comparison.", listed(&who)));
        } else if a.follow_ups != b.follow_ups {
            say(format!("{name} had a different number of follow-ups, so it isn't the same work."));
        } else if a.agent != b.agent {
            say("Different harnesses count differently, so there's no ratio.".to_owned());
        } else {
            say(deltas(a, b, &name));
        }
    }
    let done: Vec<&RunMetrics> = runs.iter().filter(|r| !r.live && !r.unfinished).collect();
    let passed = done.first().and_then(|r| r.tests).map_or(0, |t| t.passed);
    if !runs.iter().any(|r| r.live)
        && done.len() > 1
        && passed > 0
        && done.iter().all(|r| r.tests.is_some_and(|t| t.failed == 0 && t.passed == passed))
    {
        let all = if done.len() == 2 { "Both".to_owned() } else { format!("All {}", done.len()) };
        say(format!("{all} passed {passed} test{}.", if passed == 1 { "" } else { "s" }));
    }
    if said.is_empty() {
        return String::new();
    }
    said.push(NOISE.to_owned());
    said.join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareCell {
    pub html: String,
    pub tip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareRow {
    pub key: &'static str,
    pub label: &'static str,
    pub tip: Option<&'static str>,
    pub cells: Vec<CompareCell>,
}

fn files_html(m: &RunMetrics) -> String {
    format!("{} <span class=\"plus\">+{}</span> <span class=\"minus\">−{}</span>", m.files, m.add, m.del)
}

fn tests_html(t: Tests) -> String {
    let failed = if t.failed > 0 { format!(" {} ✗", t.failed) } else { String::new() };
    format!("<span class=\"{}\">{} ✓{failed}</span>", if t.failed > 0 { "minus" } else { "plus" }, t.passed)
}

/// The table: the same rows in the same order whatever the runs hold, so nothing jumps while they
/// work. The cells are markup the page's Compare table renders as is (v1's exact strings).
pub fn compare_rows(sessions: &[RunLike], now: i64) -> Vec<CompareRow> {
    let sorted = by_age(sessions, |s| s.created_at.unwrap_or(0));
    let metrics: Vec<RunMetrics> = sorted.iter().map(run_metrics).collect();
    let (plan, _) = plan_shares(sessions, now);
    let row =
        |key: &'static str, label: &'static str, tip: Option<&'static str>, f: &dyn Fn(usize, &RunMetrics) -> Option<String>| CompareRow {
            key,
            label,
            tip,
            cells: metrics
                .iter()
                .enumerate()
                .map(|(i, m)| CompareCell { html: f(i, m).unwrap_or_else(|| DASH.to_owned()), tip: None })
                .collect(),
        };
    let mut rows = vec![
        row("time", "Time", None, &|_, m| m.time.map(duration)),
        row("cost", "Cost", None, &|_, m| m.cost.map(|c| format!("${c:.2}"))),
        row("tokens", "Tokens", None, &|_, m| m.tokens.map(token_words)),
        row("cache", "Cache", None, &|_, m| m.cache.map(pct)),
        row("steps", "Agent steps", Some("Tools the agent used: commands, reads, edits, searches"), &|_, m| m.steps.map(|s| s.to_string())),
        row("plan", "Plan", None, &|i, _| plan.get(i).map(|c| c.text.clone())),
        row("files", "Files", None, &|_, m| Some(files_html(m))),
        row("tests", "Tests", None, &|_, m| m.tests.map(tests_html)),
        row("asks", "Asked", None, &|_, m| Some(m.asks.to_string())),
    ];
    for r in &mut rows {
        for (i, c) in r.cells.iter_mut().enumerate() {
            c.tip = match r.key {
                "cost" if metrics.get(i).is_some_and(|m| m.cost_partial) => Some("Some turns reported no cost".to_owned()),
                "plan" => plan.get(i).map(|p| p.tip.clone()).filter(|t| !t.is_empty()),
                _ => None,
            };
        }
    }
    rows
}

#[cfg(test)]
mod fable_tests {
    use super::*;

    #[test]
    fn budget_labels_fable() {
        assert_eq!(subagent_name("fable"), "Fable");
        let names = DiffNames { agent: &|x| x.to_owned(), model: &|x| x.to_owned(), account: &|x| x.to_owned(), task_model: "Opus" };
        let words = differs_words(&[("subagentModel".to_owned(), vec!["fable".to_owned(), "haiku".to_owned()])], &names);
        assert_eq!(words, "Subagents: Fable → Haiku");
    }
}
