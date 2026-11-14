//! `crew.agent.add`, the `wisp_crew_add` tool (v1 POST /internal/crew/:id): `from` takes in what someone shared
//! (a share link, v1's gist, an https `.crew.json`, or its JSON) through `crew.import`'s own path, paused; without it
//! a member is made from the fields. In the caller's project unless it names one; a refusal is the agent's answer.
//! `crew.agent.list`, `.edit`, `.remove`: `wisp_crew`, `wisp_crew_edit`, `wisp_crew_remove` (v1 GET/PATCH/DELETE
//! /internal/crew/:id), in v1's words.

use std::sync::Arc;

use wisp_crew_api::commands as c;
use wisp_crew_core::mentions::handle_of;
use wisp_crew_core::tools::{member_detail, member_line};
use wisp_kernel::{Setup, WireError};

use crate::jobs::{checkin, now};
use crate::{State, calls};

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::AgentAdd, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let refuse = |e: WireError| Ok(c::AgentText { text: None, error: Some(e.message) });
            let project = match &a.member.cwd {
                Some(cwd) => cwd.clone(),
                None => calls::task(&ctx, &call, &a.session).await.map(|t| t.cwd).unwrap_or_default(),
            };
            if let Some(from) = a.from.as_deref().filter(|f| !f.trim().is_empty()) {
                let args = crate::transfer::from_args(from);
                return match Box::pin(crate::transfer::take_in(&ctx, &call, &st, args, "agent", Some(&project))).await {
                    Ok(out) => Ok(c::AgentText { text: Some(crate::transfer::joined_text(&out.members, &project)), error: None }),
                    Err(e) => refuse(e),
                };
            }
            let body = c::MemberBody { cwd: Some(project), ..a.member.clone() };
            let m = match st.normalize(
                &body,
                None,
                now(&ctx),
                &calls::profile_names(&ctx, &call).await,
                &calls::machine_ids(&ctx, &call).await,
            ) {
                Ok(m) => m,
                Err(e) => return refuse(e),
            };
            st.put(m.clone());
            st.save().await;
            ctx.emit(&call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "create".into() });
            if a.checkin == Some(true) {
                crate::calls::warn("the first check-in", checkin(&ctx, &call, &st, &m.id, false).await.map(|_| ()));
            }
            Ok(c::AgentText { text: Some(format!("Added {} to your crew (@{}).", m.name, handle_of(&m.name))), error: None })
        }
    });
}

/// v1's `named`: the member, or the words that send the agent to `wisp_crew`.
fn named(st: &State, key: &str) -> Result<wisp_crew_api::Member, String> {
    st.member(key.trim()).map_err(|_| format!("No one called “{key}” on the user's crew. List it with wisp_crew."))
}

fn said(text: String) -> c::AgentText {
    c::AgentText { text: Some(text), error: None }
}

fn refused(error: String) -> c::AgentText {
    c::AgentText { text: None, error: Some(error) }
}

/// A capped task sees the members of its own project, and itself (v1's `seen`).
fn seen(capped: bool, task: Option<&wisp_runtime_api::Session>, m: &wisp_crew_api::Member) -> bool {
    let Some(t) = task.filter(|_| capped) else { return true };
    let own = crate::calls::crew_of(t).get("id").and_then(serde_json::Value::as_str) == Some(m.id.as_str());
    let inside = |a: &str, b: &str| a == b || a.strip_prefix(b).is_some_and(|r| r.starts_with('/'));
    own || (!m.cwd.is_empty() && (inside(&t.cwd, &m.cwd) || inside(&m.cwd, &t.cwd)))
}

/// `remember`: at most 12 lines, each on one line and up to 300 characters, after the notebook (v1 PATCH).
fn remembered(notebook: &str, lines: &[String]) -> Option<String> {
    let lines: Vec<String> = lines
        .iter()
        .filter(|x| !x.trim().is_empty())
        .take(12)
        .map(|x| format!("- {}", x.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect::<String>()))
        .collect();
    (!lines.is_empty()).then(|| std::iter::once(notebook.to_owned()).filter(|n| !n.is_empty()).chain(lines).collect::<Vec<_>>().join("\n"))
}

