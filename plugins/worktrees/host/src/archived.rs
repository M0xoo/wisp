//! Archiving removes a clean worktree (v1 routes/sessions.js PATCH archived, git.js "a follow-up brings it
//! back from its branch"). When runtime says a session changed and it's archived and not working (no turn
//! running, nothing queued), its folder goes through the safe removal: strict (anything only the folder holds,
//! or git can't tell, keeps it), never a foreign one, and the branch always stays. v1 counted only uncommitted
//! paths, so commits made off the task's branch went with the folder; strict keeps those too. Keep worktree
//! on means it never goes (v1 removed it anyway). Before any turn runs, `bring_back` makes the folder ready
//! again on its branch (`runtime.run@1` `ready`), or the turn is refused with why.

use serde_json::Value;
use wisp_kernel::{Call, Ctx};
use wisp_runtime_api::commands::{Get, IdArgs};
use wisp_runtime_api::model::{Session, SessionState};
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

/// Keep worktree is on for it (`kept` in the slot, `worktrees.keep`).
pub fn kept(slot: Option<&Value>) -> bool {
    slot.and_then(|v| v.get("kept")).and_then(Value::as_bool).unwrap_or(false)
}

/// The folder an archived task's change should remove: archived and idle, not shipping, not kept, and it
/// has one. None: it stays.
pub fn to_remove(s: &Session) -> Option<Worktree> {
    if !due(s.archived, s.state, s.queue.len()) || shipping(s.ext.get("wisp.ship")) || kept(s.ext.get(EXT)) {
        return None;
    }
    tree_of(s.ext.get(EXT))
}

/// Removes an archived task's folder when it's clean; None when there was nothing on disk to look at.
/// `mark`: `Engine::mark` from before the task was read; a turn claiming the folder since stops it.
pub async fn tidy(e: &Engine, call: &Call, wt: &Worktree, mark: u64) -> Option<Removed> {
    if e.foreign(wt) || !fsx::exists(&wt.path).await {
        return None;
    }
    let still = || !e.claimed_since(&wt.path, mark);
    match e.remove(call, wt, RemoveOpts { strict: true, ..RemoveOpts::default() }, Some(&still)).await {
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
    let mark = e.mark();
    let Ok(s) = ctx.run::<Get>(&call, IdArgs { id: id.to_owned().into() }).await else { return false };
    let Some(wt) = to_remove(&s) else { return false };
    match tidy(e, &call, &wt, mark).await {
        Some(r) if r.removed => {
            ctx.emit(&call, &WorktreeRemoved { root: wt.root.clone(), path: wt.path.clone(), branch_deleted: r.branch_deleted });
            true
        }
        _ => false,
    }
}

/// Before a turn runs in a task with a worktree: claims the folder (a removal decided earlier stands down) and
/// brings it back on its branch if archiving removed it. Err: why the turn can't run (a brought-in folder
/// that's gone, a branch that's gone, git refusing), said on the refused turn.
pub async fn bring_back(e: &Engine, call: &Call, task: &str, wt: &Worktree) -> Result<(), String> {
    e.claim(&wt.path, task);
    match e.ensure(call, wt).await {
        Ok(()) if fsx::exists(&wt.cwd).await || wt.cwd.is_empty() => Ok(()),
        Ok(()) => Err(format!("This task's worktree came back without its folder {}. Nothing was started.", wt.cwd)),
        Err(err) => Err(format!(
            "This task's worktree couldn't come back on its branch {} ({err}). It runs only there, so nothing was started.",
            wt.branch
        )),
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

    /// v1 removed an archived task's clean worktree even with Keep worktree on; Keep on means it never goes.
    #[test]
    fn an_archived_tasks_worktree_with_keep_on_is_never_removed() {
        use serde_json::json;
        let slot = json!({ "path": "/h/worktrees/app-1", "cwd": "/h/worktrees/app-1", "branch": "wisp/a", "base": "main",
            "baseRef": "origin/main", "root": "/w/app", "createdAt": 0 });
        let mut s = Session { archived: true, state: SessionState::Done, ..Session::default() };
        s.ext.insert(EXT.into(), slot.clone());
        assert_eq!(to_remove(&s).map(|w| w.path), Some("/h/worktrees/app-1".to_owned()));
        let mut pinned = slot;
        pinned["kept"] = json!(true);
        s.ext.insert(EXT.into(), pinned);
        assert!(to_remove(&s).is_none(), "Keep worktree on");
        assert!(!kept(Some(&json!({ "kept": false }))) && !kept(None));
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
