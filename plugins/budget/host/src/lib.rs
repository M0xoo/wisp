//! wisp.budget host: the usage windows each account reported (a run's `turn.limits`, a live read),
//! Automations stop at, and the `before:run` guard: unattended work (crew, triggers, goals, agents)
//! on an account past its stop line is held, and starts once the account is free again (its windows
//! reset, or a reading says they reset early). The user's own runs are never held.

mod store;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};
use wisp_budget_api::commands as c;
use wisp_budget_api::{PlanHold, settings};
use wisp_budget_core::Budget;
use wisp_budget_core::limits::report_from_value;
use wisp_kernel::services::Paths;
use wisp_kernel::{Ctx, Failure, InterceptOpts, Manifest, Plugin, Result, Setup, Verdict, WireError};
use wisp_runtime_api::events::TurnLimits;
use wisp_runtime_api::hooks::{BeforeRun, BeforeRunCtx};
use wisp_runtime_api::model::Held;
use wisp_store::Store;

pub const PLUGIN_ID: &str = "wisp.budget";
/// The `held.kind` of a turn the plan holds.
pub const HOLD_KIND: &str = "plan";
/// How often held work looks whether its account is free (v1 tick).
const TICK_MS: u64 = 60_000;
const STOP_AT: [&str; 4] = ["off", "50", "75", "90"];

/// Turns held per (agent, account): (task, turn).
type HeldTurns = BTreeMap<(String, String), Vec<(String, String)>>;

struct State {
    store: Store,
    budget: Mutex<Budget>,
    settings: Mutex<Value>,
    held: Mutex<HeldTurns>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

type Slot = Arc<OnceLock<Arc<State>>>;

fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.budget is starting"))
}

fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

fn account_of(a: &str) -> String {
    if a.is_empty() { "default".into() } else { a.to_owned() }
}

/// v1 `stopFor`: the harness's own line, else the one for every harness; 'off' (or none) is no line.
fn stop_for(settings: &Value, agent: &str) -> Option<f64> {
    let own = match agent {
        "claude" => settings.get(settings::AUTO_STOP_CLAUDE),
        "codex" => settings.get(settings::AUTO_STOP_CODEX),
        _ => None,
    }
    .and_then(Value::as_str)
    .filter(|v| STOP_AT.contains(v));
    let v = own.or_else(|| settings.get(settings::AUTO_STOP).and_then(Value::as_str))?;
    (v != "off").then(|| v.parse::<f64>().ok().map(|p| p / 100.0)).flatten()
}

impl State {
    fn hold(&self, agent: &str, account: &str, at: i64) -> Option<PlanHold> {
        let stop = stop_for(&lock(&self.settings), agent);
        lock(&self.budget).hold(agent, &account_of(account), stop, at)
    }

    fn free(&self, agent: &str, account: &str, at: i64) -> bool {
        let stop = stop_for(&lock(&self.settings), agent);
        lock(&self.budget).free(agent, &account_of(account), stop, at)
    }

    async fn save(&self) {
        let dirty = lock(&self.budget).take_dirty();
        if dirty.is_empty() {
            return;
        }
        let _ = self.store.write(move |w| dirty.iter().try_for_each(|(g, a, acc)| store::put_acc(w, g, a, acc))).await;
    }

    /// Held work whose account is free starts now.
    async fn release(&self, ctx: &Ctx) {
        let at = now(ctx);
        let due: Vec<(String, String)> = {
            let mut held = lock(&self.held);
            let keys: Vec<(String, String)> = held.keys().filter(|(g, a)| self.free(g, a, at)).cloned().collect();
            keys.iter().filter_map(|k| held.remove(k)).flatten().collect()
        };
        for (id, turn) in due {
            let _ = ctx.run_json(&ctx.root_call(), "runtime.release", json!({ "id": id, "turnId": turn, "action": "start" })).await;
        }
    }

    async fn record(&self, ctx: &Ctx, agent: &str, account: &str, report: &wisp_budget_api::LimitsReport) -> c::RecordOut {
        let r = lock(&self.budget).record(agent, &account_of(account), report, now(ctx));
        self.save().await;
        self.release(ctx).await;
        c::RecordOut { past: r.past }
    }
}

