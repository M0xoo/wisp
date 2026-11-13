//! Archiving removes a clean worktree (v1 routes/sessions.js PATCH archived, git.js "a follow-up brings it
//! back from its branch"). When runtime says a session changed and it's archived and not working (no turn
//! running, nothing queued), its folder goes through the safe removal: strict (anything only the folder holds,
//! or git can't tell, keeps it), never a foreign one, and the branch always stays. v1 counted only uncommitted
//! paths, so commits made off the task's branch went with the folder; strict keeps those too.

use serde_json::Value;
use wisp_kernel::{Call, Ctx};
use wisp_runtime_api::commands::{Get, IdArgs};
use wisp_runtime_api::model::SessionState;
use wisp_worktrees_api::{EXT, RemoveOpts, Removed, Worktree, WorktreeRemoved};

use crate::engine::Engine;
use crate::fsx;

/// Whether an archived session's folder may go now: archived, and nothing running, asking or queued in it.
pub fn due(archived: bool, state: SessionState, queued: usize) -> bool {
    archived && !matches!(state, SessionState::Running | SessionState::Waiting) && queued == 0
}

/// Ship it is using the folder (a ship or a conflict fix's push in flight, `ext["wisp.ship"]`): it waits.
pub fn shipping(ship: Option<&Value>) -> bool {
    ship.is_some_and(|v| !v["shipping"].is_null() || v["conflictFix"]["step"] == "pushing")
}

/// The worktree in a session's slot, if it has one.
pub fn tree_of(slot: Option<&Value>) -> Option<Worktree> {
    serde_json::from_value::<Worktree>(slot?.clone()).ok().filter(|w| !w.path.is_empty())
}

/// Removes an archived task's folder when it's clean; None when there was nothing on disk to look at.
pub async fn tidy(e: &Engine, call: &Call, wt: &Worktree) -> Option<Removed> {
    if e.foreign(wt) || !fsx::exists(&wt.path).await {
        return None;
    }
    match e.remove(call, wt, RemoveOpts { strict: true, ..RemoveOpts::default() }, None).await {
        Ok(r) => Some(r),
        Err(err) => {
            tracing::warn!(error = %err, path = %wt.path, "worktrees: removing an archived task's folder");
            None
        }
    }
}

/// One session changed: if it's archived and idle, its clean folder goes. True when one went.
pub async fn on_changed(ctx: &Ctx, e: &Engine, id: &str) -> bool {
    let call = ctx.root_call();
    let Ok(s) = ctx.run::<Get>(&call, IdArgs { id: id.to_owned().into() }).await else { return false };
    if !due(s.archived, s.state, s.queue.len()) || shipping(s.ext.get("wisp.ship")) {
        return false;
    }
    let Some(wt) = tree_of(s.ext.get(EXT)) else { return false };
    match tidy(e, &call, &wt).await {
        Some(r) if r.removed => {
            ctx.emit(&call, &WorktreeRemoved { root: wt.root.clone(), path: wt.path.clone(), branch_deleted: r.branch_deleted });
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_archived_task_goes_only_when_nothing_runs_or_waits_in_it() {
        assert!(due(true, SessionState::Done, 0));
        assert!(due(true, SessionState::Review, 0));
        assert!(!due(true, SessionState::Running, 0), "archived while it runs: when the turn ends");
        assert!(!due(true, SessionState::Waiting, 0), "its agent asks something");
        assert!(!due(true, SessionState::Review, 1), "a follow-up queued");
        assert!(!due(false, SessionState::Done, 0));
    }

    #[test]
    fn an_archived_tasks_folder_waits_while_ship_it_pushes_from_it() {
        use serde_json::json;
        assert!(shipping(Some(&json!({ "shipping": { "step": "push" } }))));
        assert!(shipping(Some(&json!({ "shipping": null, "conflictFix": { "step": "pushing" } }))));
        assert!(!shipping(Some(&json!({ "shipping": null, "conflictFix": { "step": "done" } }))));
        assert!(!shipping(None));
    }
}
