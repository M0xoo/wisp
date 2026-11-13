//! Settings → Usage's line (v1 GET /api/usage summary): spend, turns, how many worked, and the questions
//! agents asked, over the turns that started since a time; and v1's Charts and breakdowns (usage.js): per day,
//! per project and per harness · model. Pure: the host reads the turns and says where each task ran.

use std::collections::BTreeMap;

use wisp_runtime_api::commands::{UsageDay, UsageRow, UsageSummary};
use wisp_runtime_api::model::{Turn, TurnStatus};

/// A turn that ended by asking (a `question` block in its answer, or held for an answer).
fn asked(t: &Turn) -> bool {
    t.presentation.as_ref().is_some_and(|p| p.blocks.iter().any(|b| b.get("type").and_then(serde_json::Value::as_str) == Some("question")))
}

/// The summary of `turns` that started at or after `from`. `worked`: the share (0–100) of the ended ones that
/// didn't fail; None when none ended.
pub fn summarize(turns: &[Turn], from: i64) -> UsageSummary {
    let mine: Vec<&Turn> = turns.iter().filter(|t| t.started_at >= from).collect();
    let ended: Vec<&&Turn> =
        mine.iter().filter(|t| matches!(t.status, TurnStatus::Done | TurnStatus::Error | TurnStatus::Stopped)).collect();
    let ok = ended.iter().filter(|t| t.status == TurnStatus::Done && !t.is_error).count();
    #[allow(clippy::cast_precision_loss)] // counts of turns
    let worked = (!ended.is_empty()).then(|| (ok as f64 * 100.0 / ended.len() as f64).round());
    UsageSummary {
        from,
        spend: mine.iter().filter_map(|t| t.stats.as_ref().and_then(|s| s.cost_usd)).sum(),
        turns: u32::try_from(mine.len()).unwrap_or(u32::MAX),
        worked,
        questions: u32::try_from(mine.iter().filter(|t| asked(t)).count()).unwrap_or(u32::MAX),
        ..UsageSummary::default()
    }
}

const DAY: i64 = 86_400_000;

/// `YYYY-MM-DD` of a UTC day number (days since 1970-01-01), Howard Hinnant's `civil_from_days`.
pub(crate) fn civil(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn ended(t: &Turn) -> bool {
    matches!(t.status, TurnStatus::Done | TurnStatus::Error | TurnStatus::Stopped)
}

/// One row over a group of turns.
fn row(key: String, name: String, agent: String, turns: &[&Turn]) -> UsageRow {
    let done: Vec<&&Turn> = turns.iter().filter(|t| ended(t)).collect();
    let ok = done.iter().filter(|t| t.status == TurnStatus::Done && !t.is_error).count();
    let lens: Vec<i64> = done.iter().filter_map(|t| t.ended_at.map(|e| e - t.started_at)).filter(|ms| *ms >= 0).collect();
    #[allow(clippy::cast_precision_loss)] // counts and lengths
    let (worked, avg_ms) = (
        (!done.is_empty()).then(|| (ok as f64 * 100.0 / done.len() as f64).round()),
        (!lens.is_empty()).then(|| lens.iter().sum::<i64>() as f64 / lens.len() as f64),
    );
    let costs: Vec<f64> = turns.iter().filter_map(|t| t.stats.as_ref().and_then(|s| s.cost_usd)).collect();
    UsageRow {
        key,
        name,
        agent,
        cost: costs.iter().sum(),
        priced: u32::try_from(costs.len()).unwrap_or(u32::MAX),
        turns: u32::try_from(turns.len()).unwrap_or(u32::MAX),
        worked,
        questions: u32::try_from(turns.iter().filter(|t| asked(t)).count()).unwrap_or(u32::MAX),
        avg_ms,
    }
}

/// The folder's last part, as v1 named a project it didn't know (places.js projectName).
pub(crate) fn project_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(cwd).to_owned()
}

/// Most spent first, then most turns, then by key: the same input lists the same way.
fn ranked(mut rows: Vec<UsageRow>) -> Vec<UsageRow> {
    rows.sort_by(|a, b| b.cost.total_cmp(&a.cost).then(b.turns.cmp(&a.turns)).then(a.key.cmp(&b.key)));
    rows
}

