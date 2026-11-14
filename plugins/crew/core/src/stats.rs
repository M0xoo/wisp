//! A member's track record (v1 server/usage.js `crewStats`), pure: its jobs over a range of days, how they went,
//! the tokens they used, by where they came from, its biggest jobs, and how many jobs the range before had. The
//! host reads each job's task and turns; time comes in as `now`.

use std::collections::{BTreeMap, BTreeSet};

use wisp_crew_api::JobKind;
use wisp_crew_api::commands::{KindUse, MemberLimit, MemberStats, TopJob};

const DAY_MS: i64 = 86_400_000;
const TOP: usize = 5;

/// One job as the host read it: its task and the tokens its turns used.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobUse {
    pub id: String,
    pub title: String,
    pub job: JobKind,
    /// when it started (ms)
    pub at: i64,
    /// the task's state: `running`, `waiting`, `review`, `done`, `error`, …
    pub state: String,
    /// filed quiet: a check-in that found nothing to do
    pub quiet: bool,
    pub tokens: u64,
    pub cost: f64,
}

/// The range asked for, clamped to 1..=365 days (default 30), as v1's `?days=`.
pub fn range_days(days: Option<u32>) -> u32 {
    days.unwrap_or(30).clamp(1, 365)
}

/// The record of member `id` over the last `days` days, from its jobs (any range; the older ones only count as
/// "before"). A job counts in the range it started in.
pub fn member_stats(id: &str, jobs: &[JobUse], days: u32, now: i64) -> MemberStats {
    let span = i64::from(days) * DAY_MS;
    let (since, before_since) = (now - span, now - 2 * span);
    let mine: Vec<&JobUse> = jobs.iter().filter(|j| j.at >= since).collect();
    let n = |f: &dyn Fn(&JobUse) -> bool| u32::try_from(mine.iter().filter(|j| f(j)).count()).unwrap_or(u32::MAX);
    let mut by_kind: BTreeMap<String, KindUse> = BTreeMap::new();
    for j in &mine {
        let k = by_kind.entry(kind_key(j.job).to_owned()).or_default();
        k.runs += 1;
        k.tokens += j.tokens;
        k.quiet += u32::from(j.quiet);
    }
    let mut top: Vec<&JobUse> = mine.iter().copied().filter(|j| j.tokens > 0).collect();
    top.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(b.at.cmp(&a.at)));
    let cost: f64 = mine.iter().map(|j| j.cost).sum();
    MemberStats {
        id: id.to_owned(),
        jobs: n(&|_| true),
        done: n(&|j| j.state == "done" || j.state == "review"),
        failed: n(&|j| j.state == "error"),
        quiet: n(&|j| j.quiet),
        before: u32::try_from(jobs.iter().filter(|j| j.at >= before_since && j.at < since).count()).unwrap_or(u32::MAX),
        cost: (cost > 0.0).then_some(cost),
        tokens: mine.iter().map(|j| j.tokens).sum(),
        by_kind,
        top: top.into_iter().take(TOP).map(|j| TopJob { id: j.id.clone(), title: j.title.clone(), job: j.job, tokens: j.tokens }).collect(),
        days,
        limits: Vec::new(),
    }
}

/// A plan window as wisp.budget traced it this period: the window (its `mine` and `crew` left at 0) and each task's
/// part of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WindowParts {
    pub window: MemberLimit,
    pub tasks: BTreeMap<String, f64>,
}

/// *What ate my limits* for one member (v1 crew-record.js `limitsHtml`): each window its jobs (`mine`) took a part
/// of, beside the whole crew's (`crew`: every member's jobs), the fullest window first. A window it took nothing of
/// is left out.
pub fn member_limits(windows: &[WindowParts], mine: &[String], crew: &BTreeSet<String>) -> Vec<MemberLimit> {
    let part = |w: &WindowParts, f: &dyn Fn(&str) -> bool| w.tasks.iter().filter(|(id, _)| f(id)).map(|(_, u)| *u).sum::<f64>().min(1.0);
    let mut out: Vec<MemberLimit> = windows
        .iter()
        .filter_map(|w| {
            let m = part(w, &|id| mine.iter().any(|x| x == id));
            (m > 0.0).then(|| MemberLimit { mine: m, crew: part(w, &|id| crew.contains(id)).max(m), ..w.window.clone() })
        })
        .collect();
    out.sort_by(|a, b| b.used.total_cmp(&a.used).then_with(|| b.mine.total_cmp(&a.mine)));
    out
}

