//! Ask near the limit in the `before:run` guard (v1 server/guard.js; the rule is budget core's `ask`): a run that
//! would take its account's window past your line is refused when you started it (the message says how to go ahead:
//! `confirmLimit`, the CLI's `--yes`), and held until the window resets when nobody did (an automation). A yes
//! moves that window's line up a step until its reset (`Budget::ack`). The runs it learns from are every turn's
//! end (`turn.ended`), kept 30 days, at most 200 per harness, in `budget_meta` (`runs`).

use std::collections::BTreeMap;

use serde_json::json;
use wisp_budget_core::ask::{self, Kind, Run};
use wisp_budget_core::drain::units_of;
use wisp_kernel::{Ctx, Verdict};
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::hooks::{BeforeRunCtx, RunKind};
use wisp_runtime_api::model::Held;

use crate::{PLUGIN_ID, State, account_of, lock, now};

pub const SETTING: &str = "budget.limitHold";
/// The `held.kind` of a turn Ask near the limit holds.
pub const HOLD_KIND: &str = "ask";
const KEEP: usize = 200;

/// Runs per harness, newest last.
pub type Runs = BTreeMap<String, Vec<Run>>;

/// A run ended: it counts for the next estimates (newest 200 within 30 days).
pub fn learn(runs: &mut Runs, e: &TurnEnded, at: i64) -> bool {
    let (units, _) = units_of(e.cost_usd, e.tokens);
    if e.agent.is_empty() || units <= 0.0 {
        return false;
    }
    let list = runs.entry(e.agent.clone()).or_default();
    list.retain(|r| r.at > at - ask::LOOKBACK_MS);
    list.push(Run {
        at,
        account: account_of(e.account.as_deref().unwrap_or_default()),
        session: e.session_id.0.clone(),
        units,
        first: e.first,
        inner: e.inner,
    });
    let extra = list.len().saturating_sub(KEEP);
    list.drain(..extra);
    true
}

fn ask_line(ctx: &Ctx) -> Option<f64> {
    let v = ctx.setting(SETTING);
    ask::line(v.as_ref().and_then(|v| v.as_str()))
}

impl State {
    /// The window this run would take past its line, with the windows the rule read.
    fn ask_hold(&self, ctx: &Ctx, c: &BeforeRunCtx) -> Option<(ask::Hold, Vec<ask::Win>)> {
        let line = ask_line(ctx)?;
        let (agent, account) = (c.agent.as_str(), account_of(c.account.as_deref().unwrap_or_default()));
        let at = now(ctx);
        let runs = lock(&self.runs).get(agent).cloned().unwrap_or_default();
        let kind = if c.kind == RunKind::First { Kind::First } else { Kind::FollowUp };
        let mine: Vec<f64> = runs.iter().filter(|r| r.session == c.session_id.0).map(|r| r.units).collect();
        let units = ask::units(&runs, kind, &mine);
        // runs going on this account count at half what they'll likely take
        let running: f64 = lock(&self.running).values().filter(|(g, a, _)| g == agent && *a == account).map(|(_, _, mid)| mid / 2.0).sum();
        let b = lock(&self.budget);
        let list = b.windows_now(agent, &account, at);
        let rate = |w: &wisp_budget_api::WindowNow| ask::rate(b.rate(agent, &account, &w.id), w, &runs, &account);
        let acked = |w: &wisp_budget_api::WindowNow| b.acked(agent, &account, &w.id, w.resets_at, at);
        // a launch's runs starting at once (Try it two ways' pair) are asked about as one: v1 `together`
        let wins = ask::windows(&list, Some(line), ask::together(units, c.together), running, &rate, &acked);
        drop(b);
        if let Some(u) = units {
            lock(&self.running).insert(c.turn_id.0.clone(), (agent.to_owned(), account.clone(), u[1]));
        }
        ask::hold_for(&wins).map(|h| (h, wins))
    }

    /// The guard's half: None lets it run.
    pub(crate) fn ask(&self, ctx: &Ctx, mut c: BeforeRunCtx) -> Option<Verdict<BeforeRunCtx>> {
        // a subagent runs inside a task you already said yes to
        if c.parent_id.is_some() || matches!(c.by.as_deref(), Some("wisp" | "compact")) {
            return None;
        }
        let (h, wins) = self.ask_hold(ctx, &c)?;
        let account = account_of(c.account.as_deref().unwrap_or_default());
        if c.confirm_limit {
            // you said yes: each window it crosses asks again only higher up, or after its reset
            let mut b = lock(&self.budget);
            for w in wins.iter().filter(|w| ask::hold_for(std::slice::from_ref(*w)).is_some()) {
                b.ack(&c.agent, &account, &w.id, w.resets_at, w.line.unwrap_or(0.0));
            }
            return None;
        }
        lock(&self.running).remove(&c.turn_id.0);
        if wisp_budget_core::windows::unattended(c.by.as_deref()) {
            let until = ask::until(&h, now(ctx));
            lock(&self.asked).push((c.session_id.0.clone(), c.turn_id.0.clone(), until));
            let why = ask::message(&h);
            c.hold = Some(Held {
                by: PLUGIN_ID.into(),
                kind: HOLD_KIND.into(),
                until: Some(until),
                data: json!({ "window": h.id, "label": h.label, "used": h.used, "to": h.to, "line": h.line, "why": why }),
            });
            return Some(Verdict::Modify { ctx: c });
        }
        Some(Verdict::Veto { code: wisp_budget_api::VETO_CODE.into(), message: ask::message(&h), then: Vec::new() })
    }

    /// Held automations whose window has reset start now.
    pub(crate) fn ask_due(&self, at: i64) -> Vec<(String, String)> {
        let mut asked = lock(&self.asked);
        let (due, keep): (Vec<_>, Vec<_>) = asked.drain(..).partition(|(_, _, until)| *until <= at);
        *asked = keep;
        due.into_iter().map(|(s, t, _)| (s, t)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ended(cost: f64, first: bool) -> TurnEnded {
        TurnEnded {
            session_id: "t1".into(),
            turn_id: "u1".into(),
            status: wisp_runtime_api::model::TurnStatus::Done,
            interrupted: false,
            error_text: None,
            cost_usd: Some(cost),
            changed_files: None,
            agent: "claude".into(),
            model: "opus".into(),
            account: None,
            tokens: None,
            input_tokens: None,
            output_tokens: None,
            cache_tokens: None,
            cache_read_tokens: None,
            first,
            inner: false,
        }
    }

    #[test]
    fn every_run_that_did_work_is_learned_newest_200_within_30_days() {
        let mut runs = Runs::new();
        assert!(!learn(&mut runs, &ended(0.0, true), 1), "no work: nothing to learn");
        assert!(learn(&mut runs, &ended(0.4, true), 1));
        let r = &runs["claude"][0];
        assert_eq!((r.account.as_str(), r.session.as_str(), r.units, r.first), ("default", "t1", 0.4, true));
        for i in 0..250 {
            learn(&mut runs, &ended(0.1, false), 10 + i);
        }
        assert_eq!(runs["claude"].len(), 200);
        learn(&mut runs, &ended(0.1, false), 40 * 24 * 3_600_000);
        assert_eq!(runs["claude"].len(), 1, "older than 30 days: gone");
    }
}
