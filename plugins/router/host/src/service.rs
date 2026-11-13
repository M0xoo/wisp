//! `router.service@1` (plan §6.11.1): Auto for the runtime. `pick` chooses for a task on `agent: "auto"`
//! (a hand-over levels up first), `classify` tells a limit from a model failing, and `report` teaches the
//! router what happened (v1 index.js:315-330: launches, turn ends, limits, overrides, summaries).
//! `pick` reads the harnesses from the last look (`State::here`): a service call can't wait on them.

use std::sync::Arc;

use wisp_kernel::{Call, Ctx, Result};
use wisp_router_api::service::{Outcome, PERM_READ, PERM_WRITE, PickRequest, RouterApi, RunError};
use wisp_router_api::{Limit, Pick};
use wisp_router_core::{Mulberry32, auto, choose};

use crate::{State, lock, now, seed_of};

pub(crate) struct Svc {
    pub st: Arc<State>,
    pub ctx: Ctx,
}

impl RouterApi for Svc {
    fn pick(&self, call: &Call, req: PickRequest) -> Result<Option<Pick>> {
        call.require(PERM_READ)?;
        let t = now(&self.ctx);
        let here = lock(&self.st.here).clone();
        let r = lock(&self.st.router);
        if let Some(route) = &req.level_up
            && let Some(p) = wisp_router_core::choose::level_up(&r.st, t, route, &here)
        {
            return Ok(Some(p));
        }
        let prefs = auto::prefs(&lock(&self.st.settings).clone(), &here);
        // the dice: seeded by the prompt and the time, so two launches of one prompt may differ (exploring)
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let seed = seed_of(&req.choose.prompt) ^ (t as u32);
        Ok(choose(&r.st, t, &req.choose, &here, &prefs, &mut Mulberry32::new(seed)))
    }

    fn classify(&self, call: &Call, err: &RunError) -> Result<Option<Limit>> {
        call.require(PERM_READ)?;
        Ok(wisp_router_core::classify::limit_of(&err.text, &err.agent, &err.windows, now(&self.ctx), err.utc_offset_min.unwrap_or(0)))
    }

    fn report(&self, call: &Call, outcome: Outcome) -> Result<()> {
        call.require_write(PERM_WRITE)?;
        let fact = telemetry_of(&outcome);
        {
            let mut r = lock(&self.st.router);
            auto::apply(&mut r, &outcome, now(&self.ctx));
        }
        let (st, ctx) = (self.st.clone(), self.ctx.clone());
        self.ctx.spawn(async move {
            st.save(false).await;
            if let Some((event, props)) = fact {
                crate::calls::track(&ctx, &ctx.root_call(), event, props).await;
            }
        });
        Ok(())
    }
}

/// What a turn's end teaches Auto (v1 index.js:320-330): a run that hit a usage limit cools its harness or
/// model and is voided (not the model's fault); otherwise the first turn's error or cost is a signal. Only
/// tasks Auto routed or you launched have a route; the rest teach nothing.
pub fn turn_outcome(e: &wisp_runtime_api::events::TurnEnded, route: Option<&wisp_router_api::StoredRoute>, now: i64) -> Option<Outcome> {
    let route = route?;
    let id = e.session_id.0.clone();
    let error = e.status == wisp_runtime_api::model::TurnStatus::Error;
    if error
        && let Some(text) = e.error_text.as_deref()
        && let Some(limit) = wisp_router_core::classify::limit_of(text, &e.agent, &[], now, 0)
    {
        let key = wisp_router_api::arm_key(&e.agent, &e.model, "");
        return Some(Outcome::Limited { id: Some(id), key, limit, why: text.chars().take(200).collect() });
    }
    // the first end: nothing signalled yet (later turns are follow-ups, not the pick's doing)
    let sig = &route.signals;
    let first = sig.error.is_none() && sig.cost_usd.is_none() && sig.ms.is_none();
    Some(Outcome::TurnEnded { id, first, error, limited: false, interrupted: e.interrupted, cost_usd: e.cost_usd, ms: None })
}

