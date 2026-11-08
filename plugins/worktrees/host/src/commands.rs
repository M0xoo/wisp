//! The plugin's commands (each one's id is its permission: `worktrees.create` → `worktrees:create`).
//! Handlers are thin: the work is in `Engine`, `Cleanup`, `done` and `trust`.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use wisp_kernel::{Call, Ctx, Result as WireResult, Setup};
use wisp_worktrees_api as api;
use wisp_worktrees_core::sweep::{self, DiskLimits};

use crate::{State, done, prepare, trust};

/// After a new folder: sizes are stale, and past the cap one sweep comes a few minutes on.
async fn after_add(
    st: &Arc<State>,
    ctx: &Ctx,
    call: &Call,
    wt: &api::Worktree,
    session: &str,
) -> WireResult<()> {
    let (engine, cleanup, _) = st.parts(ctx).await?;
    ctx.emit(
        call,
        &api::WorktreeAdded {
            root: wt.root.clone(),
            path: wt.path.clone(),
            session_id: Some(session.to_owned()),
        },
    );
    cleanup.added().await;
    if cleanup.past_cap().await && !st.cap_pending.swap(true, Ordering::SeqCst) {
        let (st, clock) = (st.clone(), engine.clock.clone());
        ctx.spawn(async move {
            clock.sleep(sweep::CAP_DELAY_MS).await;
            st.cap_pending.store(false, Ordering::SeqCst);
            cleanup.sweep(DiskLimits::default()).await;
        });
    }
    Ok(())
}

pub async fn create(
    st: &Arc<State>,
    ctx: &Ctx,
    call: &Call,
    args: api::CreateArgs,
) -> WireResult<Option<api::Worktree>> {
    let (engine, _, port) = st.parts(ctx).await?;
    let Ok(here) = engine.repo(call, &args.cwd).await else {
        return Ok(None);
    };
    let set = port.settings().await;
    let hold = trust::setup_hold(
        &engine,
        &set.trust,
        &here.info().root,
        set.project_ask.as_deref(),
        &args.mode,
    )
    .await;
    let wt = engine.create(call, &args, hold).await?;
    if let Some(w) = &wt {
        after_add(st, ctx, call, w, &args.session_id).await?;
    }
    Ok(wt)
}

macro_rules! handle {
    ($s:expr, $st:expr, $cmd:ty, |$p:ident, $ctx:ident, $call:ident, $args:ident| $body:expr) => {{
        let st = $st.clone();
        $s.command::<$cmd, _, _>(move |$ctx, $call, $args| {
            let $p = st.clone();
            async move { $body }
        });
    }};
}

pub fn register(s: &mut Setup, st: &Arc<State>) {
    handle!(s, st, api::Create, |st, ctx, call, args| create(
        &st, &ctx, &call, args
    )
    .await);
    handle!(s, st, api::Ensure, |st, ctx, call, args| {
        let (e, _, _) = st.parts(&ctx).await?;
        Ok(e.ensure(&call, &args.worktree).await?)
    });
    handle!(s, st, api::Remove, |st, ctx, call, args| {
        let (e, _, _) = st.parts(&ctx).await?;
        let r = e.remove(&call, &args.worktree, args.opts, None).await?;
        if r.removed {
            ctx.emit(
                &call,
                &api::WorktreeRemoved {
                    root: args.worktree.root.clone(),
                    path: args.worktree.path.clone(),
                    branch_deleted: r.branch_deleted,
                },
            );
        }
        Ok(r)
    });
    handle!(s, st, api::Status, |st, ctx, call, args| {
        let (e, _, _) = st.parts(&ctx).await?;
        Ok(e.status(&call, &args.worktree, args.merged.as_deref())
            .await?)
    });
    handle!(s, st, api::View, |st, ctx, _call, _args| {
        let (_, c, _) = st.parts(&ctx).await?;
        Ok(c.view(true).await)
    });
    handle!(s, st, api::Clean, |st, ctx, _call, args| {
        let (_, c, _) = st.parts(&ctx).await?;
        Ok(c.clean(args).await?)
    });
    handle!(s, st, api::Sweep, |st, ctx, _call, _args| {
        let (_, c, _) = st.parts(&ctx).await?;
        Ok(c.sweep(DiskLimits::default()).await)
    });
    handle!(s, st, api::DoneFolders, |st, ctx, call, args| {
        let (e, _, p) = st.parts(&ctx).await?;
        Ok(done::list(&e, p.as_ref(), &call, &args.session_id, args.sizes).await)
    });
    handle!(s, st, api::DoneApply, |st, ctx, call, args| {
        let (e, _, p) = st.parts(&ctx).await?;
        Ok(done::apply(&e, p.as_ref(), &call, &args).await?)
    });
    handle!(s, st, api::DoneTidy, |st, ctx, call, args| {
        let (e, _, p) = st.parts(&ctx).await?;
        Ok(done::tidy(&e, p.as_ref(), &call, &args.session_id).await)
    });
    handle!(s, st, api::Trust, |st, ctx, _call, args| {
        let (e, _, p) = st.parts(&ctx).await?;
        let mut set = p.settings().await;
        set.trust.trust(&args.key, &args.ids, e.clock.now_ms());
        p.save_settings(set).await;
        Ok(match &args.worktree {
            Some(wt) => prepare::run_held(&e, wt).await,
            None => None,
        })
    });
    handle!(s, st, api::TrustPending, |st, ctx, _call, args| {
        let (e, _, p) = st.parts(&ctx).await?;
        let set = p.settings().await;
        Ok(trust::pending(&set.trust, &args.dir, &args.agent, args.extra, &e.user_home).await)
    });
}
