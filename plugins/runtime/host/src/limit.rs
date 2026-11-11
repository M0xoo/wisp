//! A run that ended at its account's usage limit (v1 runner.js `#atLimit`, `waitAtLimit`, index.js:494): the
//! router tells a limit from a failure (`router.service@1` classify), wisp.budget says when the account resets
//! (`budget.resetAt`), wisp.accounts marks it until then (`accounts.cool`, several accounts only) and lists the
//! others ready; the turn gets `limit` (its card) and a blocked hero. With Settings → Wait for the reset on, the
//! task waits quietly under Scheduled (`later.waitAtLimit`) and carries on in the same conversation after it.
//! Never a subagent's run (its lead reads the failure), never one that was stopped.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_router_api::service::RunError;
use wisp_router_api::{LimitKind, LimitScope};
use wisp_runtime_api::model::{Presentation, Session, SessionState, Turn, TurnLimit};
use wisp_runtime_core::land::Landing;
use wisp_runtime_core::limit;

use crate::runtime::Runtime;

impl Runtime {
    /// The run's error is its account's usage limit: the card and the hero. true: it was one.
    pub(crate) async fn at_limit(&self, s: &Session, turn: &mut Turn, text: &str, p: &mut Presentation) -> bool {
        let Some((router, call)) = self.host.router() else { return false };
        let agent = if turn.agent.is_empty() { s.agent.clone() } else { turn.agent.clone() };
        let err = RunError { text: text.to_owned(), agent: agent.clone(), windows: Vec::new(), utc_offset_min: None };
        let Ok(Some(l)) = router.classify(&call, &err) else { return false };
        if l.scope != LimitScope::Agent || l.kind == Some(LimitKind::Device) {
            return false;
        }
        let account = turn.account.clone().or_else(|| s.account.clone()).unwrap_or_default();
        let now = self.now();
        let ask = |cmd: &'static str, args: Value| self.host.command(cmd, args);
        let reset = ask("budget.resetAt", json!({ "agent": agent, "account": account })).await.ok().and_then(|v| v.as_i64());
        let until = limit::until(reset, None, now, l.ms);
        let why: String = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().chars().take(160).collect();
        // several accounts: this one is skipped until its reset (wisp.accounts keeps nothing for one login)
        let accounts = ask("accounts.cool", json!({ "agent": agent, "account": account, "until": until, "why": why })).await.unwrap_or(Value::Null);
        let this = if account.is_empty() { "default" } else { account.as_str() };
        let from = accounts["accounts"].as_array().into_iter().flatten().find(|a| a["id"] == this);
        let h = self.harness(&agent).ok();
        let name = from.and_then(|a| a["label"].as_str()).map(str::to_owned).or_else(|| h.as_ref().map(|h| h.info().name.clone())).unwrap_or_default();
        let card = TurnLimit {
            account: account.clone(),
            until,
            others: limit::others(&accounts, &account),
            kind: from.and_then(|a| a["kind"].as_str()).unwrap_or("personal").to_owned(),
            extra: h.as_ref().and_then(|h| h.accounts()).map(|a| a.extra.clone()).unwrap_or_default(),
            waiting: false,
        };
        let (card, blocks) = limit::at_limit(&name, text, card);
        turn.limit = Some(card);
        p.blocks = blocks;
        true
    }

    /// Wait for the reset (Settings), when nothing else holds the task: it lands quietly, the hero says it carries
    /// on. The follow-up is scheduled once the task is saved (`schedule_reset`).
    pub(crate) fn waits_reset(&self, s: &Session, turn: &mut Turn, l: &mut Landing) -> bool {
        let on = self.host.setting(limit::WAIT).and_then(|v| v.as_bool()) == Some(true);
        let Some(card) = turn.limit.as_mut() else { return false };
        if !on || s.parent_id.is_some() || l.state != SessionState::Review {
            return false;
        }
        if let Some(p) = turn.presentation.as_mut() {
            limit::waiting(card, &mut p.blocks);
        }
        l.state = SessionState::Done;
        l.unread = false;
        l.notify = false;
        l.quiet = true;
        true
    }

    /// `later.waitAtLimit`: the carry-on at the reset. Refused (a subagent, five already waiting, ten in a row): the
    /// task lands in Needs you with the card, as it would without the setting.
    pub(crate) async fn schedule_reset(self: &Arc<Self>, sid: &str, agent: &str, until: i64) {
        let out = self.host.command("later.waitAtLimit", json!({ "sessionId": sid, "at": until, "agent": agent })).await;
        if out.is_ok_and(|v| !v.is_null()) {
            return;
        }
        let _ = self
            .edit(sid, |s| {
                s.state = SessionState::Review;
                s.unread = true;
                Ok(())
            })
            .await;
    }
}
