//! wisp.later host: follow-ups and reminders scheduled on tasks, plans that start a task at a time
//! (or after another task is done), and the agent's own wake-ups (`resume_later`). The decisions are
//! `wisp-later-core`'s; this crate keeps the rows (store.rs), reads tasks from wisp.runtime, asks
//! wisp.budget what holds an account back, and looks again on the kernel's clock.
//!
//! Times are written in UTC (`TZ` 0) until wisp.settings carries the user's offset.

mod store;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_later_api::commands as c;
use wisp_later_api::{BY_AGENT, LaterEntry, LaterHeld, PER_TICK, PLUGIN_ID, Plan, PlanKind, SentMeta, TICK_MS};
use wisp_later_core::{Action, PlanAction, Task, TaskMeta, TaskState, due, due_plans, next_at, rules};
use wisp_store::Store;

const TZ: i32 = 0;

struct State {
    store: Store,
    entries: Mutex<Vec<LaterEntry>>,
    plans: Mutex<Vec<Plan>>,
    metas: Mutex<HashMap<String, TaskMeta>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

type Slot = Arc<OnceLock<Arc<State>>>;

fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.later is starting"))
}

fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

fn wire(e: wisp_later_core::LaterError) -> WireError {
    match e {
        wisp_later_core::LaterError::Invalid(m) => WireError::invalid(m),
        wisp_later_core::LaterError::NotFound(m) => WireError::not_found(m),
        wisp_later_core::LaterError::Conflict(m) => WireError::conflict(m),
    }
}

/// What wisp.later needs of a task, as wisp.runtime has it; None: it's gone.
async fn task_of(ctx: &Ctx, call: &Call, id: &str) -> Option<Task> {
    let s = ctx.run_json(call, "runtime.get", json!({ "id": id })).await.ok()?;
    let st = s["state"].as_str().unwrap_or("review");
    Some(Task {
        id: id.to_owned(),
        title: s["title"].as_str().unwrap_or_default().to_owned(),
        agent: s["agent"].as_str().unwrap_or_default().to_owned(),
        account: s["account"].as_str().filter(|a| !a.is_empty()).unwrap_or("default").to_owned(),
        state: TaskState::parse(st).unwrap_or(TaskState::Review),
        archived: s["archived"].as_bool().unwrap_or(false),
        busy: st == "running",
        asking: st == "waiting" || !s["ext"]["wisp.runtime"]["ask"].is_null(),
        delegates: false,
        sub: s["parentId"].is_string(),
        tour: s["agent"] == "wisp",
    })
}

impl State {
    fn meta(&self, id: &str) -> TaskMeta {
        lock(&self.metas).get(id).cloned().unwrap_or_default()
    }

    fn of_task(&self, id: &str) -> Vec<LaterEntry> {
        lock(&self.entries).iter().filter(|l| l.session_id == id).cloned().collect()
    }

    async fn write(&self, ops: store::Ops) -> Result<()> {
        self.store.write(move |w| ops.apply(w)).await.map_err(WireError::from)
    }

    /// The task's ext slot, so its list row shows what is scheduled.
    async fn mirror(&self, ctx: &Ctx, call: &Call, id: &str) {
        let ext = self.meta(id).ext(&self.of_task(id));
        let _ = ctx.run_json(call, "runtime.setExt", json!({ "id": id, "plugin": PLUGIN_ID, "value": ext })).await;
    }

    async fn add(&self, ctx: &Ctx, call: &Call, a: &c::AddArgs) -> Result<LaterEntry> {
        let task = task_of(ctx, call, &a.session_id).await.ok_or_else(|| WireError::not_found("No such task."))?;
        let pending = self.of_task(&a.session_id).len();
        let l = rules::new_entry(wisp_kernel::ids::uuid7(), &task, &self.meta(&a.session_id), pending, a, now(ctx), TZ).map_err(wire)?;
        lock(&self.entries).push(l.clone());
        self.write(store::Ops { entries: vec![l.clone()], ..store::Ops::default() }).await?;
        self.mirror(ctx, call, &a.session_id).await;
        Ok(l)
    }