/// The summary with v1's breakdowns: a bar per UTC day from `from` to `now` (empty days too), and the turns by
/// project (`cwd_of` says where a task ran; a task it can't place goes under its id) and by harness · model.
pub fn breakdown(turns: &[Turn], from: i64, now: i64, cwd_of: &dyn Fn(&str) -> Option<String>) -> UsageSummary {
    let mut out = summarize(turns, from);
    let mine: Vec<&Turn> = turns.iter().filter(|t| t.started_at >= from).collect();
    out.priced = u32::try_from(mine.iter().filter(|t| t.stats.as_ref().and_then(|s| s.cost_usd).is_some()).count()).unwrap_or(u32::MAX);
    let mut ids: Vec<&str> = mine.iter().map(|t| t.session_id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    out.sessions = u32::try_from(ids.len()).unwrap_or(u32::MAX);
    let (first, last) = (from.div_euclid(DAY), now.max(from).div_euclid(DAY));
    let mut days: BTreeMap<i64, UsageDay> = (first..=last).map(|d| (d, UsageDay { date: civil(d), cost: 0.0, turns: 0 })).collect();
    let mut by_project: BTreeMap<String, Vec<&Turn>> = BTreeMap::new();
    let mut by_runner: BTreeMap<(String, String), Vec<&Turn>> = BTreeMap::new();
    for t in &mine {
        if let Some(d) = days.get_mut(&t.started_at.div_euclid(DAY)) {
            d.turns += 1;
            d.cost += t.stats.as_ref().and_then(|s| s.cost_usd).unwrap_or(0.0);
        }
        by_project.entry(cwd_of(t.session_id.as_str()).unwrap_or_else(|| t.session_id.as_str().to_owned())).or_default().push(t);
        by_runner.entry((t.agent.clone(), t.model.clone())).or_default().push(t);
    }
    out.daily = days.into_values().collect();
    out.projects = ranked(by_project.into_iter().map(|(cwd, ts)| row(cwd.clone(), project_name(&cwd), String::new(), &ts)).collect());
    out.runners = ranked(by_runner.into_iter().map(|((agent, model), ts)| row(format!("{agent} {model}"), model, agent, &ts)).collect());
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::float_cmp)]
mod tests {
    use super::*;
    use serde_json::json;
    use wisp_runtime_api::model::{Presentation, TurnStats};

    fn turn(at: i64, status: TurnStatus, cost: f64, question: bool) -> Turn {
        let blocks = if question { vec![json!({ "type": "question", "question": "which?" })] } else { vec![] };
        Turn {
            started_at: at,
            status,
            stats: Some(TurnStats { cost_usd: Some(cost), ..TurnStats::default() }),
            presentation: Some(Presentation { blocks, v: 1, ..Presentation::default() }),
            ..Turn::default()
        }
    }

    #[test]
    fn usage_sums_spend_counts_turns_and_says_how_many_worked() {
        let turns = vec![
            turn(10, TurnStatus::Done, 0.5, false),
            turn(20, TurnStatus::Error, 0.25, false),
            turn(30, TurnStatus::Done, 0.25, true),
            turn(40, TurnStatus::Running, 0.0, false),
            turn(1, TurnStatus::Done, 9.0, false),
        ];
        let u = summarize(&turns, 5);
        assert_eq!(u.turns, 4, "the one before the window is left out");
        assert_eq!(u.spend, 1.0);
        assert_eq!(u.worked, Some(67.0), "2 of 3 ended ones worked; a running one isn't counted");
        assert_eq!(u.questions, 1);
        assert_eq!(summarize(&[], 0).worked, None);
    }

    #[test]
    fn usage_breaks_down_by_day_project_and_harness_model_with_empty_days_kept() {
        const D: i64 = 86_400_000;
        let mut a = turn(D + 10, TurnStatus::Done, 0.5, false);
        a.session_id = "s1".into();
        a.agent = "claude".into();
        a.model = "opus".into();
        a.ended_at = Some(D + 2010);
        let mut b = turn(3 * D + 5, TurnStatus::Error, 0.25, true);
        b.session_id = "s2".into();
        b.agent = "codex".into();
        b.model = "gpt".into();
        b.stats = None; // Codex reports no price
        let cwd = |id: &str| (id == "s1").then(|| "/home/me/code/wisp/".to_owned());
        let u = breakdown(&[a, b], D, 3 * D + 100, &cwd);
        assert_eq!(
            u.daily.iter().map(|d| (d.date.as_str(), d.turns)).collect::<Vec<_>>(),
            vec![("1970-01-02", 1), ("1970-01-03", 0), ("1970-01-04", 1)],
            "a day with nothing is still a bar"
        );
        assert_eq!((u.priced, u.sessions), (1, 2));
        assert_eq!(u.projects[0].name, "wisp", "the folder's last part, most spent first");
        assert_eq!(u.projects[1].key, "s2", "a task it can't place goes under its id");
        assert_eq!((u.runners[0].agent.as_str(), u.runners[0].name.as_str(), u.runners[0].avg_ms), ("claude", "opus", Some(2000.0)));
        assert_eq!((u.runners[1].priced, u.runners[1].worked, u.runners[1].questions), (0, Some(0.0), 1));
        assert_eq!(civil(19_673), "2023-11-12");
    }
}
