//! The plugin's commands (each one's id is its permission: `worktrees.create` → `worktrees:create`).
//! Handlers are thin: the work is in `Engine`, `Cleanup`, `done` and `trust`.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use wisp_kernel::{Call, Ctx, Result as WireResult, Setup};
use wisp_worktrees_api as api;
use wisp_worktrees_core::sweep::{self, DiskLimits};

use crate::{State, done, prepare, trust};
use wisp_worktrees_core::offer;

/// After a new folder: sizes are stale, and past the cap one sweep comes a few minutes on.
async fn after_add(st: &Arc<State>, ctx: &Ctx, call: &Call, wt: &api::Worktree, session: &str) -> WireResult<()> {
    let (engine, cleanup, _) = st.parts(ctx).await?;
    ctx.emit(call, &api::WorktreeAdded { root: wt.root.clone(), path: wt.path.clone(), session_id: Some(session.to_owned()) });
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

pub async fn create(st: &Arc<State>, ctx: &Ctx, call: &Call, args: api::CreateArgs) -> WireResult<Option<api::Worktree>> {
    let (engine, _, port) = st.parts(ctx).await?;
    let Ok(here) = engine.repo(call, &args.cwd).await else {
        return Ok(None);
    };
    let set = port.settings().await;
    let hold = trust::setup_hold(&engine, &set.trust, &here.info().root, set.project_ask.as_deref(), &args.mode).await;
    let wt = engine.create(call, &args, hold).await?;
    if let Some(w) = &wt {
        after_add(st, ctx, call, w, &args.session_id).await?;
    }
    Ok(wt)
}

/// Bring in: the offer's paths become tasks in their folders (foreign: never cleaned up); the offer is looked
/// for again after, so what's left of it stays offered.
pub async fn bring_in(st: &Arc<State>, ctx: &Ctx, args: api::BringInArgs) -> WireResult<api::BringInOut> {
    let (_, _, p) = st.parts(ctx).await?;
    let offers = st.offers.lock().await.clone();
    let out = bring(p.as_ref(), &offers, args).await?;
    if !out.created.is_empty() {
        // v1 bring-in.js: how many came in (each task here starts fresh: none resumed a harness session)
        let props = serde_json::json!({ "n": out.created.len(), "resumed": 0 });
        let a =
            wisp_telemetry_api::TrackArgs { event: "worktrees_brought_in".into(), props: props.as_object().cloned().unwrap_or_default() };
        if let Err(err) = ctx.run::<wisp_telemetry_api::Track>(&ctx.root_call(), a).await {
            tracing::warn!(error = %err.message, "worktrees: telemetry.track");
        }
    }
    st.look_for_offers(ctx).await;
    st.refresh(ctx).await;
    Ok(out)
}

/// What Bring in does with the port: the project's folder, the offer's paths only, one task each.
pub async fn bring(p: &dyn crate::Port, offers: &[api::Offer], args: api::BringInArgs) -> WireResult<api::BringInOut> {
    let Some(root) = p.projects().await.into_iter().find(|(n, _)| *n == args.project).map(|(_, r)| r) else {
        return Err(crate::error::WtError::NotFound(format!("no project {}", args.project)).into());
    };
    let Some(o) = offers.iter().find(|o| o.project == args.project) else {
        return Ok(api::BringInOut { created: Vec::new(), skipped: args.paths });
    };
    let (take, skipped) = offer::takes(o, &args.paths);
    let mut created = Vec::new();
    for item in take {
        if let Some(id) = p.bring_in(item.clone(), root.clone()).await {
            created.push(id);
        }
    }
    Ok(api::BringInOut { created, skipped })
}

/// Keep a task's folders (the cleanup and Done leave them), or stop keeping them; an unknown task is `NotFound`.
pub async fn keep(p: &dyn crate::Port, args: api::KeepArgs) -> WireResult<()> {
    if !p.tasks().await.iter().any(|t| t.id == args.id) {
        return Err(crate::error::WtError::NotFound(format!("no task {}", args.id)).into());
    }
    p.set_kept(args.id, args.keep).await;
    Ok(())
}

/// Not now: the project is remembered as dismissed (its offer isn't made again).
pub async fn dismiss(p: &dyn crate::Port, project: &str) {
    let mut set = p.settings().await;
    if !set.dismissed.iter().any(|d| d == project) {
        set.dismissed.push(project.to_owned());
        p.save_settings(set).await;
    }
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
    handle!(s, st, api::Create, |st, ctx, call, args| create(&st, &ctx, &call, args).await);
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
        Ok(e.status(&call, &args.worktree, args.merged.as_deref()).await?)
    });
    handle!(s, st, api::View, |st, ctx, _call, _args| {
        let (_, c, _) = st.parts(&ctx).await?;
        let v = c.view(true).await;
        // the pane opened: look for Bring in offers again, and republish
        let (me, cx) = (st.clone(), ctx.clone());
        ctx.spawn(async move {
            me.look_for_offers(&cx).await;
            me.refresh(&cx).await;
        });
        Ok(v)
    });
    handle!(s, st, api::Clean, |st, ctx, _call, args| {
        let (_, c, _) = st.parts(&ctx).await?;
        let out = c.clean(args).await?;
        st.refresh(&ctx).await;
        Ok(out)
    });
    handle!(s, st, api::Keep, |st, ctx, _call, args| {
        let (_, _, p) = st.parts(&ctx).await?;
        keep(p.as_ref(), args).await?;
        st.refresh(&ctx).await;
        Ok(())
    });
    handle!(s, st, api::BringIn, |st, ctx, _call, args| bring_in(&st, &ctx, args).await);
    handle!(s, st, api::Dismiss, |st, ctx, _call, args| {
        let (_, _, p) = st.parts(&ctx).await?;
        dismiss(p.as_ref(), &args.project).await;
        st.offers.lock().await.retain(|o| o.project != args.project);
        st.refresh(&ctx).await;
        Ok(())
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
        let hooks = trust::hooks_of(&ctx, &args.agent);
        Ok(trust::pending(&set.trust, &args.dir, hooks.as_ref(), args.extra, &e.user_home).await)
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use crate::{MemPort, Port};
    use api::{Offer, OfferItem};

    fn item(path: &str) -> OfferItem {
        OfferItem { path: path.into(), branch: "b".into(), name: "n".into(), dirty: 0, chat: false }
    }

    #[tokio::test]
    async fn keep_pins_a_tasks_worktree_and_an_unknown_task_is_not_found() {
        let port = MemPort::new(vec![crate::TaskInfo { id: "t1".into(), ..crate::TaskInfo::default() }], crate::WtSettings::default());
        keep(port.as_ref(), api::KeepArgs { id: "t1".into(), keep: true }).await.unwrap();
        assert!(port.tasks().await[0].kept);
        keep(port.as_ref(), api::KeepArgs { id: "t1".into(), keep: false }).await.unwrap();
        assert!(!port.tasks().await[0].kept);
        assert!(keep(port.as_ref(), api::KeepArgs { id: "nope".into(), keep: true }).await.is_err());
    }

    /// Bring in makes one task per offered path, in the project's folder, and skips a path the offer doesn't
    /// hold; an unknown project is `NotFound`; Not now is remembered once.
    #[tokio::test]
    async fn bring_in_makes_tasks_of_the_offers_paths_and_not_now_is_remembered() {
        let port = MemPort::new(Vec::new(), crate::WtSettings::default());
        *port.projects.lock().unwrap() = vec![("app".into(), "/src/app".into())];
        let offers = vec![Offer {
            project: "app".into(),
            name: "app".into(),
            from: "git".into(),
            items: vec![item("/src/app-a"), item("/src/app-b")],
            detached: 0,
        }];
        let out = bring(
            port.as_ref(),
            &offers,
            api::BringInArgs { project: "app".into(), paths: vec!["/src/app-b".into(), "/tmp/other".into()] },
        )
        .await
        .unwrap();
        assert_eq!(out.created.len(), 1);
        assert_eq!(out.skipped, ["/tmp/other"]);
        assert_eq!(*port.brought.lock().unwrap(), [("/src/app-b".to_owned(), "/src/app".to_owned())]);
        let none = bring(port.as_ref(), &offers, api::BringInArgs { project: "web".into(), paths: vec![] }).await;
        assert!(none.is_err(), "no such project");
        dismiss(port.as_ref(), "app").await;
        dismiss(port.as_ref(), "app").await;
        assert_eq!(port.settings().await.dismissed, ["app"]);
    }
}
