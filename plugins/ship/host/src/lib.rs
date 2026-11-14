//! wisp-ship: the wisp.ship plugin. Ship it commits what a worktree task left, pushes its branch and
//! opens (or updates) its PR; it follows the PR (checks, reviews, conflicts), sends the task a follow-up
//! to merge its base in when it conflicts, and squash-merges the exact head that was reviewed. git runs
//! only through `git.service@^1`, gh only through the kernel's proc service, all of it async.

mod agent;
pub mod draft;
pub mod error;
pub mod flow;
pub mod follow;
pub mod gh;
pub mod ops;
pub mod ship;
pub mod tasks;
pub mod wire;

use std::sync::Arc;

use wisp_git_api::GitServiceV1;
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup};
use wisp_proc::Proc;
use wisp_ship_api as api;
use wisp_ship_core::follow::PR_TICK_MS;
use wisp_ship_core::recheck::BOOT_DELAY_MS;

/// The started ship, once its services are there. Each start puts its own (switched off and on, the
/// new one's tasks and writer replace the old one's).
#[derive(Debug, Default)]
pub struct Cell(std::sync::RwLock<Option<Arc<Ship>>>);

impl Cell {
    pub fn get(&self) -> Option<Arc<Ship>> {
        self.0.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
    fn set(&self, ship: Arc<Ship>) {
        *self.0.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(ship);
    }
}

pub type Slot = Arc<Cell>;

pub use error::ShipError;
pub use ops::Shipper;
pub use ship::{Out, Ship, Sink};
pub use tasks::Tasks;

#[derive(Debug, Default)]
pub struct ShipPlugin {
    slot: Slot,
}

impl ShipPlugin {
    pub fn new() -> Self {
        Self::default()
    }
    /// The running Ship (after start), for an install's own wiring and tests.
    pub fn ship(&self) -> Option<Arc<Ship>> {
        self.slot.get()
    }
}

/// Each announcement as its event, after the call that made it.
fn sink(ctx: &Ctx) -> ship::Sink {
    let ctx = ctx.clone();
    Arc::new(move |out| {
        let call = ctx.root_call();
        match out {
            Out::Step { session, shipping } => {
                ctx.emit(&call, &api::ShipStep { session, shipping });
            }
            Out::ToShip { session, to_ship } => {
                ctx.emit(&call, &api::ToShipChanged { session, to_ship });
            }
            Out::PrOpened { session, repo, pr } => {
                ctx.emit(&call, &api::PrOpened { session, repo, pr });
            }
            Out::PrChanged { session, pr, news } => {
                ctx.emit(&call, &api::PrChanged { session, pr, news });
            }
            Out::Merged { session, prs, sync } => {
                ctx.emit(&call, &api::PrMerged { session, prs, sync });
            }
            Out::FollowUp { session, prompt } => {
                ctx.emit(&call, &api::FollowUpWanted { session: session.clone(), prompt: prompt.clone() });
                wire::send_follow_up(&ctx, session, prompt);
            }
            Out::Fix { .. } => {}
        }
    })
}

fn get(slot: &Slot) -> Result<Arc<Ship>> {
    slot.get().ok_or_else(|| wisp_kernel::WireError::unavailable("wisp.ship is starting"))
}

fn commands(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<api::Track, _, _>(move |_ctx, _call, task| {
        let sl = sl.clone();
        async move {
            get(&sl)?.tasks.put(task);
            Ok(())
        }
    });
    let sl = slot.clone();
    s.command::<api::View, _, _>(move |ctx, call, a| {
        let sl = sl.clone();
        async move {
            let ship = get(&sl)?;
            let d = if a.draft.title.is_empty() { draft::draft_for(&ctx, &call, &a.session).await } else { a.draft };
            Ok(ship.view(&call, &a.session, &d).await?)
        }
    });
    let sl = slot.clone();
    s.command::<api::ShipIt, _, _>(move |ctx, call, a| {
        let sl = sl.clone();
        async move {
            let out = get(&sl)?.ship_all(&call, &a.session, &a.title, &a.body, a.draft).await?;
            track(&ctx, "ship", serde_json::json!({ "draft": a.draft }));
            Ok(out)
        }
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
    s.command::<api::Merge, _, _>(move |ctx, call, a| {
        let sl = sl.clone();
        async move {
            let out = get(&sl)?.merge_all(&call, &a.session).await?;
            track(&ctx, "merge", serde_json::json!({}));
            Ok(out)
        }
    });
    let sl = slot.clone();
    s.command::<api::Attach, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move { Ok(get(&sl)?.attach(&call, &a.session, &a.pr, a.remove).await?) }
    });
    let sl = slot.clone();
    s.command::<api::FixConflicts, _, _>(move |_ctx, call, a| {
        let sl = sl.clone();
        async move {
            get(&sl)?
                .fix_conflicts(&call, &a.session, true)
                .await?
                .ok_or_else(|| wisp_kernel::WireError::conflict("Could not start the fix: try again in a moment."))
        }
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
        agent::register(s, &self.slot);
        let known = wire::register(s, &self.slot);
        let slot = self.slot.clone();
        s.on_start(move |ctx| {
            let known = known.clone();
            async move {
                let proc = ctx.service::<Proc>()?;
                let shipper = Shipper {
                    git: ctx.use_service::<GitServiceV1>()?,
                    gh: gh::Gh::new((*proc).clone(), "gh"),
                    owner: ctx.scope().clone(),
                    clock: ctx.clock()?,
                };
                let ship = Arc::new(Ship::new(shipper, Arc::new(Tasks::default()), sink(&ctx)));
                slot.set(ship.clone());
                wire::start(&ctx, &ship, &known);
                start_timers(&ctx, &ship, known)
            }
        });
        Ok(())
    }
}

/// Fix a task's PR conflicts without asking (v1 `defaults.fixConflicts: 'on'`); off unless on.
pub const FIX_CONFLICTS: &str = "ship.fixConflicts";

/// The setting as stored: `true`, or v1's `"on"`.
pub fn fix_conflicts(v: Option<&serde_json::Value>) -> bool {
    matches!(v, Some(serde_json::Value::Bool(true))) || v.and_then(serde_json::Value::as_str) == Some("on")
}

/// The boot recheck once the page has loaded (the tasks with a worktree first), and the 5 s PR tick. Both die with the plugin's scope.
fn start_timers(ctx: &Ctx, ship: &Arc<Ship>, known: Arc<wire::Known>) -> Result<()> {
    let clock = ctx.clock()?;
    let (boot, call, bx) = (ship.clone(), ctx.root_call(), ctx.clone());
    let c = clock.clone();
    ctx.spawn(async move {
        c.sleep(BOOT_DELAY_MS).await;
        wire::boot(&bx, &boot, &known).await;
        let sleeper = c.clone();
        boot.boot(&call, Arc::new(move |ms| sleeper.sleep(ms))).await;
    });
    let (poller, call, cx) = (ship.clone(), ctx.root_call(), ctx.clone());
    ctx.spawn(async move {
        loop {
            clock.sleep(PR_TICK_MS).await;
            // v1 `defaults.fixConflicts`: read each tick, so switching it in Settings counts at the next look
            poller.set_auto_fix(fix_conflicts(cx.setting(FIX_CONFLICTS).as_ref()));
            poller.poll(&call).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests;

/// A usage event (wisp.telemetry decides whether it goes), off the caller's way.
fn track(ctx: &wisp_kernel::Ctx, event: &'static str, props: serde_json::Value) {
    let c = ctx.clone();
    ctx.spawn(async move {
        let _ = c.run_json(&c.root_call(), "telemetry.track", serde_json::json!({ "event": event, "props": props })).await;
    });
}
