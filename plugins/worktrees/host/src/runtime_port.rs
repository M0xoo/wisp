//! The install's `Port` when none is provided as a service: wisp.runtime's tasks, through its api
//! commands (`runtime.list`, `runtime.get`, `runtime.setExt`), and the plugin's settings from the
//! kernel's settings store. A task's worktree is its `ext["wisp.worktrees"]` (v1 `session.worktree`);
//! `kept` rides in the same slot. What the cleanup remembers between sweeps (when the cleanup clock
//! started, the last record, project trust) is kept in memory: it starts again on a restart.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_kernel::{BoxFuture, Ctx};
use wisp_runtime_api::commands::Adopt;
use wisp_runtime_api::commands::{AdoptSession, AdoptSessionArgs, Get, IdArgs, List, ListArgs, Sessions, SessionsArgs, SetExt, SetExtArgs};
use wisp_runtime_api::ext::{merged, update_ext};
use wisp_runtime_api::model::SessionState;
use wisp_runtime_api::spec::AdoptArgs;
use wisp_worktrees_api::{EXT, OfferItem, PrRef, Worktree};

use crate::ports::{Port, TaskInfo, TaskTree, WtSettings};

pub struct RuntimePort {
    ctx: Ctx,
    state: Mutex<WtSettings>,
}

impl std::fmt::Debug for RuntimePort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimePort").finish_non_exhaustive()
    }
}

impl RuntimePort {
    pub fn new(ctx: Ctx, now: i64) -> Arc<Self> {
        Arc::new(Self { ctx, state: Mutex::new(WtSettings { cleanup_from: now, ..WtSettings::default() }) })
    }
}

