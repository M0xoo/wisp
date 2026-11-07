//! wisp-ship: the wisp.ship plugin. Ship it commits what a worktree task left, pushes its branch and
//! opens (or updates) its PR; it follows the PR (checks, reviews, conflicts), sends the task a follow-up
//! to merge its base in when it conflicts, and squash-merges the exact head that was reviewed. git runs
//! only through `git.service@^1`, gh only through the kernel's proc service, all of it async.

pub mod error;
pub mod flow;
pub mod follow;
pub mod gh;
pub mod ops;
pub mod routes;
pub mod ship;
pub mod tasks;

use std::sync::Arc;

use wisp_git_api::GitServiceV1;
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup};
use wisp_proc::Proc;
use wisp_ship_api as api;
use wisp_ship_core::follow::PR_TICK_MS;
use wisp_ship_core::recheck::BOOT_DELAY_MS;

pub use error::ShipError;
pub use ops::Shipper;
pub use ship::{Out, Ship, Sink};
pub use tasks::Tasks;

#[derive(Debug, Default)]
pub struct ShipPlugin {
    slot: routes::Slot,
}

impl ShipPlugin {
    pub fn new() -> Self {
        Self::default()
    }
    /// The running Ship (after start), for an install's own wiring and tests.
    pub fn ship(&self) -> Option<Arc<Ship>> {
        self.slot.get().cloned()
    }
}

/// Each announcement as its event, after the call that made it.
fn sink(ctx: &Ctx) -> ship::Sink {
    let ctx = ctx.clone();
    Arc::new(move |out| {
        let call = ctx.root_call();
        match out {
            Out::Step { session, shipping } => ctx.emit(&call, &api::ShipStep { session, shipping }),
            Out::ToShip { session, to_ship } => ctx.emit(&call, &api::ToShipChanged { session, to_ship }),
            Out::PrOpened { session, repo, pr } => ctx.emit(&call, &api::PrOpened { session, repo, pr }),
            Out::PrChanged { session, pr, news } => ctx.emit(&call, &api::PrChanged { session, pr, news }),
            Out::Merged { session, prs, sync } => ctx.emit(&call, &api::PrMerged { session, prs, sync }),
            Out::FollowUp { session, prompt } => ctx.emit(&call, &api::FollowUpWanted { session, prompt }),
            Out::Fix { .. } => {}
        }
    })
}

fn get(slot: &routes::Slot) -> Result<Arc<Ship>> {
    slot.get().cloned().ok_or_else(|| wisp_kernel::WireError::unavailable("wisp.ship is starting"))
}

fn commands(s: &mut Setup, slot: &routes::Slot) {
    let sl = slot.clone();
    s.command::<api::Track, _, _>(move |_ctx, _call, task| {
        let sl = sl.clone();
        async move {
            get(&sl)?.tasks.put(task);
            Ok(())
        }
    });
    let sl = slot.clone();
    s.command::<api::View, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.view(&call, &a.session, &a.draft).await?) }
    });
    let sl = slot.clone();
    s.command::<api::ShipIt, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.ship_all(&call, &a.session, &a.title, &a.body, a.draft).await?) }
    });
    let sl = slot.clone();
    s.command::<api::Refresh, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.refresh(&call, &a.session).await?) }
    });
    let sl = slot.clone();
    s.command::<api::Details, _, _>(move |_ctx, _call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.details(&a.session).await?) }
    });
    let sl = slot.clone();
    s.command::<api::Merge, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.merge_all(&call, &a.session).await?) }
    });
    let sl = slot.clone();
    s.command::<api::Attach, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.attach(&call, &a.session, &a.pr, a.remove).await?) }
    });
    let sl = slot.clone();
    s.command::<api::FixConflicts, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { get(&sl)?.fix_conflicts(&call, &a.session, true).await?.ok_or_else(|| wisp_kernel::WireError::conflict("Could not start the fix: try again in a moment.")) }
    });
    let sl = slot.clone();
    s.command::<api::Recheck, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.recheck(&call, &a.session, a.lazy).await?) }
    });
    let sl = slot.clone();
    s.command::<api::CheckLog, _, _>(move |_ctx, _call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.check_log(&a.session, &a.url).await?) }
    });
}

impl Plugin for ShipPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        commands(s, &self.slot);
        for r in routes::routes(&self.slot) {
            s.route(r);
        }
        let slot = self.slot.clone();
        s.on_start(move |ctx| async move {
            let proc = ctx.service::<Proc>()?;
            let shipper = Shipper { git: ctx.use_service::<GitServiceV1>()?, gh: gh::Gh::new((*proc).clone(), "gh"), owner: ctx.scope().clone(), clock: ctx.clock()? };
            let ship = Arc::new(Ship::new(shipper, Arc::new(Tasks::default()), sink(&ctx)));
            let _ = slot.set(ship.clone());
            start_timers(&ctx, &ship)
        });
        Ok(())
    }
}

/// The boot recheck once the page has loaded, and the 5 s PR tick. Both die with the plugin's scope.
fn start_timers(ctx: &Ctx, ship: &Arc<Ship>) -> Result<()> {
    let clock = ctx.clock()?;
    let (boot, call) = (ship.clone(), ctx.root_call());
    let c = clock.clone();
    ctx.spawn(async move {
        c.sleep(BOOT_DELAY_MS).await;
        let sleeper = c.clone();
        boot.boot(&call, Arc::new(move |ms| sleeper.sleep(ms))).await;
    });
    let (poller, call) = (ship.clone(), ctx.root_call());
    ctx.spawn(async move {
        loop {
            clock.sleep(PR_TICK_MS).await;
            poller.poll(&call).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests;
