//! `wisp_stats` (v1 server/usage.js `toolStats`, `toolStatsText`): how many tool calls each kind of action made
//! across the user's tasks, by harness, project and day, with their turns, cost, tokens and success rate. Pure:
//! the host reads the turns since `since(days, now)`, their tool calls and where each task ran. Days are UTC days
//! (v1 used the server's local midnight), and a project is the folder a task ran in (its last part names it).

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use wisp_runtime_api::model::{ToolKind, Turn, TurnStats, TurnStatus};

use crate::usage::{civil, project_name};

const DAY: i64 = 86_400_000;

/// Where a task ran and with which harness.
#[derive(Debug, Clone, Copy)]
pub struct Task<'a> {
    pub agent: &'a str,
    pub cwd: &'a str,
}

/// One tool call of a turn: its turn, when it ran and what kind of action it was.
#[derive(Debug, Clone)]
pub struct Call {
    pub turn: String,
    pub t: i64,
    pub kind: ToolKind,
}

/// Only this harness, only this project (a folder, or its last part).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filter {
    pub agent: Option<String>,
    pub project: Option<String>,
}

/// Calls by kind, and the turns they came from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tally {
    pub name: String,
    pub calls: u64,
    pub kinds: BTreeMap<String, u64>,
    pub turns: u32,
    pub done: u32,
    pub cost: f64,
    pub priced: u32,
}

impl Tally {
    fn named(name: String) -> Self {
        Self { name, ..Self::default() }
    }
    fn call(&mut self, kind: &str) {
        self.calls += 1;
        *self.kinds.entry(kind.to_owned()).or_default() += 1;
    }
    fn turn(&mut self, t: &Turn) {
        self.turns += 1;
        if worked(t) {
            self.done += 1;
        }
        if let Some(c) = t.stats.as_ref().and_then(|s| s.cost_usd) {
            self.cost += c;
            self.priced += 1;
        }
    }
    #[allow(clippy::cast_precision_loss)] // counts of turns
    fn success(&self) -> Option<f64> {
        (self.turns > 0).then(|| f64::from(self.done) / f64::from(self.turns))
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolStats {
    pub days: u32,
    pub filter: Filter,
    pub total: Tally,
    pub sessions: u32,
    pub questions: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub agents: Vec<Tally>,
    pub projects: Vec<Tally>,
    /// every day of the range, oldest first (`name` is its date)
    pub daily: Vec<Tally>,
}

/// v1's range: `days` as the agent gave it (a number or a numeric string), rounded, 1–365; 30 when absent or 0.
pub fn days(v: Option<&Value>) -> u32 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|x| x.is_finite())
    .map_or(0.0, f64::round);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to 1–365
    let d = if n == 0.0 { 30 } else { n.clamp(1.0, 365.0) as u32 };
    d
}

/// The first moment counted: the start of the UTC day `days - 1` days before `now`'s.
pub fn since(days: u32, now: i64) -> i64 {
    (now.div_euclid(DAY) - i64::from(days.max(1)) + 1) * DAY
}

/// v1 `outcome(t) === 'done'`: it finished, and its hero didn't say partial or blocked.
fn worked(t: &Turn) -> bool {
    let hero = t
        .presentation
        .as_ref()
        .and_then(|p| p.blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("hero")))
        .and_then(|h| h.get("status"))
        .and_then(Value::as_str);
    t.status == TurnStatus::Done && !t.is_error && !matches!(hero, Some("blocked" | "partial"))
}

fn asked(t: &Turn) -> bool {
    t.presentation.as_ref().is_some_and(|p| p.blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("question")))
}

/// v1 `turnTokens`: (read, written); Claude's per-model counts win when they're larger.
fn tokens(st: &TurnStats) -> (u64, u64) {
    let read = st.input_tokens.unwrap_or(0) + st.cache_tokens.unwrap_or(0);
    let output = st.output_tokens.unwrap_or(0);
    let n = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0);
    let models = st.models.as_ref().map(|m| {
        m.values()
            .fold((0, 0), |(r, o), x| (r + n(x.get("input")) + n(x.get("cacheRead")) + n(x.get("cacheWrite")), o + n(x.get("output"))))
    });
    match models {
        Some((r, o)) if r + o > read + output => (r, o),
        _ => (read, output),
    }
}