/// Auto learns from every task's turn ends: a durable subscriber, so a restart loses none.
pub(crate) fn learn(s: &mut wisp_kernel::Setup, st: &Arc<State>) {
    let st = st.clone();
    s.on_durable::<wisp_runtime_api::events::TurnEnded, _, _>("router_learns", move |ctx, _call, d| {
        let st = st.clone();
        async move {
            let wisp_kernel::durable::Durable::Event { event: e, .. } = d else { return Ok(()) };
            let t = now(&ctx);
            let o = {
                let r = lock(&st.router);
                turn_outcome(&e, r.st.route(e.session_id.as_str()), t)
            };
            if let Some(o) = o {
                auto::apply(&mut lock(&st.router), &o, t);
                st.save(false).await;
            }
            Ok(())
        }
    });
}

/// The catalogue event an outcome is (v1 services/auto.js): you overrode Auto's preview.
pub fn telemetry_of(o: &Outcome) -> Option<(&'static str, serde_json::Value)> {
    match o {
        Outcome::Override { kind, auto, chose, .. } => {
            let from = auto.split(':').next().unwrap_or_default();
            let to = chose.split(':').next().unwrap_or_default();
            Some(("auto_override", serde_json::json!({ "type": kind, "from": from, "to": to, "sameHarness": from == to })))
        }
        Outcome::Launched { route, .. } => Some(("auto_settled", serde_json::json!({ "strategy": route.goal, "escalated": false, "escalation": false, "routeType": route.kind }))),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_router_api::StoredRoute;

    #[test]
    fn an_override_and_a_settled_auto_launch_count_as_telemetry() {
        let o = Outcome::Override { kind: Some("bug".into()), auto: "claude:opus:high".into(), chose: "codex:gpt-6".into(), prompt: String::new() };
        let (e, p) = telemetry_of(&o).unwrap();
        assert_eq!((e, p["from"].as_str(), p["to"].as_str(), p["sameHarness"].as_bool()), ("auto_override", Some("claude"), Some("codex"), Some(false)));
        let l = Outcome::Launched { id: "t".into(), route: StoredRoute { key: "claude:opus".into(), kind: "bug".into(), ..StoredRoute::default() } };
        assert_eq!(telemetry_of(&l).unwrap().0, "auto_settled");
        assert!(telemetry_of(&Outcome::Agents { agents: Vec::new(), more: false }).is_none());
    }

    #[test]
    fn auto_learns_from_a_routed_tasks_turn_end_and_cools_at_a_limit() {
        use wisp_runtime_api::events::TurnEnded;
        use wisp_runtime_api::model::TurnStatus;
        let e = TurnEnded { session_id: "t1".into(), turn_id: "u1".into(), status: TurnStatus::Done, interrupted: false, error_text: None, cost_usd: Some(0.4), changed_files: None, agent: "claude".into(), model: "opus".into(), account: None, tokens: None, first: true, inner: false };
        assert_eq!(turn_outcome(&e, None, 0), None, "a task nobody routed teaches nothing");
        let route = StoredRoute { key: "claude:opus".into(), ..StoredRoute::default() };
        match turn_outcome(&e, Some(&route), 0) {
            Some(Outcome::TurnEnded { first, error, cost_usd, .. }) => assert!(first && !error && cost_usd == Some(0.4)),
            o => panic!("{o:?}"),
        }
        let mut seen = route.clone();
        seen.signals.cost_usd = Some(0.4);
        assert!(matches!(turn_outcome(&e, Some(&seen), 0), Some(Outcome::TurnEnded { first: false, .. })), "a follow-up isn't the pick's doing");
        let limited = TurnEnded { status: TurnStatus::Error, error_text: Some("Claude AI usage limit reached|1767225600".into()), ..e };
        assert!(matches!(turn_outcome(&limited, Some(&route), 0), Some(Outcome::Limited { .. })), "{:?}", turn_outcome(&limited, Some(&route), 0));
    }
}
