//! The retention sweep: `runtime.retentionDays` archives finished tasks nobody touched (ADR-0029).

use super::{Slot, rt};

/// How often the retention sweep looks.
const SWEEP_MS: u64 = 6 * 60 * 60 * 1000;

/// `runtime.retentionDays` (ADR-0029): a finished task untouched for that long is archived (never
/// deleted: history is data). 0 keeps everything in the list.
pub(super) fn retention(ctx: &wisp_kernel::Ctx, slot: &Slot) {
    let (ctx2, slot) = (ctx.clone(), slot.clone());
    ctx.spawn(async move {
        let Ok(clock) = ctx2.clock() else { return };
        loop {
            clock.sleep(60_000).await;
            let days = ctx2.setting("runtime.retentionDays").and_then(|v| v.as_i64()).unwrap_or(0);
            if days > 0
                && let Ok(rt) = rt(&slot)
                && let Ok(list) = rt.repo.summaries().await
            {
                let before = clock.now_ms() - days * 86_400_000;
                let call = ctx2.root_call();
                for s in list.iter().filter(|s| !s.archived && s.updated_at < before && !matches!(s.state, wisp_runtime_api::model::SessionState::Running | wisp_runtime_api::model::SessionState::Waiting)) {
                    let _ = ctx2.run_json(&call, "runtime.archive", serde_json::json!({ "id": s.id, "archived": true })).await;
                }
            }
            clock.sleep(SWEEP_MS).await;
        }
    });
}