fn kind_key(k: JobKind) -> &'static str {
    match k {
        JobKind::Checkin => "checkin",
        JobKind::Task => "task",
        JobKind::Delegated => "delegated",
        JobKind::Trigger => "trigger",
        JobKind::Mention => "mention",
        JobKind::Event => "event",
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::cast_possible_truncation)]
mod tests {
    use super::*;

    const NOW: i64 = 100 * DAY_MS;

    fn job(id: &str, job: JobKind, days_ago: i64, state: &str, tokens: u64) -> JobUse {
        JobUse {
            id: id.into(),
            title: format!("job {id}"),
            job,
            at: NOW - days_ago * DAY_MS,
            state: state.into(),
            tokens,
            cost: 0.0,
            quiet: false,
        }
    }

    #[test]
    fn a_members_record_counts_the_range_its_tokens_by_kind_and_its_biggest_jobs() {
        let mut quiet = job("c2", JobKind::Checkin, 2, "done", 500);
        quiet.quiet = true;
        quiet.cost = 0.25;
        let jobs = vec![
            job("c1", JobKind::Checkin, 1, "done", 1_000),
            quiet,
            job("t1", JobKind::Task, 3, "review", 9_000),
            job("t2", JobKind::Task, 4, "error", 0),
            job("old", JobKind::Task, 40, "done", 50_000), // the range before
            job("older", JobKind::Task, 70, "done", 1),    // before that: not counted
        ];
        let s = member_stats("m1", &jobs, 30, NOW);
        assert_eq!((s.jobs, s.done, s.failed, s.quiet, s.before), (4, 3, 1, 1, 1));
        assert_eq!(s.tokens, 10_500);
        assert_eq!(s.by_kind["checkin"], KindUse { runs: 2, tokens: 1_500, quiet: 1 });
        assert_eq!(s.by_kind["task"], KindUse { runs: 2, tokens: 9_000, quiet: 0 });
        assert_eq!(s.top.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t1", "c1", "c2"], "most tokens first, none without");
        assert_eq!(s.cost, Some(0.25));
        assert_eq!(s.days, 30);
    }

    #[test]
    fn an_idle_member_still_has_a_record_and_the_range_is_clamped() {
        let s = member_stats("m1", &[], 7, NOW);
        assert_eq!((s.jobs, s.tokens, s.cost, s.by_kind.len()), (0, 0, None, 0));
        assert_eq!((range_days(None), range_days(Some(0)), range_days(Some(9_999))), (30, 1, 365));
    }

    fn window(id: &str, used: f64, tasks: &[(&str, f64)]) -> WindowParts {
        WindowParts {
            window: MemberLimit {
                agent: "claude".into(),
                account: "default".into(),
                window: id.into(),
                label: id.into(),
                used,
                ..MemberLimit::default()
            },
            tasks: tasks.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
        }
    }

    #[test]
    fn what_ate_my_limits_shows_each_window_a_members_jobs_took_part_of_beside_the_crews_fullest_first() {
        let crew: BTreeSet<String> = ["a1", "a2", "b1"].iter().map(|s| (*s).to_owned()).collect();
        let windows = [
            window("five_hour", 0.3, &[("a1", 0.05), ("b1", 0.1), ("you", 0.15)]),
            window("seven_day", 0.8, &[("a1", 0.2), ("a2", 0.1), ("b1", 0.3)]),
            window("seven_day_opus", 0.9, &[("b1", 0.4)]), // a took none of it: not a's
        ];
        let a = member_limits(&windows, &["a1".into(), "a2".into(), "gone".into()], &crew);
        let got: Vec<(&str, i64, i64)> =
            a.iter().map(|l| (l.window.as_str(), (l.mine * 100.0).round() as i64, (l.crew * 100.0).round() as i64)).collect();
        assert_eq!(got, [("seven_day", 30, 60), ("five_hour", 5, 15)]);
        assert!(member_limits(&windows, &[], &crew).is_empty(), "a member with no jobs ate nothing");
        // shares never pass the whole window, even when a period's traced parts overlap
        let full = [window("five_hour", 1.0, &[("a1", 0.7), ("a2", 0.6)])];
        assert!((member_limits(&full, &["a1".into(), "a2".into()], &crew)[0].mine - 1.0).abs() < 1e-9);
    }
}