fn text(v: Option<Value>) -> Option<String> {
    v.and_then(|v| match v {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// The last folder name of a path (the project a task is in).
pub(crate) fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default().to_owned()
}

/// The task's PR as wisp.ship keeps it (`ext["wisp.ship"].pr`, a `PrSummary`: number, url, state, …), so the
/// sweep and Done see a merged or closed one. None: no PR, or one that doesn't read.
pub(crate) fn pr_of(ship: Option<&Value>) -> Option<PrRef> {
    let pr = ship?.get("pr").filter(|p| p.is_object())?;
    let r: PrRef = serde_json::from_value(pr.clone()).ok()?;
    (r.number > 0 && !r.state.is_empty()).then_some(r)
}

/// Each task's kids: the sessions whose parent is it (subagents, delegated jobs), in list order.
pub(crate) fn fill_kids(tasks: &mut [TaskInfo]) {
    let parents: Vec<(String, String)> = tasks.iter().filter_map(|t| t.parent_id.as_ref().map(|p| (p.clone(), t.id.clone()))).collect();
    for t in tasks.iter_mut() {
        t.kids = parents.iter().filter(|(p, _)| *p == t.id).map(|(_, k)| k.clone()).collect();
    }
}

impl Port for RuntimePort {
    fn tasks(&self) -> BoxFuture<'static, Vec<TaskInfo>> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            let now = ctx.clock().map_or(0, |c| c.now_ms());
            let Ok(list) = ctx
                .run::<List>(
                    &call, // every task, archived ones too (`Some(true)` would list only the archived ones)
                    ListArgs { archived: None, limit: None },
                )
                .await
            else {
                return Vec::new();
            };
            let mut out = Vec::with_capacity(list.len());
            for s in list {
                let Ok(full) = ctx.run::<Get>(&call, IdArgs { id: s.id.clone() }).await else { continue };
                let slot = full.ext.get(EXT).cloned().unwrap_or(Value::Null);
                let pr = pr_of(full.ext.get("wisp.ship"));
                let trees = serde_json::from_value::<Worktree>(slot.clone())
                    .ok()
                    .filter(|w| !w.path.is_empty())
                    .map(|worktree| TaskTree { worktree, pr })
                    .into_iter()
                    .collect();
                out.push(TaskInfo {
                    id: s.id.0.clone(),
                    title: s.title.clone(),
                    project: project_of(&s.cwd),
                    done: s.state == SessionState::Done,
                    busy: s.state == SessionState::Running
                        || s.queued > 0
                        || crate::archived::side_pending(full.ext.get("wisp.runtime"), now),
                    kept: slot.get("kept").and_then(Value::as_bool).unwrap_or(false),
                    parked: slot.get("parked").and_then(Value::as_bool).unwrap_or(false),
                    updated_at: s.updated_at,
                    created_at: s.created_at,
                    trees,
                    kids: Vec::new(),
                    parent_id: s.parent_id.as_ref().map(|p| p.0.clone()),
                    // the runs of one compare (runtime's slot, wisp --compare): cleaning one up offers its done siblings
                    group_id: full
                        .ext
                        .get("wisp.runtime")
                        .and_then(|o| o.get("group"))
                        .and_then(Value::as_str)
                        .filter(|g| !g.is_empty())
                        .map(str::to_owned),
                });
            }
            fill_kids(&mut out);
            out
        })
    }

    fn set_kept(&self, id: String, kept: bool) -> BoxFuture<'static, ()> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            // a compare-and-set merge: the slot's other keys (parked, the worktree itself) written meanwhile stay
            let keep = |slot: &Value, _: &_| Ok(Some(merged(slot, &serde_json::json!({ "kept": kept }))));
            if let Err(e) = update_ext(&ctx, &call, &id, EXT, keep).await {
                tracing::warn!(error = %e.message, "worktrees: keeping a worktree");
            }
        })
    }

    fn settings(&self) -> BoxFuture<'static, WtSettings> {
        let mut s = self.state.lock().map(|s| s.clone()).unwrap_or_default();
        s.cleanup = text(self.ctx.setting("worktrees.cleanup"));
        s.max = text(self.ctx.setting("worktrees.max"));
        s.on_done = text(self.ctx.setting("worktrees.onDone"));
        s.project_ask = text(self.ctx.setting("worktrees.projectAsk"));
        Box::pin(async move { s })
    }

    fn save_settings(&self, s: WtSettings) -> BoxFuture<'static, ()> {
        if let Ok(mut cur) = self.state.lock() {
            (cur.cleanup_from, cur.last, cur.trust, cur.dismissed) = (s.cleanup_from, s.last, s.trust, s.dismissed);
        }
        Box::pin(async {})
    }

    fn projects(&self) -> BoxFuture<'static, Vec<(String, String)>> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            let Ok(list) = ctx
                .run::<wisp_resources_api::Export>(
                    &call,
                    wisp_resources_api::ExportArgs { kinds: vec!["project".into()], include: Vec::new() },
                )
                .await
            else {
                return Vec::new();
            };
            list.into_iter()
                .filter(|r| r.kind == "project")
                .filter_map(|r| {
                    r.spec
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|p| p.starts_with('/') || p.contains(":\\"))
                        .map(|p| (r.name.clone(), p.to_owned()))
                })
                .collect()
        })
    }

    fn extra_in_use(&self, path: String) -> BoxFuture<'static, bool> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            let Ok(list) = ctx.run::<List>(&call, ListArgs { archived: None, limit: None }).await else {
                // can't tell: it stays (the next change, or the sweep, looks again)
                return true;
            };
            // only the tasks working now (a handful) are read whole, for their `dirs`
            for s in list.iter().filter(|s| matches!(s.state, SessionState::Running | SessionState::Waiting) || s.queued > 0) {
                let Ok(full) = ctx.run::<Get>(&call, IdArgs { id: s.id.clone() }).await else { continue };
                // as the disk sees them: an extra folder reached through a symlink still keeps the worktree
                for d in &full.dirs {
                    if crate::fsx::within_real(d, &path).await {
                        return true;
                    }
                }
            }
            false
        })
    }

    fn chat_in(&self, path: String) -> BoxFuture<'static, bool> {
        let ctx = self.ctx.clone();
        Box::pin(async move { ctx.run::<Sessions>(&ctx.root_call(), SessionsArgs { cwd: path }).await.is_ok_and(|v| !v.is_empty()) })
    }

    fn bring_in(&self, item: OfferItem, root: String) -> BoxFuture<'static, Option<String>> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            // a chat that ran there: that session, carried on in its CLI; else an empty task in the folder
            let chat = ctx.run::<Sessions>(&call, SessionsArgs { cwd: item.path.clone() }).await.ok().and_then(|v| v.into_iter().next());
            let made = match chat {
                Some(c) => ctx.run::<AdoptSession>(&call, AdoptSessionArgs { harness: c.harness, id: c.id }).await,
                None => {
                    ctx.run::<Adopt>(&call, AdoptArgs { title: item.branch.clone(), cwd: item.path.clone(), ..AdoptArgs::default() }).await
                }
            };
            let id = match made {
                Ok(c) => c.id,
                Err(e) => {
                    tracing::warn!(error = %e.message, path = %item.path, "worktrees: bringing in a worktree");
                    return None;
                }
            };
            let wt = Worktree { path: item.path.clone(), cwd: item.path, branch: item.branch, root, foreign: true, ..Worktree::default() };
            let value = serde_json::to_value(&wt).unwrap_or(Value::Null);
            // set-ext: whole the task was adopted just now for this worktree: its slot is the worktree as found
            if let Err(e) = ctx.run::<SetExt>(&call, SetExtArgs { id: id.clone(), plugin: EXT.into(), value, expect: None }).await {
                tracing::warn!(error = %e.message, "worktrees: marking a brought-in worktree");
            }
            Some(id.0)
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::{TaskInfo, fill_kids, pr_of, project_of};
    use serde_json::json;

    #[test]
    fn the_project_is_the_last_folder() {
        assert_eq!(project_of("/Users/me/code/wisp/"), "wisp");
        assert_eq!(project_of("C:\\code\\app"), "app");
    }

    /// wisp.ship's slot holds a `PrSummary`: its number, url and state are the task's PR (a merged or closed one
    /// lets the sweep take the folder); no slot, a null PR or one that doesn't read is no PR.
    #[test]
    fn the_tasks_pr_is_read_from_ships_slot() {
        let ship =
            json!({ "pr": { "number": 12, "url": "https://x/pr/12", "title": "Fix", "state": "MERGED", "draft": false, "checks": {} } });
        let pr = pr_of(Some(&ship)).unwrap();
        assert_eq!((pr.number, pr.url.as_str(), pr.state.as_str()), (12, "https://x/pr/12", "MERGED"));
        assert!(pr_of(None).is_none());
        assert!(pr_of(Some(&json!({ "pr": null }))).is_none());
        assert!(pr_of(Some(&json!({ "pr": { "number": "x" } }))).is_none());
    }

    /// Done's list walks a task's kids: every session whose parent is it.
    #[test]
    fn a_tasks_kids_are_the_sessions_it_is_parent_of() {
        let t = |id: &str, parent: Option<&str>| TaskInfo { id: id.into(), parent_id: parent.map(str::to_owned), ..TaskInfo::default() };
        let mut all = vec![t("lead", None), t("sub", Some("lead")), t("job", Some("lead")), t("deep", Some("sub")), t("other", None)];
        fill_kids(&mut all);
        assert_eq!(all[0].kids, ["sub", "job"]);
        assert_eq!(all[1].kids, ["deep"]);
        assert_eq!(all[4].kids, Vec::<String>::new());
    }

    /// Done, the sweep and the pane read every task: a live one with a worktree too (the list once asked
    /// for archived ones only, so Done had no folders to ask about).
    #[tokio::test]
    async fn the_tasks_are_every_task_live_and_archived() {
        use wisp_kernel::{Manifest, Plugin, Result, Setup};
        use wisp_runtime_api::model::{Session, Summary};
        struct Rt;
        impl Plugin for Rt {
            fn manifest(&self) -> Manifest {
                Manifest::from_value(
                    json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }),
                )
                .unwrap()
            }
            fn setup(&self, s: &mut Setup) -> Result<()> {
                // runtime.list's own rule: `archived: Some(x)` keeps only rows whose archived is x
                s.command::<super::List, _, _>(|_c, _call, a| async move {
                    let row = |id: &str, archived: bool| Summary { id: id.into(), archived, ..serde_json::from_value(json!({ "id": id, "title": "", "agent": "claude", "model": "", "effort": "", "mode": "auto", "cwd": "/w", "state": "review", "status": "done", "unread": false, "archived": archived, "createdAt": 0, "updatedAt": 0, "turnCount": 1, "queued": 0, "preview": "", "live": "" })).unwrap() };
                    Ok([row("live", false), row("old", true)].into_iter().filter(|r| a.archived.is_none_or(|x| r.archived == x)).collect())
                });
                s.command::<super::Get, _, _>(|_c, _call, a| async move {
                    let mut s = Session { id: a.id.clone(), ..Session::default() };
                    s.ext.insert("wisp.worktrees".into(), json!({ "path": format!("/w/{}", a.id.0), "cwd": "/w", "branch": "b", "base": "main", "baseRef": "origin/main", "root": "/w", "createdAt": 0 }));
                    Ok(s)
                });
                Ok(())
            }
        }
        struct Me;
        impl Plugin for Me {
            fn manifest(&self) -> Manifest {
                Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.worktrees", "version": "2.0.0", "api": "^1", "activation": ["onStartup"], "permissions": ["runtime:list", "runtime:get"] })).unwrap()
            }
            fn setup(&self, _s: &mut Setup) -> Result<()> {
                Ok(())
            }
        }
        let k = wisp_testkit::TestApp::new().with(Rt).with(Me).start().await;
        let port = super::RuntimePort::new(k.ctx("wisp.worktrees").unwrap(), 0);
        let ids: Vec<String> = crate::ports::Port::tasks(port.as_ref()).await.into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["live", "old"]);
    }

    /// Keep (a click) while the slot is written meanwhile (parked by the sweep): both land, where the plain
    /// read-then-write put the stale copy back and lost the park.
    #[tokio::test]
    async fn keeping_a_worktree_keeps_a_write_that_landed_meanwhile() {
        use wisp_runtime_api::model::Session;
        use wisp_runtime_api::testing::{SlotRuntime, caller};
        let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
        rt.set("wisp.worktrees", json!({ "path": "/w/t1" }));
        let k = wisp_testkit::TestApp::new().with(rt.clone()).with(caller("wisp.worktrees")).start().await;
        let port = super::RuntimePort::new(k.ctx("wisp.worktrees").unwrap(), 0);
        rt.race("wisp.worktrees", json!({ "path": "/w/t1", "parked": true }));
        crate::ports::Port::set_kept(port.as_ref(), "t1".into(), true).await;
        assert_eq!(rt.ext("wisp.worktrees"), json!({ "path": "/w/t1", "parked": true, "kept": true }));
    }
}
