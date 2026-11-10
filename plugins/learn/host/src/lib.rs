//! wisp.learn host (v1 server/preferences.js `Preferences`, `Retro`): the lists in learn-owned tables (`store.rs`),
//! the block every task's system prompt carries (`runtime.prompt@1`), `learn.view` / `learn.set` / `learn.retro`,
//! and the retro: a task quiet for `IDLE_MS` (90 s) after a turn that ended done or stopped is read by a lean
//! `runtime.quick` run on its own harness, one retro at a time; a new turn meanwhile cancels the wait.
//! The rules are `wisp_learn_core`'s.

mod retro;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_learn_api::{GLOBAL, Kind, Lists, Read, RunRetro, SETTING_ON, Set, View};
use wisp_learn_core::{clean, prompt_block};
use wisp_runtime_api::model::Session;
use wisp_runtime_api::points::{PROMPT, PromptPart};

#[derive(Debug, Default)]
pub struct LearnPlugin;

pub(crate) struct State {
    pub data: Mutex<store::Data>,
    pub store: OnceLock<wisp_store::Store>,
    /// session → its latest wait; a new turn bumps it, so the wait it started finds itself stale
    pub waits: Mutex<HashMap<String, u64>>,
    /// one retro at a time
    pub one: tokio::sync::Mutex<()>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

/// v1 `defaults.learn`: on unless it's switched off.
pub(crate) fn enabled(ctx: &Ctx) -> bool {
    !matches!(ctx.setting(SETTING_ON), Some(serde_json::Value::Bool(false)))
}

/// The project a task belongs to: its worktree's main checkout, else its folder (v1 `projectOf`).
pub(crate) fn project_of(s: &serde_json::Value) -> String {
    let root = s.pointer("/ext/wisp.worktrees/root").and_then(serde_json::Value::as_str).filter(|r| !r.is_empty());
    root.or_else(|| s.get("cwd").and_then(serde_json::Value::as_str)).unwrap_or_default().to_owned()
}

impl State {
    pub fn view(&self, on: bool) -> View {
        let d = lock(&self.data);
        View { global: d.global.clone(), projects: d.projects.clone(), history: d.history.clone(), enabled: on }
    }

    /// One list replaced (cleaned), saved.
    pub async fn set(&self, scope: &str, kind: Kind, items: &[String], at: i64) -> Lists {
        let lists = {
            let mut d = lock(&self.data);
            let l = if scope == GLOBAL { &mut d.global } else { d.projects.entry(scope.to_owned()).or_default() };
            *l.get_mut(kind) = clean(items);
            l.updated_at = at;
            let out = l.clone();
            if scope != GLOBAL && out.is_empty() {
                d.projects.remove(scope);
            }
            out
        };
        if let Some(st) = self.store.get()
            && let Err(e) = store::put_list(st, scope, &lists).await
        {
            tracing::warn!(error = %e, "learn: saving a list");
        }
        lists
    }
}

/// Every task's system prompt carries what was learned, for its project (v1 `prefs.prompt(project)`).
struct Note {
    st: Arc<State>,
    ctx: Ctx,
}

impl PromptPart for Note {
    fn id(&self) -> &'static str {
        wisp_learn_api::PLUGIN_ID
    }
    fn part(&self, s: &Session) -> String {
        if !enabled(&self.ctx) {
            return String::new();
        }
        let project = project_of(&serde_json::to_value(s).unwrap_or_default());
        let d = lock(&self.st.data);
        prompt_block(&d.global, d.projects.get(&project))
    }
}

impl Plugin for LearnPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let st = Arc::new(State { data: Mutex::default(), store: OnceLock::new(), waits: Mutex::default(), one: tokio::sync::Mutex::new(()) });
        let note: Arc<dyn PromptPart> = Arc::new(Note { st: st.clone(), ctx: s.ctx() });
        s.contribute(&PROMPT, note);
        let reader = st.clone();
        s.command::<Read, _, _>(move |ctx, _call, _a| {
            let st = reader.clone();
            async move { Ok(st.view(enabled(&ctx))) }
        });
        let setter = st.clone();
        s.command::<Set, _, _>(move |ctx, _call, a| {
            let st = setter.clone();
            async move {
                if a.scope.trim().is_empty() {
                    return Err(WireError::invalid("Say which list: global, or a project's folder."));
                }
                Ok(st.set(a.scope.trim(), a.kind, &a.items, now(&ctx)).await)
            }
        });
        let runner = st.clone();
        s.command::<RunRetro, _, _>(move |ctx, _call, a| {
            let st = runner.clone();
            async move { retro::run(&ctx, &st, &a.id, true).await }
        });
        retro::schedule(s, &st);
        let opening = st.clone();
        s.on_start(move |ctx| async move {
            let store = ctx.service::<wisp_store::Store>()?.as_ref().clone();
            store::install(&store).map_err(|e| WireError::internal(e.to_string()))?;
            let d = store::load(&store).await.map_err(|e| WireError::internal(e.to_string()))?;
            *lock(&opening.data) = d;
            let _ = opening.store.set(store);
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        let m = LearnPlugin.manifest();
        assert_eq!(m.id, "wisp.learn");
        assert!(m.validate().is_ok(), "{:?}", m.validate());
    }

    #[test]
    fn a_worktree_task_learns_for_its_main_checkout() {
        let wt = serde_json::json!({ "cwd": "/home/u/.wisp/worktrees/app-1", "ext": { "wisp.worktrees": { "root": "/work/app" } } });
        assert_eq!(project_of(&wt), "/work/app");
        assert_eq!(project_of(&serde_json::json!({ "cwd": "/work/other" })), "/work/other");
    }
}
