//! A trigger as code (ADR-0043): the `trigger` resource kind is the only declaration, written alike by the
//! app, the CLI (`wisp trigger add`), MCP and formulas. `on` names a source (`schedule`, `webhook`,
//! `manual`, a durable event type like `task.finished` or `pr.opened`, or a `trigger.source@1` source's);
//! the source's own fields go in `match` (the flat `project`, `branch`, `label` and `users` are read as
//! filters too). Then what it does (`target`), and when (`if`, `when`, `debounce`, `concurrency`, `rate`,
//! `budget`, `cooldown`, `approval`).

use std::collections::BTreeMap;


use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A trigger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerSpec {
    /// the source: `schedule`, `once`, `webhook`, `manual`, or an event type (`task.finished`, `pr.opened`, `chat.message`, …)
    pub on: String,
    // ---- what it does (the target) ----
    /// the declared task it starts (its `{params}` from the event)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub task: String,
    /// or a prompt of its own: `{event.summary}`, `{event.payload.x}` are filled in
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt: String,
    /// a crew member gets the work instead (a wake)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crew: String,
    /// or a workflow runs, with the event as its input
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workflow: String,
    /// or a follow-up to the task the event came from
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub follow_up: bool,
    /// the project it watches, and the folder its task runs in
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    /// plan | edits | auto
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    // ---- the source's fields ----
    /// schedule: a cron or words ("every weekday at 9")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cron: String,
    /// schedule and `when`: an IANA zone ("Europe/Zurich"); this computer's by default
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tz: String,
    /// once: when (ms since the epoch)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// an issue's or PR's label
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// minutes between polls (a polled source)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<u32>,
    /// webhook: its secret, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    /// chat.message: who may (names or ids; `anyone` for an open channel)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub users: Vec<String>,
    /// any other field of the source, matched against the event's payload (a string, a glob, or a list)
    #[serde(default, rename = "match", skip_serializing_if = "BTreeMap::is_empty")]
    pub filters: BTreeMap<String, Value>,
    // ---- when it fires ----
    /// an expression over `event` (`event.payload.branch == 'main'`), as workflows' `if`
    #[serde(default, rename = "if", skip_serializing_if = "String::is_empty")]
    pub cond: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<When>,
    /// events within this window become one job listing them all ("10m", "30s")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub debounce: String,
    /// skip | queue | replace | parallel:<n> (skip by default)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub concurrency: String,
    /// at most this many runs: "5/h", "20/d"
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub rate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// after a failed run, wait this long before the next ("30m")
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cooldown: String,
    /// the job waits for a yes before it starts (never in Full auto)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approval: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// When a trigger may run: outside these, an event is skipped or queued until the window opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct When {
    /// mon tue wed thu fri sat sun (every day when empty)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<String>,
    /// "9-17" (local hours, start inclusive, end exclusive)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hours: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tz: String,
    /// skip (default) | queue
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub outside: String,
}

/// What a trigger may spend.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    /// USD a day, across its runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_day: Option<f64>,
    /// USD a run (the run is stopped past it, by wisp.budget's guard)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_run: Option<f64>,
}

