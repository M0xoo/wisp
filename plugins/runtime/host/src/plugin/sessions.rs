//! A harness's own sessions: `runtime.sessions` lists them, `runtime.adoptSession` takes one in,
//! `runtime.restoreSession` writes one back.

use wisp_kernel::{Setup, WireError};
use wisp_runtime_api::commands as c;

use super::{Slot, rt};

/// Registers `runtime.sessions`, `runtime.adoptSession` and `runtime.restoreSession`.
pub(super) fn sessions(s: &mut Setup, slot: &Slot) {
    s.command::<c::Sessions, _, _>(|ctx, _call, a| async move {
        let mut out = Vec::new();
        for h in ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS) {
            out.extend(h.list(&a.cwd).await);
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        Ok(out)
    });
    let adopting = slot.clone();
    s.command::<c::AdoptSession, _, _>(move |ctx, _call, a| {
        let slot = adopting.clone();
        async move {
            if !wisp_runtime_api::harness::sessions::safe_id(&a.id) {
                return Err(WireError::invalid(format!("{} isn't a session id", a.id)));
            }
            let h = ctx
                .contributions(&wisp_runtime_api::harness::sessions::SESSIONS)
                .into_iter()
                .find(|h| h.harness() == a.harness)
                .ok_or_else(|| WireError::not_found(format!("{} can't read its sessions", a.harness)))?;
            let (sess, turns) = h.read(&a.id).await.ok_or_else(|| WireError::not_found(format!("no {} session {}", a.harness, a.id)))?;
            let args = crate::specs::adopted(&sess, &turns);
            let rt = rt(&slot)?;
            if let Some(made) = rt.readopt(&sess.id, &args).await.map_err(WireError::from)? {
                return Ok(made);
            }
            rt.adopt(args).await.map_err(WireError::from)
        }
    });
    s.command::<c::RestoreSession, _, _>(|ctx, _call, a| async move {
        use base64::Engine as _;
        if !wisp_runtime_api::harness::sessions::safe_id(&a.id) {
            return Err(WireError::invalid(format!("{} isn't a session id", a.id)));
        }
        let h = ctx
            .contributions(&wisp_runtime_api::harness::sessions::SESSIONS)
            .into_iter()
            .find(|h| h.harness() == a.harness)
            .ok_or_else(|| WireError::not_found(format!("{} can't take a session back", a.harness)))?;
        let raw = base64::engine::general_purpose::STANDARD.decode(a.raw.as_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
        Ok(serde_json::json!({ "restored": h.restore(&a.id, &a.cwd, raw).await }))
    });
}
