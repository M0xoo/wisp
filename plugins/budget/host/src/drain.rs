//! Drain watch (v1 runner.js:1810 `budget.spend`, index.js:145 `onDrain`): every run that ends counts its units of
//! work against what its account's windows moved, so the card on the account (`budget.view`) shows a plan that
//! suddenly moves much faster for the same work. With Drain watch on (`budget.drainWatch`, off by default), the
//! phone hears of it once per window per two hours (`budget.drain`, and a note through `channels.send`).

use serde_json::{Value, json};
use wisp_budget_api::events::DrainNoted;
use wisp_budget_api::settings;
use wisp_budget_core::drain::units_of;
use wisp_budget_core::windows::{drain_title, drain_why};
use wisp_kernel::Ctx;
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::TurnStatus;

use crate::{State, account_of, lock, now};

/// The setting (manifest); v1's `defaults.drainWatch: "on"` comes in through the budget settings import.
pub const WATCH: &str = "budget.drainWatch";

/// Window notices ("Claude Code's weekly window resets Thursday"), on unless switched off.
pub const NOTICE: &str = "budget.windowNotice";

/// What an account's view shows: the drain card only with Drain watch on, the notices unless they're off.
pub fn shown(v: &mut wisp_budget_api::AccountView, drain: bool, notices: bool) {
    if !drain {
        v.drain = None;
    }
    if !notices {
        v.notices.clear();
    }
}

/// Drain watch is on: the setting, else v1's imported `drainWatch: "on"`.
pub fn watch_on(setting: Option<&Value>, imported: &Value) -> bool {
    match setting.and_then(Value::as_bool) {
        Some(on) => on,
        None => imported.get(settings::DRAIN_WATCH).and_then(Value::as_str) == Some("on"),
    }
}

/// The server's offset from UTC at `at`, in minutes (v1 wrote the phone's times in the server's zone).
fn offset_min(at: i64) -> i32 {
    jiff::Timestamp::from_millisecond(at).map_or(0, |ts| jiff::tz::TimeZone::system().to_offset(ts).seconds() / 60)
}

impl State {
    /// A run ended: count its work; if the account drains and the watch is on, the note goes (at most once per
    /// window per two hours). A stopped run counts like any other; one that failed counts as failed.
    pub(crate) async fn ended(&self, ctx: &Ctx, e: &TurnEnded) -> Option<DrainNoted> {
        let (units, in_usd) = units_of(e.cost_usd, e.tokens);
        if e.agent.is_empty() || units <= 0.0 {
            return None;
        }
        let at = now(ctx);
        let account = account_of(e.account.as_deref().unwrap_or_default());
        let failed = e.status == TurnStatus::Error && !e.interrupted;
        let drain = lock(&self.budget).spend(&e.agent, &account, units, failed, at);
        self.save().await;
        let d = drain?;
        let on = watch_on(ctx.setting(WATCH).as_ref(), &lock(&self.settings));
        if !lock(&self.notes).due(&format!("{}@{account}", e.agent), &d.id, on, at) {
            return None;
        }
        let name = ctx
            .contributions(&wisp_runtime_api::harness::HARNESS)
            .iter()
            .find(|h| h.info().id == e.agent)
            .map_or_else(|| e.agent.clone(), |h| h.info().name.clone());
        let label = if account == "default" { "" } else { account.as_str() };
        let note = DrainNoted { agent: e.agent.clone(), account: account.clone(), title: drain_title(&d, &name), text: drain_why(&d, &name, label, in_usd, offset_min(at)), drain: d };
        ctx.emit(&ctx.root_call(), &note);
        if let Err(err) = ctx.run_json(&ctx.root_call(), "channels.send", json!({ "msg": { "title": note.title, "text": note.text } })).await {
            tracing::debug!(%err, "Drain watch: no phone to tell");
        }
        Some(note)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn drain_watch_is_off_unless_switched_on_here_or_in_v1() {
        assert!(!watch_on(None, &json!({})));
        assert!(watch_on(None, &json!({ "drainWatch": "on" })), "v1's setting comes along");
        assert!(!watch_on(Some(&json!(false)), &json!({ "drainWatch": "on" })), "the switch here wins");
        assert!(watch_on(Some(&json!(true)), &json!({})));
    }

    /// v1 routes/meta.js:63: the drain card only with Drain watch on; the window notices unless switched off.
    #[test]
    fn the_drain_card_needs_drain_watch_and_notices_go_when_switched_off() {
        let v = || {
            serde_json::from_value::<wisp_budget_api::AccountView>(json!({
                "account": "default", "windows": [],
                "drain": { "id": "five_hour", "label": "5-hour", "ratio": 3.0, "since": 0, "runs": 2, "units": 1.0, "du": 0.1, "usual": 0.01, "failed": { "runs": 0, "du": 0.0 } },
                "notices": [{ "window": "five_hour", "kind": "reset", "at": 0 }]
            }))
            .unwrap()
        };
        let mut off = v();
        shown(&mut off, false, true);
        assert!(off.drain.is_none() && off.notices.len() == 1);
        let mut quiet = v();
        shown(&mut quiet, true, false);
        assert!(quiet.drain.is_some() && quiet.notices.is_empty());
    }

    #[test]
    fn a_runs_work_is_its_cost_else_its_tokens_in_millions() {
        assert_eq!(units_of(Some(0.4), Some(9)), (0.4, true));
        assert_eq!(units_of(Some(0.0), Some(2_500_000)), (2.5, false));
        assert_eq!(units_of(None, None), (0.0, false));
    }
}
