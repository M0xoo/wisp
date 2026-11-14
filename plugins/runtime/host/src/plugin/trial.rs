//! `runtime.trial` (Try it two ways, F-comp-31; ADR-0056): the pair, each run through `runtime.create` (its hooks,
//! its worktree, its permission), linked; and `runtime.trial.keep`.

use wisp_kernel::{Call, Ctx, Result as WireResult, Setup, WireError};
use wisp_runtime_api::commands::{self as c, TrialArgs, TrialLink, TrialStarted};

use super::{Slot, rt};

pub(super) fn trial(s: &mut Setup, slot: &Slot) {
    let ctx = s.ctx();
    let start = slot.clone();
    s.command::<c::Trial, _, _>(move |_ctx, call, a| {
        let (slot, ctx) = (start.clone(), ctx.clone());
        // boxed: each run's create starts its first turn, whose future is large (clippy large_futures)
        async move { Box::pin(pair(&ctx, &call, &slot, a)).await }
    });
    cmd!(s, slot, c::TrialKeep, |r, call, a| r.trial_keep(a.id.as_str()).await.map(|()| c::Ack {}));
}

async fn pair(ctx: &Ctx, call: &Call, slot: &Slot, a: TrialArgs) -> WireResult<TrialStarted> {
    let rt = rt(slot)?;
    // every refusal before anything runs: nothing is half started
    let p = rt.trial_plan(&a).map_err(WireError::from)?;
    // a folder outside git gets no worktree, and both runs would edit it at once
    if !in_git(p.a.cwd.as_deref().unwrap_or_default()).await {
        return Err(WireError::invalid("Try it two ways needs a project in git: each run keeps its own worktree."));
    }
    let group = format!("g-{}", &wisp_kernel::ids::uuid7()[20..]);
    let mut made: Vec<c::Created> = Vec::new();
    for (i, mut start) in [p.a, p.b].into_iter().enumerate() {
        let link = TrialLink { group: group.clone(), run: u8::from(i > 0), differs: p.differs.clone(), ..TrialLink::default() };
        crate::trial::link(&mut start, &link);
        match ctx.run::<c::Create>(call, start).await {
            Ok(m) => {
                let id = m.id.clone();
                made.push(m);
                // a run that didn't start (Ask near the limit asked for both on A, a hook refused it, the budget held
                // it): the pair is refused as one, as v1's 409, never one run alone; the words are the refusal's own
                // (Ask near the limit's say how to go ahead: confirmLimit, the CLI's --yes)
                if let Some(why) = rt.first_turn_not_started(id.as_str()).await.map_err(WireError::from)? {
                    drop_runs(&rt, &made).await;
                    return Err(WireError::conflict(why));
                }
            }
            Err(err) => {
                // run B refused (a hook, a cap) once run A started: A stops and is archived, so no lone run of a
                // pair goes on billing as if it were one
                drop_runs(&rt, &made).await;
                return Err(err);
            }
        }
    }
    let ids: Vec<_> = made.iter().map(|m| m.id.clone()).collect();
    rt.trial_runs(&ids).await.map_err(WireError::from)?;
    // a count with nothing in it (v1 `try_two_ways`): only a pair that started, never a refusal; telemetry's own
    // switch and environment (DO_NOT_TRACK, CI) decide whether it leaves
    super::track(ctx, "try_two_ways", serde_json::json!({})).await;
    Ok(TrialStarted { group, runs: made, differs: p.differs })
}

/// The runs of a pair that won't go: stopped and archived (a failure is logged; the refusal stands either way).
async fn drop_runs(rt: &std::sync::Arc<crate::Runtime>, made: &[c::Created]) {
    for m in made {
        if let Err(err) = rt.stop(m.id.as_str(), true).await {
            tracing::warn!(error = %err, id = m.id.as_str(), "runtime.trial: stop");
        }
        if let Err(err) = rt.archive(m.id.as_str(), true).await {
            tracing::warn!(error = %err, id = m.id.as_str(), "runtime.trial: archive");
        }
    }
}

/// The folder is in a git checkout (a `.git` in it or above it).
async fn in_git(cwd: &str) -> bool {
    for d in std::path::Path::new(cwd).ancestors() {
        if tokio::fs::try_exists(d.join(".git")).await.unwrap_or(false) {
            return true;
        }
    }
    false
}
