//! A member's job in a sandbox (ADR-0047) runs on that machine, stored here as `<machine>|<id>`: its turn ends there,
//! where no member is, so the report is made here. This wisp mirrors the sandbox's list (`machines.remote` says a row
//! changed); when a job's row says a turn ended, its turns are read through `machines.route` and reported as a local
//! job's are: the answer under the question that asked, and `crew.reported`. `crew_job.reported` keeps the turns
//! already reported, so a restart or a row that changes again never reports one twice.

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::{Ctx, Setup};
use wisp_machines_api::events::{Remote, RemoteOp};

use crate::{State, jobs, lock};

/// The member whose job `job` is.
fn owner(st: &State, job: &str) -> Option<String> {
    lock(&st.jobs).iter().find(|(_, list)| list.iter().any(|j| j == job)).map(|(m, _)| m.clone())
}

/// What the sandbox's list row says now: `(state, turn count)` (the row is the task's, its list summary under `summary`).
async fn row_of(ctx: &Ctx, call: &wisp_kernel::Call, machine: &str, id: &str) -> Option<(String, u32)> {
    let rows = ctx.run::<wisp_machines_api::Sessions>(call, wisp_machines_api::SessionsArgs { id: Some(machine.to_owned()) }).await.ok()?;
    let row = rows.into_iter().find(|r| r.id == id)?;
    let state = row.v.get("state").and_then(Value::as_str)?.to_owned();
    let turns = row.v.pointer("/summary/turnCount").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())?;
    Some((state, turns))
}

/// A sandbox's row changed: if it's a member's job whose turn just ended, report it.
async fn changed(ctx: Ctx, st: Arc<State>, e: Remote) {
    if e.op == RemoteOp::Upsert {
        check(&ctx, &st, &e.id, &e.row_id).await;
    }
}

/// Reports the sandbox's job `<machine>|<id>` if its row says a turn ended that isn't reported yet. Also run as the
/// job is kept: a quick job's row can end before then, and the row may not change again.
pub(crate) async fn check(ctx: &Ctx, st: &State, machine: &str, id: &str) {
    let job = format!("{machine}|{id}");
    let Some(member) = owner(st, &job) else { return };
    let call = ctx.root_call();
    let Some((state, turns)) = row_of(ctx, &call, machine, id).await else { return };
    if state == "running" || state == "waiting" || turns == 0 {
        return;
    }
    let _g = st.reporting.lock().await;
    if lock(&st.reported).get(&job).is_some_and(|n| *n >= turns) {
        return;
    }
    let Ok(m) = st.member(&member) else { return };
    let list = match jobs::job_turns(ctx, &call, &job).await {
        Ok(l) => l,
        Err(err) => {
            // read again at the row's next change (the sandbox asleep, the tunnel down)
            tracing::warn!(job = %job, error = %err.message, "crew: a sandbox job's turns aren't read");
            return;
        }
    };
    st.set_reported(&job, turns).await;
    let last = list.last();
    let text = last.and_then(|t| t.text.clone()).unwrap_or_default();
    crate::report(ctx, &call, st, &m, &job, last, &text, state == "error").await;
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.on::<Remote, _, _>(move |ctx, e| changed(ctx, st.clone(), e));
}
