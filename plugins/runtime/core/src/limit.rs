//! A run at its account's usage limit (v1 runner.js `#atLimit`, `#waitsForReset`): the hero says so, the CLI's
//! words go under it, and `turn.limit` is the card (Wait until, another of your accounts, another harness, extra
//! usage). wisp never moves a task to another account by itself: the providers' terms forbid getting around their
//! limits (design/accounts.md). With Settings → Wait for the reset on, the task carries on by itself after it.

use serde_json::{Value, json};
use wisp_runtime_api::model::{LimitAccount, TurnLimit};

/// The setting: wait for the reset by itself (v1 `defaults.limitWait: 'on'`, off by default).
pub const WAIT: &str = "runtime.limitWait";

/// When it can run again: the budget's reset of a full window when it knows, else what the error said.
pub fn until(reset_at: Option<i64>, account_until: Option<i64>, now: i64, said_ms: i64) -> i64 {
    reset_at.or(account_until).filter(|u| *u > now).unwrap_or(now + said_ms.max(0))
}

/// The card and the hero. `who`: the account's label, else the harness's name.
pub fn at_limit(who: &str, text: &str, limit: TurnLimit) -> (TurnLimit, Vec<Value>) {
    let who = if who.is_empty() { "This harness" } else { who };
    let summary = if limit.others.is_empty() { "Wait for the reset, or hand the task to another agent." } else { "Wait for the reset, continue on another of your accounts, or hand the task to another agent." };
    // no time in the hero: the card under it says when, in the page's own time format
    let blocks = vec![
        json!({ "type": "hero", "title": format!("{who} is at its usage limit"), "summary": summary, "status": "blocked" }),
        json!({ "type": "terminal", "output": if text.is_empty() { "No output." } else { text }, "exitCode": 1 }),
    ];
    (limit, blocks)
}

/// It waits for the reset: the hero says it carries on by itself.
pub fn waiting(limit: &mut TurnLimit, blocks: &mut [Value]) {
    limit.waiting = true;
    if let Some(h) = blocks.iter_mut().find(|b| b["type"] == "hero") {
        h["summary"] = json!("It carries on by itself after the reset, in this same conversation.");
        h["status"] = json!("partial");
    }
}

/// The other accounts the card may offer: ready ones only, never this one.
pub fn others(accounts: &Value, this: &str) -> Vec<LimitAccount> {
    let this = if this.is_empty() { "default" } else { this };
    accounts["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["state"] == "ready" && a["id"].as_str() != Some(this))
        .map(|a| LimitAccount { id: a["id"].as_str().unwrap_or_default().into(), label: a["label"].as_str().unwrap_or_default().into(), kind: a["kind"].as_str().unwrap_or("personal").into() })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_run_at_its_limit_shows_who_until_when_and_what_else_it_can_do() {
        assert_eq!(until(Some(5_000), Some(9_000), 1_000, 60_000), 5_000, "the budget's reset first");
        assert_eq!(until(None, Some(9_000), 1_000, 60_000), 9_000);
        assert_eq!(until(Some(500), None, 1_000, 60_000), 61_000, "a reset already past: what the error said");
        let accs = json!({ "accounts": [{ "id": "default", "label": "Me", "state": "ready", "kind": "personal" }, { "id": "w", "label": "Work", "state": "ready", "kind": "work" }, { "id": "x", "label": "X", "state": "limit" }] });
        let o = others(&accs, "");
        assert_eq!(o.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["w"], "ready ones, never this one");
        let (mut l, mut b) = at_limit("Claude Code", "Claude AI usage limit reached", TurnLimit { others: o, ..TurnLimit::default() });
        assert_eq!(b[0]["title"], "Claude Code is at its usage limit");
        assert!(b[0]["summary"].as_str().unwrap().contains("another of your accounts"));
        assert_eq!((b[1]["type"].as_str(), b[1]["output"].as_str()), (Some("terminal"), Some("Claude AI usage limit reached")));
        waiting(&mut l, &mut b);
        assert!(l.waiting);
        assert_eq!(b[0]["status"], "partial");
        let (_, alone) = at_limit("", "", TurnLimit::default());
        assert_eq!((alone[0]["title"].as_str(), alone[1]["output"].as_str()), (Some("This harness is at its usage limit"), Some("No output.")));
        assert!(!alone[0]["summary"].as_str().unwrap().contains("accounts"));
    }
}
