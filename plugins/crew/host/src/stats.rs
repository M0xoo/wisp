//! `crew.stats` (v1 GET /crew/stats): each member's track record over a range, read from its jobs' tasks and turns
//! (here or in their sandbox). Read on demand, never on a hot path; a job that can't be read is left out.

use std::sync::Arc;

use serde_json::Value;
use wisp_crew_api::JobKind;
use wisp_crew_api::commands as c;
use wisp_crew_core::stats::{JobUse, member_stats, range_days};
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

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::Stats, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let days = range_days(a.days);
            let at = now(&ctx);
            let since = at - 2 * i64::from(days) * 86_400_000;
            let crew = lock(&st.saved).crew.clone();
            let mut out = Vec::new();
            for m in &crew {
                let ids = lock(&st.jobs).get(&m.id).cloned().unwrap_or_default();
                let mut jobs = Vec::new();
                for id in ids {
                    if let Some(j) = job_use(&ctx, &call, &id, since).await {
                        jobs.push(j);
                    }
                }
                out.push(member_stats(&m.id, &jobs, days, at));
            }
            Ok(out)
        }
    });
}