impl TriggerSpec {
    pub fn on(&self) -> bool {
        self.enabled != Some(false)
    }
    /// The filters, the flat ones included.
    pub fn all_filters(&self) -> BTreeMap<String, Value> {
        let mut f = self.filters.clone();
        // a schedule, a one-off, a webhook or a manual fire names no project: its `project` is only where the
        // task runs (as a filter it refused every event they send)
        let own = matches!(self.on.as_str(), "schedule" | "once" | "webhook" | "manual");
        for (k, v) in [("project", &self.project), ("branch", &self.branch), ("label", &self.label)] {
            if !v.is_empty() && !f.contains_key(k) && (!own || k != "project") {
                f.insert(k.to_owned(), Value::String(v.clone()));
            }
        }
        f
    }
    /// What it does, in a word.
    pub fn target(&self) -> Target<'_> {
        if !self.crew.is_empty() {
            Target::Crew(&self.crew)
        } else if !self.workflow.is_empty() {
            Target::Workflow(&self.workflow)
        } else if self.follow_up {
            Target::FollowUp
        } else if !self.task.is_empty() {
            Target::Task(&self.task)
        } else {
            Target::Prompt(&self.prompt)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target<'a> {
    Task(&'a str),
    Prompt(&'a str),
    Crew(&'a str),
    Workflow(&'a str),
    FollowUp,
}

/// `30s`, `10m`, `2h`, `1d` → ms; `None` when it isn't one.
pub fn duration_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (n, unit) = s.split_at(s.len().checked_sub(1)?);
    let n: i64 = n.trim().parse().ok().filter(|n| *n >= 0)?;
    Some(n * match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    })
}

/// `5/h`, `20/d`, `2/m` → (count, window ms).
pub fn rate_of(s: &str) -> Option<(u32, i64)> {
    let (n, per) = s.trim().split_once('/')?;
    let n: u32 = n.trim().parse().ok().filter(|n| *n > 0)?;
    let w = match per.trim() {
        "m" | "min" | "minute" => 60_000,
        "h" | "hour" => 3_600_000,
        "d" | "day" => 86_400_000,
        _ => return None,
    };
    Some((n, w))
}

/// The problems a spec has beyond its schema.
pub fn check(s: &TriggerSpec) -> Vec<String> {
    let mut out = Vec::new();
    if s.on.trim().is_empty() {
        out.push("on: which source starts it".into());
    }
    // v1's kind names (`finished`, `ci`, …) are no source here: such a trigger would apply and never fire
    if let Some(v2) = crate::v1::on_of(&s.on).filter(|v2| *v2 != s.on) {
        out.push(format!("on: {} is v1's name; write {v2}", s.on));
    }
    if s.on == "schedule" && s.cron.trim().is_empty() {
        out.push("a schedule needs cron (\"every weekday at 9\" or 5 fields)".into());
    }
    if s.on == "schedule"
        && let Err(e) = crate::read_schedule(&s.cron)
    {
        out.push(e.0);
    }
    if s.on == "once" && s.at.is_none() {
        out.push("once needs at".into());
    }
    if s.on == "webhook" && s.secret.trim().is_empty() {
        out.push("a webhook needs a secret (${secret:NAME})".into());
    }
    if s.on == "chat.message" && s.users.is_empty() {
        out.push("chat.message needs users: the names that may start it, or anyone".into());
    }
    for (k, v) in [("debounce", &s.debounce), ("cooldown", &s.cooldown)] {
        if !v.is_empty() && duration_ms(v).is_none() {
            out.push(format!("{k}: a duration like 30s, 10m, 2h ({v})"));
        }
    }
    if !s.rate.is_empty() && rate_of(&s.rate).is_none() {
        out.push(format!("rate: like 5/h or 20/d ({})", s.rate));
    }
    let c = s.concurrency.as_str();
    if !(c.is_empty() || matches!(c, "skip" | "queue" | "replace") || c.strip_prefix("parallel:").is_some_and(|n| n.parse::<u32>().is_ok_and(|n| n > 0))) {
        out.push(format!("concurrency: skip, queue, replace or parallel:<n> ({c})"));
    }
    let targets = [!s.task.is_empty(), !s.crew.is_empty(), !s.workflow.is_empty(), s.follow_up].iter().filter(|x| **x).count();
    if targets > 1 {
        out.push("one target: task, crew, workflow or followUp".into());
    }
    if targets == 0 && s.prompt.trim().is_empty() {
        out.push("what it does: task, prompt, crew, workflow or followUp".into());
    }
    out
}

/// The triggers that wake each crew member, for `wisp crew graph` and the cycle check: (from member, to
/// member) for every `crew.reported` wake whose `member` filter names another member.
pub fn wake_edges(wakes: &[(String, TriggerSpec)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (to, w) in wakes {
        if w.on != "crew.reported" {
            continue;
        }
        let from: Vec<String> = match w.all_filters().get("member") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        for f in from {
            out.push((f, to.clone()));
        }
    }
    out
}

fn visit<'a>(n: &'a str, next: &BTreeMap<&'a str, Vec<&'a str>>, path: &mut Vec<&'a str>, done: &mut Vec<&'a str>) -> Option<Vec<String>> {
    if let Some(i) = path.iter().position(|p| *p == n) {
        let mut c: Vec<String> = path[i..].iter().map(|s| (*s).to_owned()).collect();
        c.push(n.to_owned());
        return Some(c);
    }
    if done.contains(&n) {
        return None;
    }
    path.push(n);
    for m in next.get(n).into_iter().flatten() {
        if let Some(c) = visit(m, next, path, done) {
            return Some(c);
        }
    }
    path.pop();
    done.push(n);
    None
}

/// A cycle of wakes (A wakes B wakes A), as its members in order; None when there's none.
pub fn wake_cycle(edges: &[(String, String)]) -> Option<Vec<String>> {
    let mut next: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (a, b) in edges {
        next.entry(a.as_str()).or_default().push(b.as_str());
    }
    let mut done = Vec::new();
    for n in next.keys() {
        if let Some(c) = visit(n, &next, &mut Vec::new(), &mut done) {
            return Some(c);
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_v1_kind_name_as_on_is_refused_with_its_v2_source() {
        let s = TriggerSpec { on: "finished".into(), ..TriggerSpec::default() };
        assert!(check(&s).iter().any(|e| e.contains("write task.finished")), "{:?}", check(&s));
        let ok = TriggerSpec { on: "task.finished".into(), ..TriggerSpec::default() };
        assert!(!check(&ok).iter().any(|e| e.contains("v1's name")));
        let hook = TriggerSpec { on: "webhook".into(), secret: "x".into(), ..TriggerSpec::default() };
        assert!(!check(&hook).iter().any(|e| e.contains("v1's name")), "webhook is the same name in both");
    }

    #[test]
    fn durations_rates_and_checks() {
        assert_eq!((duration_ms("10m"), duration_ms("30s"), duration_ms("x"), duration_ms("")), (Some(600_000), Some(30_000), None, None));
        assert_eq!((rate_of("5/h"), rate_of("20/d"), rate_of("0/h"), rate_of("5")), (Some((5, 3_600_000)), Some((20, 86_400_000)), None, None));
        let ok = TriggerSpec { on: "pr.opened".into(), prompt: "review {event.summary}".into(), ..TriggerSpec::default() };
        assert!(check(&ok).is_empty());
        let bad = TriggerSpec { on: "chat.message".into(), crew: "ada".into(), task: "x".into(), concurrency: "lots".into(), ..TriggerSpec::default() };
        let p = check(&bad);
        assert_eq!(p.len(), 3, "{p:?}");
    }
}
