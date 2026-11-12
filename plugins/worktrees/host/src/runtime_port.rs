//! The install's `Port` when none is provided as a service: wisp.runtime's tasks, through its api
//! commands (`runtime.list`, `runtime.get`, `runtime.setExt`), and the plugin's settings from the
//! kernel's settings store. A task's worktree is its `ext["wisp.worktrees"]` (v1 `session.worktree`);
//! `kept` rides in the same slot. What the cleanup remembers between sweeps (when the cleanup clock
//! started, the last record, project trust) is kept in memory: it starts again on a restart.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_kernel::{BoxFuture, Ctx};
use wisp_runtime_api::commands::{AdoptSession, AdoptSessionArgs, Get, IdArgs, List, ListArgs, Sessions, SessionsArgs, SetExt, SetExtArgs};
use wisp_runtime_api::spec::AdoptArgs;
use wisp_runtime_api::commands::Adopt;
use wisp_runtime_api::model::SessionState;
use wisp_worktrees_api::{EXT, OfferItem, Worktree};

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
fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default().to_owned()
}

impl Port for RuntimePort {
    fn tasks(&self) -> BoxFuture<'static, Vec<TaskInfo>> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            let Ok(list) = ctx.run::<List>(&call, ListArgs { archived: Some(true), limit: None }).await else { return Vec::new() };
            let mut out = Vec::with_capacity(list.len());
            for s in list {
                let Ok(full) = ctx.run::<Get>(&call, IdArgs { id: s.id.clone() }).await else { continue };
                let slot = full.ext.get(EXT).cloned().unwrap_or(Value::Null);
                let trees = serde_json::from_value::<Worktree>(slot.clone()).ok().filter(|w| !w.path.is_empty()).map(|worktree| TaskTree { worktree, pr: None }).into_iter().collect();
                out.push(TaskInfo {
                    id: s.id.0.clone(),
                    title: s.title.clone(),
                    project: project_of(&s.cwd),
                    done: s.state == SessionState::Done,
                    busy: s.state == SessionState::Running || s.queued > 0,
                    kept: slot.get("kept").and_then(Value::as_bool).unwrap_or(false),
                    parked: slot.get("parked").and_then(Value::as_bool).unwrap_or(false),
                    updated_at: s.updated_at,
                    created_at: s.created_at,
                    trees,
                    kids: Vec::new(),
                    parent_id: s.parent_id.as_ref().map(|p| p.0.clone()),
                    // the runs of one compare (runtime's slot, wisp --compare): cleaning one up offers its done siblings
                    group_id: full.ext.get("wisp.runtime").and_then(|o| o.get("group")).and_then(Value::as_str).filter(|g| !g.is_empty()).map(str::to_owned),
                });
            }
            out
        })
    }

    fn set_kept(&self, id: String, kept: bool) -> BoxFuture<'static, ()> {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            let call = ctx.root_call();
            let Ok(full) = ctx.run::<Get>(&call, IdArgs { id: id.clone().into() }).await else { return };
            let mut slot = full.ext.get(EXT).cloned().filter(Value::is_object).unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            slot["kept"] = Value::Bool(kept);
            if let Err(e) = ctx.run::<SetExt>(&call, SetExtArgs { id: id.into(), plugin: EXT.into(), value: slot }).await {
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
            let Ok(list) = ctx.run::<wisp_resources_api::Export>(&call, wisp_resources_api::ExportArgs { kinds: vec!["project".into()], include: Vec::new() }).await else { return Vec::new() };
            list.into_iter()
                .filter(|r| r.kind == "project")
                .filter_map(|r| r.spec.get("path").and_then(Value::as_str).filter(|p| p.starts_with('/') || p.contains(":\\")).map(|p| (r.name.clone(), p.to_owned())))
                .collect()
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
                None => ctx.run::<Adopt>(&call, AdoptArgs { title: item.branch.clone(), cwd: item.path.clone(), ..AdoptArgs::default() }).await,
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
            if let Err(e) = ctx.run::<SetExt>(&call, SetExtArgs { id: id.clone(), plugin: EXT.into(), value }).await {
                tracing::warn!(error = %e.message, "worktrees: marking a brought-in worktree");
            }
            Some(id.0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::project_of;

    #[test]
    fn the_project_is_the_last_folder() {
        assert_eq!(project_of("/Users/me/code/wisp/"), "wisp");
        assert_eq!(project_of("C:\\code\\app"), "app");
    }
}
