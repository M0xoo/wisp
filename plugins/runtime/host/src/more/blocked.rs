//! Blocked actions allowed for one follow-up (v1 `approveBlocked`).

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::commands::{FollowUpArgs, FollowedUp};
use wisp_runtime_api::model::TurnStatus;
use wisp_runtime_api::{SessionId, TurnId};

use super::{SLOT, slot, with_slot};
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

/// The follow-up that retries `items`. It is a stored row and goes out with its turn, so a refused command line
/// that quotes a .env value the task read shows it as `••••` (ADR-0050); the grants keep the rules as they are.
fn retry_prompt(items: &[Value], scoped: bool) -> String {
    let list: Vec<String> = items
        .iter()
        .cloned()
        .map(|mut b| {
            wisp_runtime_core::env_mask::mask_blocked_one(&mut b);
            b
        })
        .map(|b| {
            let tool = b.get("tool").and_then(Value::as_str).unwrap_or("?");
            match b.get("detail").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                Some(d) => format!("- {tool}: `{d}`"),
                None => format!("- {tool}"),
            }
        })
        .collect();
    let how = if scoped { "I allowed exactly these for this follow-up" } else { "This follow-up runs in Full auto, so nothing is blocked" };
    format!("These actions were blocked by your permissions last turn:\n{}\n\n{how}. Run them now and finish the task.", list.join("\n"))
}

impl Runtime {
    /// `runtime.approveBlocked` (v1 `approveBlocked`): what the last turn's permissions blocked, run in
    /// a follow-up with exactly those rules allowed (or in Full auto when a rule is unknown).
    pub async fn approve_blocked(self: &Arc<Self>, id: &SessionId, turn: Option<&TurnId>, allow: bool) -> Result<Value> {
        let blocked = {
            let _g = self.task_lock(id.as_str()).await;
            let s = self.repo.session(id.as_str()).await?;
            let mut t = self.turn_of(id.as_str(), turn).await?;
            let blocked: Vec<Value> = t.ext.get(SLOT).and_then(|x| x.get("blocked")).and_then(Value::as_array).cloned().unwrap_or_default();
            if blocked.is_empty() {
                return Err(RuntimeError::NoTurn("Nothing on that turn is waiting for approval.".into()));
            }
            if allow && slot(&s).and_then(|m| m.get("sideOf")).is_some() {
                return Err(RuntimeError::Conflict("A side discussion can’t allow this: ask the main task to do it.".into()));
            }
            if let Some(done) = t.ext.get(SLOT).and_then(|x| x.get("approval")).and_then(Value::as_str) {
                return Err(RuntimeError::Conflict(format!("Already {done}.")));
            }
            let last = self.last_turn(id.as_str()).await?;
            if last.as_ref().is_none_or(|l| l.id != t.id)
                || (t.status == TurnStatus::Running && self.run_state(id.as_str()) != wisp_runtime_core::queue::Run::Idle)
            {
                return Err(RuntimeError::Conflict("The task has moved on since; send a follow-up instead.".into()));
            }
            with_slot(&mut t.ext, |m| m.insert("approval".into(), json!(if allow { "allowed" } else { "denied" })));
            let mut s2 = s;
            self.persist(&mut s2, vec![t]).await?;
            blocked
        };
        if !allow {
            return Ok(json!({ "denied": true }));
        }
        let rules: Vec<String> = blocked.iter().filter_map(|b| b.get("rule").and_then(Value::as_str).map(str::to_owned)).collect();
        let scoped = rules.len() == blocked.len();
        let text = retry_prompt(&blocked, scoped);
        let out = self.follow_up_with(id, text, if scoped { json!({ "grants": rules }) } else { json!({ "once": "auto" }) }).await?;
        Ok(json!({ "turnId": out.turn_id, "queued": out.queued, "scoped": scoped }))
    }

    /// A follow-up with run extras in its queue item (`grants`, `once`, `fork`): read by `start_turn`.
    async fn follow_up_with(self: &Arc<Self>, id: &SessionId, text: String, extras: Value) -> Result<FollowedUp> {
        {
            let _g = self.task_lock(id.as_str()).await;
            let mut s = self.repo.session(id.as_str()).await?;
            with_slot(&mut s.ext, |m| m.insert("next".into(), extras));
            self.persist(&mut s, Vec::new()).await?;
        }
        self.follow_up(FollowUpArgs { id: id.clone(), text, queue: Some(true), ..FollowUpArgs::default() }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_prompt_is_v1s() {
        let b = vec![json!({"tool": "Bash", "detail": "npm publish", "rule": "Bash(npm publish)"}), json!({"tool": "Write"})];
        assert_eq!(
            retry_prompt(&b, true),
            "These actions were blocked by your permissions last turn:\n- Bash: `npm publish`\n- Write\n\nI allowed exactly these for this follow-up. Run them now and finish the task."
        );
        assert!(retry_prompt(&b, false).contains("runs in Full auto"));
    }

    #[test]
    fn a_retry_prompt_never_quotes_a_env_value_its_refused_command_did() {
        let d = "curl -H 'Bearer sk-live-one' x";
        let b =
            vec![json!({"tool": "Bash", "detail": d, "rule": format!("Bash({d})"), "hide": {"detail": [[16, 27]], "rule": [[21, 32]]}})];
        let p = retry_prompt(&b, true);
        assert!(!p.contains("sk-live") && p.contains("- Bash: `curl -H 'Bearer ••••' x`"), "{p}");
        // unreadable ranges: the whole line goes
        let bad = vec![json!({"tool": "Bash", "detail": d, "hide": 7})];
        assert!(retry_prompt(&bad, true).contains("- Bash: `••••`"));
    }
}
