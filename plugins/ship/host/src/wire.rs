//! Ship it wired to runtime: which tasks it follows (a session with a worktree, from `session.changed`
//! and at start), whether each is running or asking, a turn's end (recheck what's left to ship, finish
//! a conflict fix), its slot kept on the session (`ext["wisp.ship"]`, one writer so the latest state
//! lands last) and the list row's fields from that slot (`runtime.summary@1`), and the follow-ups it
//! asks for sent as the task's next turn.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use wisp_kernel::{Call, Ctx, Setup};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::events::{SessionChanged, SessionDeleted, TurnEnded, TurnStarted};
use wisp_runtime_api::model::{Session, SessionState, Turn};
use wisp_runtime_api::points::{SUMMARY, SummaryField};
use wisp_ship_api::PLUGIN;
use wisp_ship_core::slot::{self, Facts};

use crate::follow::TurnEnd;
use crate::{Ship, Slot};

const WORKTREES: &str = "wisp.worktrees";

/// The slot each session holds now, as last read or written: a write that says the same is skipped.
#[derive(Debug, Default)]
pub struct Known(Mutex<HashMap<String, Value>>);

impl Known {
    fn set(&self, id: &str, v: Value) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned(), v);
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned()
    }
    fn forget(&self, id: &str) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }
}

/// What ship reads of a session.
pub fn facts_of(s: &Session) -> Facts {
    Facts {
        session: s.id.0.clone(),
        cwd: s.cwd.clone(),
        worktree: slot::worktree_of(s.ext_of(WORKTREES)),
        archived: s.archived,
        // a subagent's task (not a crew member's): its lead ships
        child: s.parent_id.is_some() && s.ext_of("wisp.crew").is_null(),
        updated_at: s.updated_at,
    }
}

/// Follows the session as it is now: starts, updates or drops its task, and says whether it runs.
pub fn follow_session(ship: &Ship, known: &Known, s: &Session) {
    let id = s.id.as_str();
    let kept = s.ext_of(PLUGIN);
    known.set(id, kept.clone());
    let had = ship.tasks.get(id);
    let fresh = had.is_none();
    match slot::sync(had.or_else(|| slot::restore(id, kept)), &facts_of(s)) {
        Some(t) => ship.tasks.put(t),
        None => ship.tasks.remove(id),
    }
    // running comes from turn.started / turn.ended once followed: a read taken mid-turn that lands after
    // the turn's end must not mark an idle task running again
    if fresh {
        ship.tasks.set_live(id, s.state == SessionState::Running);
    }
    ship.tasks.set_asking(id, s.state == SessionState::Waiting);
}

async fn session(ctx: &Ctx, call: &Call, id: &str) -> Option<Session> {
    ctx.run::<rt::Get>(call, rt::IdArgs { id: id.into() }).await.ok()
}

/// `runtime.summary@1`: Ship it's fields on the task's row.
struct Row;

impl SummaryField for Row {
    fn plugin(&self) -> &str {
        PLUGIN
    }
    fn fields(&self, session: &Session, _last: Option<&Turn>, out: &mut BTreeMap<String, Value>) {
        slot::row_fields(session.ext_of(PLUGIN), out);
    }
}

/// The one writer of the slot: ids come in as tasks change; each write takes the task as it is then.
fn start_writer(ctx: &Ctx, ship: &Arc<Ship>, known: &Arc<Known>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    ship.tasks.on_change(Arc::new(move |id| {
        let _ = tx.send(id.to_owned());
    }));
    let (cx, ship, known) = (ctx.clone(), ship.clone(), known.clone());
    ctx.spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut ids = vec![first];
            while let Ok(more) = rx.try_recv() {
                if !ids.contains(&more) {
                    ids.push(more);
                }
            }
            for id in ids {
                let Some(task) = ship.tasks.get(&id) else { continue };
                let value = slot::ext_of(&task);
                let was = known.get(&id);
                if was.as_ref().is_some_and(|w| slot::same_news(w, &value)) {
                    continue;
                }
                known.set(&id, value.clone());
                let review = slot::new_head(was.as_ref(), &value);
                let a = rt::SetExtArgs { id: id.as_str().into(), plugin: PLUGIN.into(), value, expect: None };
                if let Err(e) = cx.run::<rt::SetExt>(&cx.root_call(), a).await {
                    known.forget(&id);
                    tracing::warn!(error = %e.message, task = %id, "ship: keeping its slot on the task");
                } else if review {
                    ask_review(&cx, &id);
                }
            }
        }
    });
}