pub(crate) fn register_reads(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::AgentList, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let capped = call.caller().set.starts_with("agent:capped");
            let task = if capped { calls::task(&ctx, &call, &a.session).await.ok() } else { None };
            if let Some(key) = a.member.as_deref().filter(|k| !k.trim().is_empty()) {
                let m = match named(&st, key) {
                    Ok(m) => m,
                    Err(e) => return Ok(refused(e)),
                };
                if !seen(capped, task.as_ref(), &m) {
                    return Ok(said(wisp_kernel::caps::capped_refusal("read a member of another project")));
                }
                return Ok(said(member_detail(&crate::jobs::view(&ctx, &call, &st, &m).await)));
            }
            let crew: Vec<_> = crate::lock(&st.saved).crew.iter().filter(|m| seen(capped, task.as_ref(), m)).cloned().collect();
            if crew.is_empty() {
                return Ok(said("The user has no crew yet. Add a member with wisp_crew_add.".into()));
            }
            let mut lines = Vec::with_capacity(crew.len());
            for m in &crew {
                lines.push(member_line(&crate::jobs::view(&ctx, &call, &st, m).await));
            }
            Ok(said(format!("{} on the user's crew:\n\n{}", crew.len(), lines.join("\n"))))
        }
    });
}

pub(crate) fn register_changes(s: &mut Setup, st: &Arc<State>) {
    let st2 = st.clone();
    s.command::<c::AgentEdit, _, _>(move |ctx, call, a| {
        let st = st2.clone();
        async move {
            let prev = match named(&st, &a.member) {
                Ok(m) => m,
                Err(e) => return Ok(refused(e)),
            };
            // the tool's fields only (v1 `pick(EDIT_FIELDS)`): its kit, team, machine and colours aren't set here
            let mut body = c::MemberBody { kit: None, team: None, machine: None, sandbox: None, color: None, bg: None, ..a.fields.clone() };
            let given_notebook = body.notebook.is_some();
            if let Some(n) = remembered(body.notebook.as_deref().unwrap_or(&prev.notebook), a.remember.as_deref().unwrap_or_default()) {
                body.notebook = Some(n);
            }
            let m = match st.normalize(
                &body,
                Some(&prev),
                now(&ctx),
                &calls::profile_names(&ctx, &call).await,
                &calls::machine_ids(&ctx, &call).await,
            ) {
                Ok(m) => m,
                Err(e) => return Ok(refused(e.message)),
            };
            st.put(m.clone());
            st.save().await;
            ctx.emit(&call, &wisp_crew_api::events::MemberChanged { crew_id: m.id.clone() });
            let nb = if given_notebook || a.remember.as_ref().is_some_and(|r| !r.is_empty()) {
                format!("\n\nTheir notebook now has {} characters.", m.notebook.encode_utf16().count())
            } else {
                String::new()
            };
            Ok(said(format!("Updated {}.\n\n{}{nb}", m.name, member_line(&crate::jobs::view(&ctx, &call, &st, &m).await))))
        }
    });
    let st = st.clone();
    s.command::<c::AgentRemove, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let m = match named(&st, &a.member) {
                Ok(m) => m,
                Err(e) => return Ok(refused(e)),
            };
            let own = calls::task(&ctx, &call, &a.session).await.ok();
            if own.as_ref().and_then(|t| calls::crew_of(t).get("id").and_then(serde_json::Value::as_str)) == Some(m.id.as_str()) {
                let why = format!("You are {}: a member's job can't remove itself from the crew. Tell the user, who can remove you in wisp.", m.name);
                return Ok(refused(why));
            }
            let running = crate::jobs::view(&ctx, &call, &st, &m).await.running;
            st.remove(&m.id);
            st.save().await;
            ctx.emit(&call, &wisp_crew_api::events::Left { crew_id: m.id.clone() });
            let still = if running > 0 { format!(" ({running} still running)") } else { String::new() };
            Ok(said(format!(
                "Removed {} from the user's crew. Their brief, notebook and schedule are gone; their jobs stay as ordinary tasks{still}, and triggers that sent them work are off.",
                m.name
            )))
        }
    });
}