    fn take(&self, ids: &[String]) -> Vec<LaterEntry> {
        let mut all = lock(&self.entries);
        let (gone, keep): (Vec<LaterEntry>, Vec<LaterEntry>) = std::mem::take(&mut *all).into_iter().partition(|l| ids.contains(&l.id));
        *all = keep;
        gone
    }

    /// A follow-up goes into its task now.
    async fn fire(&self, ctx: &Ctx, call: &Call, l: &LaterEntry, late: bool) -> Result<Value> {
        let sent = SentMeta { by: l.by.clone(), set_at: l.set_at, at: l.at, late };
        let note = rules::late_note(&sent, now(ctx), TZ);
        let mut m = self.meta(&l.session_id);
        m.sent = Some(sent);
        lock(&self.metas).insert(l.session_id.clone(), m.clone());
        self.write(store::Ops { drop_entries: vec![l.id.clone()], metas: vec![(l.session_id.clone(), m)], ..store::Ops::default() }).await?;
        let text = format!("{note}\n\n{}", l.text);
        ctx.run_json(call, "runtime.followUp", json!({ "id": l.session_id, "text": text, "by": "later", "attachments": l.attachments })).await
    }

    /// A reminder (or a missed follow-up) brings the task back to Needs you with its text.
    async fn remind(&self, ctx: &Ctx, call: &Call, task: &Task, l: &LaterEntry, text: String, missed: bool) -> Result<()> {
        let (reminder, _) = rules::reminder_of(task, l, text, missed);
        let mut m = self.meta(&l.session_id);
        m.reminder = Some(reminder);
        lock(&self.metas).insert(l.session_id.clone(), m.clone());
        self.write(store::Ops { drop_entries: vec![l.id.clone()], metas: vec![(l.session_id.clone(), m)], ..store::Ops::default() }).await?;
        let _ = ctx.run_json(call, "runtime.note", json!({ "id": l.session_id, "text": l.text })).await;
        Ok(())
    }