/// The open PR has a new head (Ship it pushed, a fix landed): review by another harness decides
/// whether to read it (the setting, the head it last read). Asked after the slot it reads is written.
fn ask_review(ctx: &Ctx, id: &str) {
    let (c, id) = (ctx.clone(), id.to_owned());
    ctx.spawn(async move {
        // wisp.review may be off or absent: then nobody reviews, as asked
        let _ = c.run::<wisp_review_api::MaybeReview>(&c.root_call(), wisp_review_api::MaybeArgs { id, force: false }).await;
    });
}

/// A follow-up ship asks for (merge the base in), queued behind a running turn, by wisp.
pub(crate) fn send_follow_up(ctx: &Ctx, session: String, prompt: String) {
    if prompt.is_empty() {
        return;
    }
    let c = ctx.clone();
    ctx.spawn(async move {
        let a = rt::FollowUpArgs {
            id: session.as_str().into(),
            text: prompt,
            queue: Some(true),
            by: Some("wisp".into()),
            ..rt::FollowUpArgs::default()
        };
        if let Err(e) = c.run::<rt::FollowUp>(&c.root_call(), a).await {
            tracing::warn!(error = %e.message, task = %session, "ship: sending the conflict fix");
        }
    });
}

/// A turn ended: a conflict fix pushes (or says why not), then what's left to ship is checked again
/// (more changes after a merge bring Ship it back).
async fn turn_ended(ctx: &Ctx, ship: &Arc<Ship>, known: &Known, e: &TurnEnded) {
    let call = ctx.root_call();
    let id = e.session_id.as_str();
    let s = session(ctx, &call, id).await;
    if let Some(s) = &s {
        follow_session(ship, known, s);
    }
    ship.tasks.set_live(id, false);
    if ship.tasks.get(id).is_none() {
        return;
    }
    let end = TurnEnd { interrupted: e.interrupted, queued: s.as_ref().is_some_and(|s| !s.queue.is_empty()), error: e.error_text.clone() };
    let _ = ship.finish_fix(&call, id, end).await;
    let _ = ship.recheck(&call, id, false).await;
}

/// Every open task with a worktree, once the page has loaded; then the boot recheck drains them.
pub(crate) async fn boot(ctx: &Ctx, ship: &Arc<Ship>, known: &Known) {
    let call = ctx.root_call();
    let list = ctx.run::<rt::List>(&call, rt::ListArgs { archived: None, limit: None }).await.unwrap_or_default();
    for row in list {
        if let Some(s) = session(ctx, &call, row.id.as_str()).await {
            follow_session(ship, known, &s);
        }
    }
}

/// Subscribes and contributes; the returned `Known` goes to `start` once the ship is there.
pub(crate) fn register(s: &mut Setup, slot: &Slot) -> Arc<Known> {
    s.contribute(&SUMMARY, Arc::new(Row) as Arc<dyn SummaryField>);
    let known = Arc::new(Known::default());
    let (sl, kn) = (slot.clone(), known.clone());
    s.on::<SessionChanged, _, _>(move |ctx, e| {
        let (sl, kn) = (sl.clone(), kn.clone());
        async move {
            let Some(ship) = sl.get() else { return };
            if let Some(s) = session(&ctx, &ctx.root_call(), e.id.as_str()).await {
                follow_session(&ship, &kn, &s);
            }
        }
    });
    let (sl, kn) = (slot.clone(), known.clone());
    s.on::<SessionDeleted, _, _>(move |_ctx, e| {
        let (sl, kn) = (sl.clone(), kn.clone());
        async move {
            if let Some(ship) = sl.get() {
                ship.tasks.remove(e.id.as_str());
                ship.tasks.set_live(e.id.as_str(), false);
            }
            kn.forget(e.id.as_str());
        }
    });
    let sl = slot.clone();
    s.on::<TurnStarted, _, _>(move |_ctx, e| {
        let sl = sl.clone();
        async move {
            if let Some(ship) = sl.get() {
                ship.tasks.set_live(e.session_id.as_str(), true);
            }
        }
    });
    let (sl, kn) = (slot.clone(), known.clone());
    s.on::<TurnEnded, _, _>(move |ctx, e| {
        let (sl, kn) = (sl.clone(), kn.clone());
        async move {
            let Some(ship) = sl.get() else { return };
            // off the event's way: git and gh take a while
            let c = ctx.clone();
            ctx.spawn(async move { turn_ended(&c, &ship, &kn, &e).await });
        }
    });
    known
}

/// Once the ship is there: the slot's writer.
pub(crate) fn start(ctx: &Ctx, ship: &Arc<Ship>, known: &Arc<Known>) {
    start_writer(ctx, ship, known);
}
