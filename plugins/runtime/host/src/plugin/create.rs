//! `runtime.create` (a worktree of its own and the project's setup, a terminal, the queued steps) and
//! `runtime.followUp` (a terminal task's follow-up goes to its terminal).

use std::sync::Arc;

use wisp_kernel::{Call, Ctx, Result as WireResult, Setup, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::commands::{self as c, StartArgs};
use wisp_runtime_api::hooks::{BeforeCreate, BeforeFollowUp};
use wisp_store::Store;

use super::{Slot, rt};
use crate::kinds::Kinds;
use crate::runtime::Runtime;

/// Registers `runtime.create` and `runtime.followUp`.
pub(super) fn create_and_follow_up(s: &mut Setup, slot: &Slot, made_kinds: Arc<Kinds>) {
    let ctx = s.ctx();
    let (c1, c2) = (ctx.clone(), ctx);
    let start = slot.clone();
    s.command::<c::Create, _, _>(move |_ctx, call, a| {
        let (slot, ctx, kinds) = (start.clone(), c1.clone(), made_kinds.clone());
        // boxed: a create runs its first turn, whose future is large (clippy large_futures)
        async move { Box::pin(create(&ctx, &call, &slot, &kinds, a)).await }
    });
    let follow = slot.clone();
    s.command::<c::FollowUp, _, _>(move |_ctx, call, a| {
        let (slot, ctx) = (follow.clone(), c2.clone());
        async move {
            let a = ctx.run_hook::<BeforeFollowUp>(&call, a).await?;
            let rt = rt(&slot)?;
            if rt.repo.session(a.id.as_str()).await.is_ok_and(|s| crate::term::term_of(&s).is_some()) {
                return crate::term::follow_up(&ctx, &call, &rt, a.id.as_str(), &a.text).await;
            }
            rt.follow_up(a).await.map_err(WireError::from)
        }
    });
}

async fn create(ctx: &Ctx, call: &Call, slot: &Slot, kinds: &Kinds, a: StartArgs) -> WireResult<c::Created> {
    let mut a = ctx.run_hook::<BeforeCreate>(call, a).await?;
    if let Some(rest) = crate::term::slash(&a.prompt) {
        a.prompt = rest;
        a.terminal = true;
    }
    let (store, proc) = (ctx.service::<Store>()?, ctx.service::<Proc>()?);
    let home = wisp_kernel::services::paths(ctx).ok().map(|p| p.home().to_owned());
    // a worktree of its own: made before the first turn, the project's setup run in it
    let p = crate::specs::prepare(&store, &proc, home.as_deref(), Some(kinds), a).await?;
    let rt = rt(slot)?;
    let mut args = p.args;
    let on = ctx.setting("terminal.terminalSessions").is_some_and(|v| v == true || v == "on");
    args.terminal = crate::term::starts_in_terminal(&args, on)
        && rt
            .harness(args.agent.as_deref().unwrap_or("claude"))
            .is_ok_and(|h| h.resume_command(&wisp_runtime_api::harness::ResumeOptions::default()).is_some());
    let terminal = args.terminal;
    let wants_tree = args.worktree == Some(true) && !args.hold && args.cwd.as_deref().is_some_and(|c| !c.is_empty());
    let setup = if wants_tree { crate::specs::project_setup(Some(kinds), &args).await } else { Vec::new() };
    args.hold |= wants_tree;
    let (cwd, title, mode) = (args.cwd.clone().unwrap_or_default(), args.title.clone().unwrap_or_default(), args.mode);
    let made = rt.create(args).await.map_err(WireError::from)?;
    let made = if wants_tree {
        let mode =
            mode.map(|m| serde_json::to_value(m).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()).unwrap_or_default();
        let wa = wisp_worktrees_api::CreateArgs { session_id: made.id.0.clone(), cwd, title, mode };
        in_worktree(ctx, call, &rt, &proc, made, wa, &setup).await?
    } else {
        made
    };
    if terminal {
        crate::term::open(ctx, call, &rt, made.id.as_str(), None, (None, None)).await?;
    }
    // the steps after the first go in the queue, in order: each starts when the turn before ends
    for text in p.steps {
        let f = c::FollowUpArgs { id: made.id.clone(), text, queue: Some(true), by: Some("step".into()), ..c::FollowUpArgs::default() };
        rt.follow_up(f).await.map_err(WireError::from)?;
    }
    Ok(made)
}

/// The held task's worktree, made and set up; then its first turn starts (in its folder if that failed).
async fn in_worktree(
    ctx: &Ctx,
    call: &Call,
    rt: &Arc<Runtime>,
    proc: &Proc,
    made: c::Created,
    wa: wisp_worktrees_api::CreateArgs,
    setup: &[String],
) -> WireResult<c::Created> {
    let wt = match ctx.run::<wisp_worktrees_api::Create>(call, wa).await {
        Ok(w) => w.and_then(|w| serde_json::to_value(w).ok()),
        Err(err) => {
            tracing::warn!(error = %err.message, task = made.id.as_str(), "runtime: worktrees.create (it runs in its folder)");
            None
        }
    };
    let failed = match wt.as_ref().and_then(|w| w.get("path")).and_then(serde_json::Value::as_str) {
        Some(dir) if !setup.is_empty() => crate::specs::run_setup(proc, dir, setup).await,
        _ => None,
    };
    let turn_id = rt.worktree_ready(made.id.as_str(), wt, failed).await.map_err(WireError::from)?;
    Ok(c::Created { id: made.id, turn_id })
}
