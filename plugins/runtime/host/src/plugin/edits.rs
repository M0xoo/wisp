//! The commands that change a task: stop, rename, archive, mode, agent, the queue, held turns.

use wisp_kernel::Setup;
use wisp_runtime_api::commands as c;

use super::Slot;

pub(super) fn edits(s: &mut Setup, slot: &Slot) {
    cmd!(s, slot, c::Stop, |r, call, a| r.stop(a.id.as_str(), a.clear_queue).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Rename, |r, call, a| r.rename(a.id.as_str(), &a.title).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Archive, |r, call, a| r.archive(a.id.as_str(), a.archived).await.map(|()| c::Ack {}));
    // above a capped task's cap: refused, or lifted when it's the user (`Runtime::mode_asked`)
    cmd!(s, slot, c::SetMode, |r, call, a| match r.mode_asked(a.id.as_str(), a.mode, &call.caller().set).await {
        Ok(()) => r.set_mode(a.id.as_str(), a.mode).await.map(|()| c::Ack {}),
        Err(e) => Err(e),
    });
    cmd!(s, slot, c::SetLean, |r, call, a| r.set_lean(a.id.as_str(), a.lean).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::SetAgent, |r, call, a| r.set_agent(a.id.as_str(), &a.agent).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::ForLater, |r, call, a| r.for_later(a.id.as_str(), a.for_later, a.at).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueOrder, |r, call, a| r.queue_order(a.id.as_str(), &a.order).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueCancel, |r, call, a| r.queue_cancel(a.id.as_str(), &a.item_id).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Held, |r, call, a| r.held(a.id.as_str(), a.action == c::ReleaseAction::Start).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::MarkRead, |r, call, a| r.mark_read(a.id.as_str(), a.unread).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::SetState, |r, call, a| r.set_state(a.id.as_str(), a.state).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Delete, |r, call, a| r.delete(a.id.as_str()).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueEdit, |r, call, a| r.queue_edit(a).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueSendNow, |r, call, a| r.queue_send_now(a.id.as_str(), &a.item_id).await);
    cmd!(s, slot, c::QueueMerge, |r, call, a| r.queue_merge(a.id.as_str(), &a.ids).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueText, |r, call, a| r.queue_text(a.id.as_str(), &a.item_id, &a.text).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Release, |r, call, a| r
        .release(a.id.as_str(), a.turn_id.as_str(), a.action == c::ReleaseAction::Start)
        .await
        .map(|()| c::Ack {}));
}
