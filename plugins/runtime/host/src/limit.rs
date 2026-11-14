//! A run that ended at its account's usage limit (v1 runner.js `#atLimit`, `waitAtLimit`, index.js:494): the
//! router tells a limit from a failure (`router.service@1` classify), wisp.budget says when the account resets
//! (`budget.resetAt`), wisp.accounts marks it until then (`accounts.cool`, several accounts only) and lists the
//! others ready; the turn gets `limit` (its card) and a blocked hero. With Settings → Wait for the reset on, the
//! task waits quietly under Scheduled (`later.waitAtLimit`) and carries on in the same conversation after it.
//! Never a subagent's run (its lead reads the failure), never one that was stopped.

use std::sync::Arc;

use wisp_accounts_api::commands as acc;
use wisp_budget_api::commands as budget;
use wisp_later_api::commands as later;
use wisp_router_api::service::RunError;
use wisp_router_api::{LimitKind, LimitScope};
use wisp_runtime_api::model::{Presentation, Session, SessionState, Turn, TurnLimit};
use wisp_runtime_core::land::Landing;
use wisp_runtime_core::limit;

use crate::calls;
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
        let host = &*self.host;
        let reset = match calls::run::<budget::ResetAt>(host, budget::AccountArgs { agent: agent.clone(), account: account.clone() }).await
        {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!(error = %err.message, "runtime: budget.resetAt (the router's guess instead)");
                None
            }
        };
        let until = limit::until(reset, None, now, l.ms);
        let why: String = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().chars().take(160).collect();
        // several accounts: this one is skipped until its reset (wisp.accounts keeps nothing for one login)
        let cool = acc::CoolArgs { agent: agent.clone(), account: account.clone(), until, why };
        let accounts = match calls::run::<acc::Cool>(host, cool).await {
            Ok(a) => a.accounts,
            Err(err) => {
                tracing::warn!(error = %err.message, "runtime: accounts.cool (no other accounts on the card)");
                Vec::new()
            }
        };
        let this = if account.is_empty() { "default" } else { account.as_str() };
        let from = accounts.iter().find(|a| a.id == this);
        let h = self.harness(&agent).ok();
        let name = from.map(|a| a.label.clone()).or_else(|| h.as_ref().map(|h| h.info().name.clone())).unwrap_or_default();
        let listed = serde_json::json!({ "accounts": accounts });
        let card = TurnLimit {
            account: account.clone(),
            until,
            others: limit::others(&listed, &account),
            kind: from
                .and_then(|a| serde_json::to_value(a.kind).ok())
                .and_then(|k| k.as_str().map(str::to_owned))
                .unwrap_or_else(|| "personal".to_owned()),
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
        let a = later::WaitAtLimitArgs { session_id: sid.to_owned(), at: until, agent: Some(agent.to_owned()) };
        match calls::run::<later::WaitAtLimit>(&*self.host, a).await {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(err) => tracing::warn!(error = %err.message, task = sid, "runtime: later.waitAtLimit (it asks the user)"),
        }
        let back = self.edit(sid, |s| {
            s.state = SessionState::Review;
            s.unread = true;
            Ok(())
        });
        if let Err(err) = back.await {
            tracing::warn!(error = %err, task = sid, "runtime: back in Needs you");
        }
    }
}
