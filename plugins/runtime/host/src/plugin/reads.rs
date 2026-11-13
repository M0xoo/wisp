//! The commands that read a task (get, list, usage, search, cards), the ext slots a plugin writes,
//! `runtime.exec`, and what agents read of the user's tasks.

use wisp_kernel::{Setup, WireError};
use wisp_runtime_api::commands as c;

use super::{Slot, rt, track};

pub(super) fn reads(s: &mut Setup, slot: &Slot) {
    cmd!(s, slot, c::Get, |r, call, a| r.get(a.id.as_str()).await);
    cmd!(s, slot, c::ResumeCommand, |r, call, a| r.resume_line(a.id.as_str()).await.map(|command| c::ResumeLine { command }));
    cmd!(s, slot, c::List, |r, call, a| Ok(r.list(&a).iter().map(|x| (**x).clone()).collect()));
    // runtime.turns, runtime.activity and runtime.presentation answer with .env values masked (ADR-0050)
    crate::env_view::register(s, slot);
    cmd!(s, slot, c::Cold, |r, call, a| r.cold(a.id.as_str()).await);
    cmd!(s, slot, c::SetExt, |r, call, a| {
        own_slot(&call, &a.plugin)?;
        r.set_ext(a.id.as_str(), &a.plugin, a.value).await.map(|()| c::Ack {})
    });
    cmd!(s, slot, c::Usage, |r, call, a| {
        let from = r.now() - i64::from(a.days.unwrap_or(7).clamp(1, 366)) * 86_400_000;
        let turns = r.repo.turns_since(from).await?;
        // where each task ran, for the per-project breakdown (v1 usage.js By project)
        let cwd: std::collections::HashMap<String, String> =
            r.repo.sessions().await?.into_iter().map(|x| (x.id.as_str().to_owned(), x.cwd)).collect();
        Ok(wisp_runtime_core::usage::breakdown(&turns, from, r.now(), &|id| cwd.get(id).cloned()))
    });
    exec(s, slot);
    cmd!(s, slot, c::AppState, |r, call, a| r.app_state(a.id.as_str(), a.turn_id.as_str(), &a.block, a.state).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::TurnSetExt, |r, call, a| {
        own_slot(&call, &a.plugin)?;
        r.turn_set_ext(a.id.as_str(), a.turn_id.as_str(), &a.plugin, a.value).await.map(|()| c::Ack {})
    });
    cmd!(s, slot, c::Note, |r, call, a| r
        .note(a.id.as_str(), a.turn_id.as_ref().map(wisp_runtime_api::TurnId::as_str), &a.label, a.tone)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Settle, |r, call, a| r.settle(a.id.as_str(), a.quiet).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Search, |r, call, a| r.search(&a.q, a.limit.unwrap_or(30).clamp(1, 100)).await);
    cmd!(s, slot, c::Card, |r, call, a| r.card(a).await);
    cmd!(s, slot, c::Import, |r, call, a| r.import_v1(a.dir.map(Into::into)).await);
}

/// `runtime.exec`, counted as `exec_action`.
fn exec(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::Exec, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let (code, output) = r.exec(a.id.as_str(), &a.command).await.map_err(WireError::from)?;
            let agent = r.get(a.id.as_str()).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "exec_action", serde_json::json!({ "agent": agent, "exitCode": code })).await;
            Ok(c::ExecOut { code, output })
        }
    });
}

/// A plugin writes its own ext slot only; the user and the kernel may write any.
fn own_slot(call: &wisp_kernel::Call, plugin: &str) -> crate::error::Result<()> {
    let caller = call.caller();
    let ok = matches!(caller.set.as_str(), "user:full" | "kernel") || caller.plugin.as_deref() == Some(plugin);
    if ok { Ok(()) } else { Err(WireError::forbidden(format!("{} may not write {plugin}'s slot", caller.set)).into()) }
}

/// What agents read of the user's tasks (`wisp_sessions`, `wisp_session`), with their usage events.
pub(super) fn for_agents(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::AgentSessions, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let capped = call.caller().set.starts_with("agent:capped");
            let out = r.agent_sessions(&a, capped).await.map_err(WireError::from)?;
            let agent = r.get(&a.session).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "wisp_sessions", serde_json::json!({ "agent": agent })).await;
            Ok(out)
        }
    });
    let sl = slot.clone();
    s.command::<c::AgentSession, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let capped = call.caller().set.starts_with("agent:capped");
            let out = crate::env_view::mask_agent_text(&ctx, r.agent_session(&a, capped).await.map_err(WireError::from)?);
            let agent = r.get(&a.session).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "wisp_session", serde_json::json!({ "agent": agent })).await;
            Ok(out)
        }
    });
}