/// The wire name of a kind (`run`, `read`, …).
fn kind_name(k: ToolKind) -> String {
    serde_json::to_value(k).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn in_project(cwd: &str, want: &str) -> bool {
    cwd == want || project_name(cwd) == want
}

fn ranked(m: HashMap<String, Tally>) -> Vec<Tally> {
    let mut v: Vec<Tally> = m.into_values().collect();
    v.sort_by(|a, b| b.calls.cmp(&a.calls).then(b.turns.cmp(&a.turns)).then(a.name.cmp(&b.name)));
    v
}

/// The stats over `turns` that started in the range and ended (or were stopped), with their `calls`; `task_of`
/// says where each task ran (the tour's turns, agent `wisp`, and turns of tasks it can't place aren't counted).
pub fn tool_stats<'a>(
    task_of: &dyn Fn(&str) -> Option<Task<'a>>,
    turns: &[Turn],
    calls: &[Call],
    (days, now): (u32, i64),
    filter: Filter,
) -> ToolStats {
    let from = since(days, now);
    let mut by_turn: HashMap<&str, Vec<&Call>> = HashMap::new();
    for c in calls.iter().filter(|c| c.kind != ToolKind::Answer) {
        by_turn.entry(c.turn.as_str()).or_default().push(c);
    }
    let (first, last) = (from.div_euclid(DAY), now.max(from).div_euclid(DAY));
    let mut daily: BTreeMap<i64, Tally> = (first..=last).map(|d| (d, Tally::named(civil(d)))).collect();
    let mut out = ToolStats { days, ..ToolStats::default() };
    let (mut agents, mut projects): (HashMap<String, Tally>, HashMap<String, Tally>) = (HashMap::new(), HashMap::new());
    let mut sessions: Vec<&str> = Vec::new();
    for t in turns.iter().filter(|t| t.started_at >= from && !t.status.is_live()) {
        let Some(task) = task_of(t.session_id.as_str()).filter(|x| x.agent != "wisp") else { continue };
        let agent = if t.agent.is_empty() { task.agent } else { t.agent.as_str() };
        if filter.agent.as_deref().is_some_and(|a| a != agent) || filter.project.as_deref().is_some_and(|p| !in_project(task.cwd, p)) {
            continue;
        }
        sessions.push(t.session_id.as_str());
        let a = agents.entry(agent.to_owned()).or_insert_with(|| Tally::named(agent.to_owned()));
        let p = projects.entry(task.cwd.to_owned()).or_insert_with(|| Tally::named(project_name(task.cwd)));
        for b in [&mut out.total, &mut *a, &mut *p] {
            b.turn(t);
        }
        let mine = by_turn.get(t.id.as_str()).map_or(&[][..], Vec::as_slice);
        for c in mine {
            let k = kind_name(c.kind);
            for b in [&mut out.total, &mut *a, &mut *p] {
                b.call(&k);
            }
            if let Some(d) = daily.get_mut(&(if c.t > 0 { c.t } else { t.started_at }).div_euclid(DAY)) {
                d.call(&k);
            }
        }
        out.questions += mine.iter().filter(|c| c.kind == ToolKind::Ask).count() as u64 + u64::from(asked(t));
        let (r, o) = t.stats.as_ref().map_or((0, 0), tokens);
        (out.input_tokens, out.output_tokens) = (out.input_tokens + r, out.output_tokens + o);
    }
    sessions.sort_unstable();
    sessions.dedup();
    out.sessions = u32::try_from(sessions.len()).unwrap_or(u32::MAX);
    out.agents = ranked(agents);
    out.projects = ranked(projects);
    out.daily = daily.into_values().collect();
    out.filter = filter;
    out
}

fn pct(r: Option<f64>) -> String {
    r.map_or_else(|| "—".to_owned(), |r| format!("{}%", (r * 100.0).round()))
}

fn usd(b: &Tally) -> String {
    if b.priced == 0 {
        return "—".into();
    }
    let part = if b.priced < b.turns { format!(" ({}/{} turns priced)", b.priced, b.turns) } else { String::new() };
    format!("${:.2}{part}", b.cost)
}