/// `before:run`: unattended work on an account past its stop line is held until it resets.
fn guard(ctx: &Ctx, st: &State, mut c: BeforeRunCtx) -> Verdict<BeforeRunCtx> {
    let subject = wisp_budget_core::subject_of(&c.agent, c.account.as_deref(), c.by.as_deref());
    let at = now(ctx);
    let Some(h) = wisp_budget_core::decide(&subject, |g, a| st.hold(g, a, at)) else { return Verdict::Continue };
    let why = format!("{} is past {:.0}% of its {} window: unattended work waits for it to reset.", c.agent, h.stop * 100.0, h.label);
    lock(&st.held).entry((h.agent.clone(), h.account.clone())).or_default().push((c.session_id.0.clone(), c.turn_id.0.clone()));
    c.hold = Some(Held { by: PLUGIN_ID.into(), kind: HOLD_KIND.into(), until: Some(h.until), data: json!({ "hold": h, "why": why }) });
    Verdict::Modify { ctx: c }
}

macro_rules! on {
    ($s:ident, $slot:ident, $C:ty, |$st:ident, $ctx:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$C, _, _>(move |$ctx, _call, $a| {
            let slot = slot.clone();
            async move {
                let $st = state(&slot)?;
                $body
            }
        });
    }};
}

#[derive(Debug, Default)]
pub struct BudgetPlugin;

impl Plugin for BudgetPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        on!(s, slot, c::View, |st, ctx, a| Ok(lock(&st.budget).view(&a.agent, now(&ctx))));
        on!(s, slot, c::Hold, |st, ctx, a| Ok(st.hold(&a.agent, &a.account, now(&ctx))));
        on!(s, slot, c::Record, |st, ctx, a| Ok(st.record(&ctx, &a.agent, &a.account, &a.report).await));
        on!(s, slot, c::SetStop, |st, ctx, a| {
            let keys = [settings::AUTO_STOP, settings::AUTO_STOP_CLAUDE, settings::AUTO_STOP_CODEX];
            if !keys.contains(&a.key.as_str()) || !(STOP_AT.contains(&a.value.as_str()) || (a.value == "same" && a.key != settings::AUTO_STOP)) {
                return Err(WireError::invalid("Automations stop at: off, 50, 75 or 90 (or same)."));
            }
            let v = {
                let mut set = lock(&st.settings);
                if let Some(o) = set.as_object_mut() {
                    o.insert(a.key.clone(), json!(a.value));
                }
                set.clone()
            };
            st.store.write(move |w| store::put_settings(w, &v)).await.map_err(WireError::from)?;
            // a line raised or turned off frees held work now
            st.release(&ctx).await;
            Ok(c::Done { ok: true })
        });
        let hook = slot.clone();
        // after the account is picked (wisp.accounts, 20), before trust (50)
        s.intercept::<BeforeRun, _, _>(InterceptOpts { priority: 30, failure: Failure::Open, timeout_ms: 500 }, move |ctx, _call, c| {
            let slot = hook.clone();
            async move {
                match state(&slot) {
                    Ok(st) => guard(&ctx, &st, c),
                    Err(_) => Verdict::Continue,
                }
            }
        });
        let ev = slot.clone();
        s.on::<TurnLimits, _, _>(move |ctx, e| {
            let slot = ev.clone();
            async move {
                let (Ok(st), Some(report)) = (state(&slot), report_from_value(&e.limits)) else { return };
                st.record(&ctx, &e.agent, e.account.as_deref().unwrap_or(""), &report).await;
            }
        });
        let start = slot;
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            store::install(&store).map_err(WireError::from)?;
            if let Ok(p) = ctx.service::<Paths>() {
                store::import_v1(&store, p.home()).await.map_err(WireError::from)?;
            }
            let (accs, settings) = store::load(&store).await.map_err(WireError::from)?;
            let st = Arc::new(State { store, budget: Mutex::new(Budget::load(accs)), settings: Mutex::new(settings), held: Mutex::new(BTreeMap::new()) });
            let _ = start.set(st.clone());
            // held work starts when its windows reset on their own
            if let Ok(clock) = ctx.clock() {
                let (scope, c2) = (ctx.scope().clone(), ctx.clone());
                ctx.spawn(async move {
                    loop {
                        tokio::select! {
                            () = scope.cancelled() => return,
                            () = clock.sleep(TICK_MS) => st.release(&c2).await,
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
        assert_eq!(BudgetPlugin.manifest().id, "wisp.budget");
    }

    #[test]
    fn stop_lines_as_v1() {
        let s = json!({ "autoStop": "90", "autoStopCodex": "50", "autoStopClaude": "same" });
        assert_eq!((stop_for(&s, "codex"), stop_for(&s, "claude"), stop_for(&s, "cursor")), (Some(0.5), Some(0.9), Some(0.9)));
        assert_eq!(stop_for(&json!({ "autoStop": "off" }), "codex"), None);
    }
}