    /// One look (v1 later.js tick): what came due goes, at most `PER_TICK` at once.
    #[allow(clippy::too_many_lines)] // one arm per decision, as v1's tick
    async fn tick(&self, ctx: &Ctx, call: &Call) -> u32 {
        let at = now(ctx);
        let entries = lock(&self.entries).clone();
        let plans = lock(&self.plans).clone();
        let mut ids: Vec<String> = entries.iter().map(|l| l.session_id.clone()).collect();
        ids.extend(plans.iter().filter_map(|p| p.after.as_ref().map(|a| a.id.clone())));
        ids.sort();
        ids.dedup();
        let mut tasks = BTreeMap::new();
        let mut holds: HashMap<(String, String), Option<LaterHeld>> = HashMap::new();
        for id in ids {
            let Some(t) = task_of(ctx, call, &id).await else { continue };
            let key = (t.agent.clone(), t.account.clone());
            if let std::collections::hash_map::Entry::Vacant(slot) = holds.entry(key) {
                let h = ctx.run_json(call, "budget.hold", json!({ "agent": t.agent, "account": t.account })).await.ok().filter(|h| !h.is_null());
                slot.insert(h.map(|h| LaterHeld { why: h["why"].as_str().unwrap_or_default().to_owned(), until: h["until"].as_i64().unwrap_or(at), load: h["load"].as_bool().unwrap_or(false) }));
            }
            tasks.insert(id, t);
        }
        let d = due(&entries, &tasks, &mut |t| holds.get(&(t.agent.clone(), t.account.clone())).cloned().flatten(), at, PER_TICK);
        let mut fired = 0;
        let mut touched = Vec::new();
        for a in d.actions {
            match a {
                Action::Lapse { session_id, ids } => {
                    self.take(&ids);
                    let _ = self.write(store::Ops { drop_entries: ids, ..store::Ops::default() }).await;
                    touched.push(session_id);
                }
                Action::Forget { session_id } => {
                    let ids: Vec<String> = self.of_task(&session_id).into_iter().map(|l| l.id).collect();
                    self.take(&ids);
                    let _ = self.write(store::Ops { drop_entries: ids, ..store::Ops::default() }).await;
                }
                Action::Hold { session_id, id, at: when, held } => {
                    let moved = {
                        let mut all = lock(&self.entries);
                        all.iter_mut().find(|l| l.id == id).map(|l| {
                            l.at = when;
                            l.held = Some(held);
                            l.clone()
                        })
                    };
                    if let Some(l) = moved {
                        let _ = self.write(store::Ops { entries: vec![l], ..store::Ops::default() }).await;
                    }
                    touched.push(session_id);
                }
                Action::Fire { session_id, id, late } => {
                    if let Some(l) = self.take(std::slice::from_ref(&id)).pop() {
                        if self.fire(ctx, call, &l, late).await.is_ok() {
                            fired += 1;
                        }
                        touched.push(session_id);
                    }
                }
                Action::Remind { session_id, id } => {
                    if let (Some(l), Some(t)) = (self.take(std::slice::from_ref(&id)).pop(), tasks.get(&session_id)) {
                        let _ = self.remind(ctx, call, t, &l, l.text.clone(), false).await;
                        touched.push(session_id);
                    }
                }
                Action::Missed { session_id, id } => {
                    if let (Some(l), Some(t)) = (self.take(std::slice::from_ref(&id)).pop(), tasks.get(&session_id)) {
                        let text = rules::missed_text(&l, at, TZ);
                        let _ = self.remind(ctx, call, t, &l, text, true).await;
                        touched.push(session_id);
                    }
                }
            }
        }
        let pd = due_plans(&plans, &tasks, at, PER_TICK.saturating_sub(d.used));
        for a in pd.actions {
            match a {
                PlanAction::Run { id } | PlanAction::Missed { id } => {
                    let Some(p) = lock(&self.plans).iter().find(|p| p.id == id).cloned() else { continue };
                    lock(&self.plans).retain(|x| x.id != id);
                    let _ = self.write(store::Ops { drop_plans: vec![id], ..store::Ops::default() }).await;
                    if p.kind == PlanKind::Task {
                        let mut body = p.body.clone().unwrap_or_else(|| json!({}));
                        if let Some(o) = body.as_object_mut() {
                            o.insert("by".into(), json!("later"));
                        }
                        if ctx.run_json(call, "runtime.create", body).await.is_ok() {
                            fired += 1;
                        }
                    }
                }
                PlanAction::Lose { id, why } => {
                    let lost = lock(&self.plans).iter().find(|p| p.id == id).map(|p| rules::lose(p, why));
                    if let Some(p) = lost {
                        lock(&self.plans).retain(|x| x.id != id);
                        lock(&self.plans).push(p.clone());
                        let _ = self.write(store::Ops { plans: vec![p], ..store::Ops::default() }).await;
                    }
                }
            }
        }
        touched.sort();
        touched.dedup();
        for id in touched {
            self.mirror(ctx, call, &id).await;
        }
        fired
    }
}

macro_rules! on {
    ($s:ident, $slot:ident, $C:ty, |$st:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let slot = slot.clone();
            async move {
                let $st = state(&slot)?;
                $body
            }
        });
    }};
}