fn kinds(k: &BTreeMap<String, u64>) -> String {
    let mut v: Vec<(&String, &u64)> = k.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let s: Vec<String> = v.iter().map(|(n, c)| format!("{n} {c}")).collect();
    if s.is_empty() { "—".into() } else { s.join(", ") }
}

fn group_rows(out: &mut Vec<String>, title: &str, col: &str, rows: &[Tally]) {
    out.extend([
        String::new(),
        format!("### By {title}"),
        format!("| {col} | calls | turns | success | cost | top kinds |"),
        "|---|---:|---:|---:|---:|---|".into(),
    ]);
    for a in rows {
        out.push(format!("| {} | {} | {} | {} | {} | {} |", a.name, a.calls, a.turns, pct(a.success()), usd(a), kinds(&a.kinds)));
    }
}

/// v1 `toolStatsText`: the stats as markdown for the agent to read.
#[allow(clippy::cast_precision_loss)] // counts of calls
pub fn tool_stats_text(st: &ToolStats) -> String {
    let scope: Vec<String> =
        [st.filter.agent.as_ref().map(|a| format!("harness {a}")), st.filter.project.as_ref().map(|p| format!("project {p}"))]
            .into_iter()
            .flatten()
            .collect();
    let scope = if scope.is_empty() { String::new() } else { format!(" ({})", scope.join(", ")) };
    let t = &st.total;
    let mut out = vec![
        format!("## wisp tool stats — last {} day{}{scope}", st.days, if st.days == 1 { "" } else { "s" }),
        format!(
            "{} tool calls in {} turns across {} sessions. Success rate {}, cost {}, {} questions to the user, {} input / {} output tokens.",
            t.calls,
            t.turns,
            st.sessions,
            pct(t.success()),
            usd(t),
            st.questions,
            st.input_tokens,
            st.output_tokens
        ),
        String::new(),
        "Kinds are wisp’s categories, not harness tool names: run = shell commands, read / edit / search = files, web = fetch and search, agent = subagents, tool = other (MCP) tools, ask = questions to the user, wait = waiting on the user or a background task.".into(),
    ];
    if t.turns == 0 {
        out.extend([String::new(), "No finished turns in this range.".into()]);
        return out.join("\n");
    }
    out.extend([String::new(), "### By kind".into(), "| kind | calls | share |".into(), "|---|---:|---:|".into()]);
    let mut by_kind: Vec<(&String, &u64)> = t.kinds.iter().collect();
    by_kind.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    for (k, n) in by_kind {
        let share = if t.calls > 0 { (*n as f64 * 100.0 / t.calls as f64).round() } else { 0.0 };
        out.push(format!("| {k} | {n} | {share}% |"));
    }
    group_rows(&mut out, "harness", "harness", &st.agents);
    group_rows(&mut out, "project", "project", &st.projects);
    out.extend([String::new(), "### By day (days with activity)".into(), "| day | calls | kinds |".into(), "|---|---:|---|".into()]);
    for d in st.daily.iter().filter(|d| d.calls > 0) {
        out.push(format!("| {} | {} | {} |", d.name, d.calls, kinds(&d.kinds)));
    }
    out.join("\n")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;
    use wisp_runtime_api::model::Presentation;

    fn turn(id: &str, session: &str, agent: &str, at: i64, status: TurnStatus, cost: Option<f64>) -> Turn {
        Turn {
            id: id.into(),
            session_id: session.into(),
            agent: agent.into(),
            started_at: at,
            status,
            stats: Some(TurnStats { cost_usd: cost, input_tokens: Some(100), output_tokens: Some(10), ..TurnStats::default() }),
            ..Turn::default()
        }
    }

    fn call(turn: &str, t: i64, kind: ToolKind) -> Call {
        Call { turn: turn.into(), t, kind }
    }

    fn tasks(id: &str) -> Option<Task<'static>> {
        match id {
            "s1" => Some(Task { agent: "claude", cwd: "/code/wisp" }),
            "s2" => Some(Task { agent: "codex", cwd: "/code/site" }),
            "tour" => Some(Task { agent: "wisp", cwd: "/" }),
            _ => None,
        }
    }

    #[test]
    fn days_are_v1s_range() {
        assert_eq!(days(None), 30);
        assert_eq!(days(Some(&json!(0))), 30);
        assert_eq!(days(Some(&json!("7"))), 7);
        assert_eq!(days(Some(&json!(2.6))), 3);
        assert_eq!(days(Some(&json!(-4))), 1);
        assert_eq!(days(Some(&json!(9999))), 365);
        assert_eq!(days(Some(&json!("soon"))), 30);
        assert_eq!(since(1, 3 * DAY + 5), 3 * DAY);
        assert_eq!(since(3, 3 * DAY + 5), DAY);
    }

    #[test]
    fn calls_are_counted_by_kind_harness_project_and_day() {
        let now = 10 * DAY + 100;
        let mut blocked = turn("t2", "s1", "claude", 9 * DAY, TurnStatus::Done, Some(0.5));
        blocked.presentation =
            Some(Presentation { blocks: vec![json!({ "type": "hero", "status": "blocked" })], v: 1, ..Presentation::default() });
        let turns = vec![
            turn("t1", "s1", "claude", 10 * DAY, TurnStatus::Done, Some(0.25)),
            blocked,
            turn("t3", "s2", "codex", 10 * DAY + 1, TurnStatus::Error, None),
            turn("t4", "s2", "codex", 10 * DAY + 2, TurnStatus::Running, None),
            turn("t5", "s1", "claude", DAY, TurnStatus::Done, Some(9.0)),
            turn("t6", "tour", "wisp", 10 * DAY, TurnStatus::Done, None),
        ];
        let calls = vec![
            call("t1", 10 * DAY + 5, ToolKind::Run),
            call("t1", 10 * DAY + 6, ToolKind::Run),
            call("t1", 10 * DAY + 7, ToolKind::Answer),
            call("t2", 9 * DAY + 5, ToolKind::Read),
            call("t3", 10 * DAY + 9, ToolKind::Ask),
            call("t4", 10 * DAY + 9, ToolKind::Edit),
            call("t6", 10 * DAY + 9, ToolKind::Edit),
        ];
        let st = tool_stats(&tasks, &turns, &calls, (2, now), Filter::default());
        assert_eq!((st.total.calls, st.total.turns, st.total.done, st.sessions), (4, 3, 1, 2), "running, old and tour turns are left out");
        assert_eq!(st.total.kinds.get("run"), Some(&2));
        assert_eq!((st.questions, st.input_tokens, st.output_tokens), (1, 300, 30));
        assert_eq!(st.agents.iter().map(|a| (a.name.as_str(), a.calls)).collect::<Vec<_>>(), vec![("claude", 3), ("codex", 1)]);
        assert_eq!(st.projects[0].name, "wisp");
        assert_eq!(st.daily.iter().map(|d| (d.name.as_str(), d.calls)).collect::<Vec<_>>(), vec![("1970-01-10", 1), ("1970-01-11", 3)]);
        let text = tool_stats_text(&st);
        assert!(text.starts_with("## wisp tool stats — last 2 days\n4 tool calls in 3 turns across 2 sessions. Success rate 33%, cost $0.75 (2/3 turns priced), 1 questions to the user, 300 input / 30 output tokens."), "{text}");
        assert!(text.contains("| run | 2 | 50% |"), "{text}");
        assert!(text.contains("| claude | 3 | 2 | 50% | $0.75 | run 2, read 1 |"), "{text}");
        assert!(text.contains("| codex | 1 | 1 | 0% | — | ask 1 |"), "{text}");
        assert!(text.contains("| 1970-01-11 | 3 | run 2, ask 1 |"), "{text}");

        let only = tool_stats(&tasks, &turns, &calls, (2, now), Filter { agent: None, project: Some("site".into()) });
        assert_eq!((only.total.calls, only.total.turns), (1, 1));
        assert!(tool_stats_text(&only).starts_with("## wisp tool stats — last 2 days (project site)"));
    }

    #[test]
    fn no_turns_says_so() {
        let st = tool_stats(&tasks, &[], &[], (1, DAY), Filter { agent: Some("grok".into()), project: None });
        let text = tool_stats_text(&st);
        assert!(text.starts_with(
            "## wisp tool stats — last 1 day (harness grok)\n0 tool calls in 0 turns across 0 sessions. Success rate —, cost —"
        ));
        assert!(text.ends_with("\n\nNo finished turns in this range."));
    }
}
