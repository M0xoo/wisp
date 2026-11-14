//! `ship.agent.pr`: the `wisp_pr` tool (v1 POST /internal/prs). The agent attaches a GitHub PR to its task, or
//! detaches one; it shows on the task's PR row like one Ship it opened, and wisp follows its checks and reviews.
//! A subagent's PR goes on its lead's task (unless it's a crew member's own), where the user looks. Answers
//! `{ text }`, or `{ error }` for a refusal the agent reads.

use serde_json::Value;
use wisp_kernel::caps::capped_refusal;
use wisp_kernel::{Setup, WireError};
use wisp_runtime_api::commands as rt;
use wisp_ship_api as api;

use crate::{Slot, get, track};

fn said(text: String) -> api::AgentText {
    api::AgentText { text: Some(text), error: None }
}

fn refused(error: impl Into<String>) -> api::AgentText {
    api::AgentText { text: None, error: Some(error.into()) }
}

/// The PR as the agent gave it: a string, or a number.
fn pr_ref(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// `#12` or `12`: a number in the task's own repo (all a capped task may name; a URL could be any repo of theirs).
fn is_number(r: &str) -> bool {
    let d = r.strip_prefix('#').unwrap_or(r);
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
}

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<api::AgentPr, _, _>(move |ctx, call, a| {
        let sl = sl.clone();
        async move {
            let ship = get(&sl)?;
            let Ok(own) = ctx.run::<rt::Get>(&call, rt::IdArgs { id: a.session.as_str().into() }).await else {
                return Ok(refused("no such session"));
            };
            let pr = pr_ref(&a.pr);
            if call.caller().set.starts_with("agent:capped") && !a.remove && !is_number(&pr) {
                return Ok(said(capped_refusal("read a PR by URL: give its number in this task’s repo")));
            }
            // the agent's token reads its own task; its lead is read as wisp.ship
            let root = ctx.root_call();
            let lead = match &own.parent_id {
                Some(p) if own.ext_of("wisp.crew").is_null() => ctx.run::<rt::Get>(&root, rt::IdArgs { id: p.clone() }).await.ok(),
                _ => None,
            };
            let agent = own.agent.clone();
            let t = lead.unwrap_or(own);
            let id = t.id.to_string();
            if ship.tasks.get(&id).is_none() {
                // not followed yet (just restarted, or no worktree): what its slot kept, else a task whose PRs are
                // the attached ones, gh running in its folder; never a blank one over the slot
                let kept =
                    wisp_ship_core::slot::sync(wisp_ship_core::slot::restore(&id, t.ext_of(api::PLUGIN)), &crate::wire::facts_of(&t));
                let child = t.parent_id.is_some();
                ship.tasks.put(kept.unwrap_or_else(|| api::ShipTask {
                    session: id.clone(),
                    cwd: t.cwd.clone(),
                    child,
                    ..api::ShipTask::default()
                }));
            }
            let out = match ship.attach(&root, &id, &pr, a.remove).await {
                Ok(x) => said(x.text),
                Err(e) => refused(WireError::from(e).message),
            };
            track(&ctx, "wisp_pr", serde_json::json!({ "agent": agent, "remove": a.remove }));
            Ok(out)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capped_task_names_a_pr_by_its_number_only() {
        assert!(is_number("12") && is_number("#12"));
        assert!(!is_number("https://github.com/o/r/pull/12") && !is_number("#") && !is_number(""));
        assert_eq!(pr_ref(&serde_json::json!(7)), "7");
        assert_eq!(pr_ref(&serde_json::json!(" #7 ")), "#7");
    }
}