#[allow(clippy::too_many_lines)] // one handler per v1 route
fn commands(s: &mut Setup, slot: &Slot) {
    on!(s, slot, c::Add, |st, ctx, call, a| st.add(&ctx, &call, &a).await);
    on!(s, slot, c::List, |st, _ctx, _call, a| Ok(st.of_task(&a.session_id)));
    on!(s, slot, c::Edit, |st, ctx, call, a| {
        let l = st.of_task(&a.session_id).into_iter().find(|l| l.id == a.item).ok_or_else(|| WireError::not_found("Nothing scheduled with that id."))?;
        if a.now {
            st.take(std::slice::from_ref(&l.id));
            return st.fire(&ctx, &call, &l, false).await.map(c::Edited::Sent);
        }
        let next = rules::edit_entry(&l, &a, now(&ctx), TZ).map_err(wire)?;
        if let Some(x) = lock(&st.entries).iter_mut().find(|x| x.id == next.id) {
            *x = next.clone();
        }
        st.write(store::Ops { entries: vec![next.clone()], ..store::Ops::default() }).await?;
        st.mirror(&ctx, &call, &a.session_id).await;
        Ok(c::Edited::Entry(next))
    });
    on!(s, slot, c::Cancel, |st, ctx, call, a| {
        let ids: Vec<String> = st.of_task(&a.session_id).into_iter().filter(|l| a.item.as_deref().is_none_or(|i| i == l.id) && (!a.goal_round || l.goal.is_some())).map(|l| l.id).collect();
        let gone = st.take(&ids);
        st.write(store::Ops { drop_entries: ids, ..store::Ops::default() }).await?;
        st.mirror(&ctx, &call, &a.session_id).await;
        Ok(c::Cancelled { ok: true, entry: gone.into_iter().next() })
    });
    on!(s, slot, c::Done, |st, ctx, call, a| {
        let (keep, gone) = rules::done_split(st.of_task(&a.session_id));
        let ids: Vec<String> = gone.into_iter().map(|l| l.id).collect();
        st.take(&ids);
        st.write(store::Ops { drop_entries: ids, ..store::Ops::default() }).await?;
        let _ = keep;
        st.mirror(&ctx, &call, &a.session_id).await;
        Ok(c::Empty {})
    });
    on!(s, slot, c::Plans, |st, _ctx, _call, _a| Ok(lock(&st.plans).clone()));
    on!(s, slot, c::GetPlan, |st, _ctx, _call, a| lock(&st.plans).iter().find(|p| p.id == a.id).cloned().ok_or_else(|| WireError::not_found("No such plan.")));
    on!(s, slot, c::MakePlan, |st, ctx, call, a| {
        let after = match &a.after {
            Some(v) => {
                let id = rules::after_id(v).map_err(wire)?;
                let t = task_of(&ctx, &call, &id).await.ok_or_else(|| WireError::not_found("No such task to wait for."))?;
                Some(t)
            }
            None => None,
        };
        let p = rules::new_plan(wisp_kernel::ids::uuid7(), &a, after.as_ref().map(|t| (t, t.state == TaskState::Done)), now(&ctx), TZ).map_err(wire)?;
        lock(&st.plans).push(p.clone());
        st.write(store::Ops { plans: vec![p.clone()], ..store::Ops::default() }).await?;
        Ok(p)
    });
    on!(s, slot, c::EditPlan, |st, ctx, _call, a| {
        let p = lock(&st.plans).iter().find(|p| p.id == a.id).cloned().ok_or_else(|| WireError::not_found("No such plan."))?;
        let next = rules::edit_plan(&p, &a, now(&ctx), TZ).map_err(wire)?;
        if let Some(x) = lock(&st.plans).iter_mut().find(|x| x.id == next.id) {
            *x = next.clone();
        }
        st.write(store::Ops { plans: vec![next.clone()], ..store::Ops::default() }).await?;
        Ok(c::PlanEdited::Plan(Box::new(next)))
    });
    on!(s, slot, c::CancelPlan, |st, _ctx, _call, a| {
        lock(&st.plans).retain(|p| p.id != a.id);
        st.write(store::Ops { drop_plans: vec![a.id], ..store::Ops::default() }).await?;
        Ok(c::Okay { ok: true })
    });
    on!(s, slot, c::NextAtOf, |st, ctx, call, _a| {
        let entries = lock(&st.entries).clone();
        let plans = lock(&st.plans).clone();
        let mut tasks = BTreeMap::new();
        for l in &entries {
            if !tasks.contains_key(&l.session_id)
                && let Some(t) = task_of(&ctx, &call, &l.session_id).await
            {
                tasks.insert(l.session_id.clone(), t);
            }
        }
        Ok(c::NextAt { at: next_at(&entries, &plans, &tasks, now(&ctx)) })
    });
    on!(s, slot, c::Tick, |st, ctx, call, _a| Ok(c::Ticked { fired: st.tick(&ctx, &call).await }));
    on!(s, slot, c::WaitAtLimit, |st, ctx, call, a| {
        // the carry-on at a usage limit: a follow-up of wisp's own at the reset
        let add = c::AddArgs { session_id: a.session_id.clone(), text: Some(wisp_later_api::LIMIT_CARRY_ON.into()), when: c::When { at: Some(json!(a.at.max(now(&ctx) + wisp_later_api::MIN_MS))), in_min: None }, by: Some(wisp_later_api::BY_WISP.into()), limit: a.agent.clone().map(|agent| wisp_later_api::LimitRef { agent, account: String::new() }), ..c::AddArgs::default() };
        Ok(st.add(&ctx, &call, &add).await.ok())
    });
    on!(s, slot, c::AgentSchedule, |st, ctx, call, a| {
        // the `resume_later` tool: the agent's own wake-up, or a cancel
        if let Some(id) = a.cancel.as_deref().filter(|c| !c.is_empty()) {
            let ids: Vec<String> = st.of_task(&a.session).into_iter().filter(|l| l.id == id && l.by == BY_AGENT).map(|l| l.id).collect();
            if ids.is_empty() {
                return Ok(c::ScheduleOut { text: None, error: Some(format!("Nothing of yours is scheduled with id {id}.")) });
            }
            st.take(&ids);
            st.write(store::Ops { drop_entries: ids, ..store::Ops::default() }).await?;
            st.mirror(&ctx, &call, &a.session).await;
            return Ok(c::ScheduleOut { text: Some(format!("Cancelled {id}.")), error: None });
        }
        if let Some(at) = a.at.as_deref()
            && !rules::agent_at_ok(at)
        {
            return Ok(c::ScheduleOut { text: None, error: Some("`at` must be an ISO time with its offset (2026-11-08T17:00:00Z).".into()) });
        }
        let add = c::AddArgs { session_id: a.session.clone(), text: a.message.clone(), when: c::When { at: a.at.clone().map(Value::String), in_min: a.minutes.clone() }, by: Some(BY_AGENT.into()), ..c::AddArgs::default() };
        match st.add(&ctx, &call, &add).await {
            Ok(l) => {
                let task = task_of(&ctx, &call, &a.session).await;
                let minutes = (l.at - now(&ctx)) / 60_000;
                let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "resume_later", "props": { "agent": task.map(|t| t.agent), "minutes": minutes } })).await;
                let others: Vec<LaterEntry> = st.of_task(&a.session).into_iter().filter(|x| x.id != l.id).collect();
                Ok(c::ScheduleOut { text: Some(rules::scheduled_text(&l, &others, now(&ctx), TZ)), error: None })
            }
            Err(e) => Ok(c::ScheduleOut { text: None, error: Some(e.message) }),
        }
    });
}

#[derive(Debug, Default)]
pub struct LaterPlugin;

impl Plugin for LaterPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        commands(s, &slot);
        let start = slot;
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            store::install(&store).map_err(WireError::from)?;
            let (entries, plans, metas) = store::load(&store).await.map_err(WireError::from)?;
            let st = Arc::new(State { store, entries: Mutex::new(entries), plans: Mutex::new(plans), metas: Mutex::new(metas.into_iter().collect()) });
            let _ = start.set(st.clone());
            // the scheduler: a look every `TICK_MS` on the kernel's clock (a test's FakeClock drives it)
            if let Ok(clock) = ctx.clock() {
                let (scope, c2) = (ctx.scope().clone(), ctx.clone());
                ctx.spawn(async move {
                    loop {
                        st.tick(&c2, &c2.root_call()).await;
                        tokio::select! {
                            () = scope.cancelled() => return,
                            () = clock.sleep(u64::try_from(TICK_MS).unwrap_or(20_000)) => {}
                        }
                    }
                });
            }
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(LaterPlugin.manifest().id, "wisp.later");
    }
}
