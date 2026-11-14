//! `crew.stats` (v1 GET /crew/stats): each member's track record over a range, read from its jobs' tasks and turns
//! (here or in their sandbox). Read on demand, never on a hot path; a job that can't be read is left out.

use std::sync::Arc;

use serde_json::Value;
use wisp_budget_api::commands::{PlanWindows, PlanWindowsArgs};
use wisp_crew_api::JobKind;
use wisp_crew_api::commands as c;
use wisp_crew_api::commands::MemberLimit;
use wisp_crew_core::stats::{JobUse, WindowParts, member_limits, member_stats, range_days};
use wisp_kernel::{Call, Ctx, Setup};

use crate::jobs::{job_task, job_turns, now};
use crate::{State, lock};

/// One job as the record reads it: its task, and the tokens and cost its turns used.
async fn job_use(ctx: &Ctx, call: &Call, id: &str, since: i64) -> Option<JobUse> {
    let s = job_task(ctx, call, id).await.ok()?;
    let at = s.get("createdAt").or_else(|| s.get("created_at")).and_then(Value::as_i64).unwrap_or_default();
    if at < since {
        return None; // older than the range before: not counted, and its turns aren't read
    }
    let job = s.pointer("/ext/wisp.crew/job").and_then(|j| serde_json::from_value::<JobKind>(j.clone()).ok()).unwrap_or_default();
    let state = s.get("state").and_then(Value::as_str).unwrap_or("done").to_owned();
    let archived = s.get("archived").and_then(Value::as_bool).unwrap_or(false);
    let quiet = matches!(job, JobKind::Checkin | JobKind::Event) && archived && state == "done";
    let (mut tokens, mut cost) = (0_u64, 0.0_f64);
    for t in job_turns(ctx, call, id).await.unwrap_or_default() {
        if let Some(st) = t.stats {
            tokens += st.input_tokens.unwrap_or(0) + st.output_tokens.unwrap_or(0) + st.cache_tokens.unwrap_or(0);
            cost += st.cost_usd.unwrap_or(0.0);
        }
    }
    let title = s.get("title").and_then(Value::as_str).unwrap_or_default().to_owned();
    Some(JobUse { id: id.to_owned(), title, job, at, state, quiet, tokens, cost })
}

/// Each plan window this period and the crew's jobs' parts of it (wisp.budget). Budget off or refusing: no limits,
/// the rest of the record still shows.
async fn crew_windows(ctx: &Ctx, call: &Call, jobs: &[String]) -> Vec<WindowParts> {
    let Ok(list) = ctx.run::<PlanWindows>(call, PlanWindowsArgs { tasks: Some(jobs.to_vec()) }).await else { return Vec::new() };
    list.into_iter()
        .map(|w| WindowParts {
            window: MemberLimit {
                agent: w.agent,
                account: w.account,
                window: w.window,
                label: w.label,
                used: w.used,
                resets_at: w.resets_at,
                since: w.since,
                traced: w.traced,
                ..MemberLimit::default()
            },
            tasks: w.tasks,
        })
        .collect()
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::Stats, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let days = range_days(a.days);
            let at = now(&ctx);
            let since = at - 2 * i64::from(days) * 86_400_000;
            let crew = lock(&st.saved).crew.clone();
            let ids: Vec<(String, Vec<String>)> = {
                let jobs = lock(&st.jobs);
                crew.iter().map(|m| (m.id.clone(), jobs.get(&m.id).cloned().unwrap_or_default())).collect()
            };
            let all: std::collections::BTreeSet<String> = ids.iter().flat_map(|(_, j)| j.iter().cloned()).collect();
            let windows = crew_windows(&ctx, &call, &all.iter().cloned().collect::<Vec<_>>()).await;
            let mut out = Vec::new();
            for (member, list) in ids {
                let mut jobs = Vec::new();
                for id in &list {
                    if let Some(j) = job_use(&ctx, &call, id, since).await {
                        jobs.push(j);
                    }
                }
                let mut s = member_stats(&member, &jobs, days, at);
                s.limits = member_limits(&windows, &list, &all);
                out.push(s);
            }
            Ok(out)
        }
    });
}
