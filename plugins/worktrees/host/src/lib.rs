//! wisp-worktrees: the wisp.worktrees plugin. Each session may get its own checkout (made, prepared,
//! brought back, removed only when nothing would be lost), Settings → Worktrees and the hourly sweep,
//! Done's folder dialog, and project trust (a `before:run` guard that holds a turn until the repo's own
//! programs are trusted). Git is `git.service@1` (every call carries the caller's `Call`, so git checks
//! its permissions); processes (cp, du, df, setup steps) go through the proc service. Nothing blocks.

pub mod cleanup;
pub mod done;
pub mod engine;
pub mod error;
pub mod fsx;
pub mod pane;
pub mod ports;
mod files;
mod runtime_port;
pub mod prepare;
pub mod trust;

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::OnceCell;
use wisp_git_api::GitServiceV1;
use wisp_kernel::{
    Ctx, Failure, Hook, InterceptOpts, Manifest, Plugin, Result as WireResult, Setup, WireError,
};
use wisp_worktrees_api as api;
use wisp_worktrees_core::sweep::{self, DiskLimits};

pub use cleanup::Cleanup;
pub use engine::Engine;
pub use ports::{MemPort, Port, TaskInfo, TaskTree, WtSettings};

/// runtime's `before:run`, read by field name until `wisp-runtime-api` exports `BeforeRun` (its
/// `BeforeRunCtx` fields `cwd`, `agent`, `mode`, `hold`, `untrusted` are what trust reads and sets).
#[derive(Debug)]
pub struct BeforeRunView;
impl Hook for BeforeRunView {
    const ID: &'static str = "before:run";
    type Ctx = Value;
}

/// The plugin. `home`: wisp's home (`~/.wisp`); `user_home`: the user's (Conductor's folders).
#[derive(Debug, Clone)]
pub struct WorktreesPlugin {
    pub home: String,
    pub user_home: String,
}

impl WorktreesPlugin {
    pub fn new(home: impl Into<String>, user_home: impl Into<String>) -> Self {
        Self {
            home: home.into(),
            user_home: user_home.into(),
        }
    }
}

/// The engine, the cleanup and the port, built once.
type Parts = (Arc<Engine>, Arc<Cleanup>, Arc<dyn Port>);

/// What the handlers share: built once the plugin set has resolved (git.service is provided by then).
pub struct State {
    pub plugin: WorktreesPlugin,
    built: OnceCell<Parts>,
    /// a sweep is already due a few minutes after a new folder took the count past the cap
    pub cap_pending: std::sync::atomic::AtomicBool,
    /// Bring in's offers as last looked for (git worktree list per project is not run per refresh)
    pub offers: tokio::sync::Mutex<Vec<api::Offer>>,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State")
            .field("plugin", &self.plugin)
            .finish_non_exhaustive()
    }
}

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

impl State {
    pub fn new(plugin: WorktreesPlugin) -> Arc<Self> {
        Arc::new(Self {
            plugin,
            built: OnceCell::new(),
            cap_pending: false.into(),
            offers: tokio::sync::Mutex::new(Vec::new()),
        })
    }

    /// For tests and installs that wire the parts themselves.
    pub fn with(
        plugin: WorktreesPlugin,
        engine: Arc<Engine>,
        cleanup: Arc<Cleanup>,
        port: Arc<dyn Port>,
    ) -> Arc<Self> {
        Arc::new(Self {
            plugin,
            built: OnceCell::new_with(Some((engine, cleanup, port))),
            cap_pending: false.into(),
            offers: tokio::sync::Mutex::new(Vec::new()),
        })
    }

    /// Looks for Bring in offers again (every declared project's worktrees).
    pub async fn look_for_offers(&self, ctx: &Ctx) {
        let Ok((e, _, p)) = self.parts(ctx).await else { return };
        let found = pane::offers(&e, p.as_ref(), &ctx.root_call()).await;
        *self.offers.lock().await = found;
    }

    /// Republishes the pane's rows (`pane::publish`) from the last look and the offers.
    pub async fn refresh(&self, ctx: &Ctx) {
        let (Ok((_, c, _)), Ok(store)) = (self.parts(ctx).await, ctx.service::<wisp_store::Store>()) else { return };
        let view = c.view(false).await;
        let offers = self.offers.lock().await.clone();
        if let Err(e) = pane::publish(&store, &view, &offers).await {
            tracing::warn!(error = %e, "worktrees: publishing the pane's rows");
        }
    }

    pub async fn parts(&self, ctx: &Ctx) -> WireResult<(Arc<Engine>, Arc<Cleanup>, Arc<dyn Port>)> {
        self.built
            .get_or_try_init(|| async {
                let git = ctx.use_service::<GitServiceV1>()?;
                let proc = ctx.service::<wisp_proc::Proc>()?.as_ref().clone();
                let clock = ctx.clock()?;
                // an install may provide its own; else the runtime-backed one
                let port: Arc<dyn Port> = match ctx.service::<Arc<dyn Port>>() {
                    Ok(p) => p.as_ref().clone(),
                    Err(_) => runtime_port::RuntimePort::new(ctx.clone(), clock.now_ms()),
                };
                let sources = ctx.contributions(&api::SETUP_SOURCES);
                let engine = Arc::new(Engine::new(
                    git,
                    proc,
                    clock,
                    self.plugin.home.clone(),
                    self.plugin.user_home.clone(),
                    platform(),
                    sources,
                    ctx.scope().clone(),
                ));
                let cleanup = Cleanup::new(engine.clone(), port.clone(), ctx.root_call());
                Ok::<_, WireError>((engine, cleanup, port))
            })
            .await
            .cloned()
    }
}

impl Plugin for WorktreesPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> WireResult<()> {
        let st = State::new(self.clone());
        commands::register(s, &st);
        files::register(s);
        let hook_st = st.clone();
        s.intercept::<BeforeRunView, _, _>(
            InterceptOpts {
                priority: 50,
                failure: Failure::Closed,
                timeout_ms: 1000,
            },
            move |ctx, _call, hctx| {
                let st = hook_st.clone();
                async move {
                    let Ok((engine, _, port)) = st.parts(&ctx).await else {
                        return wisp_kernel::Verdict::Continue;
                    };
                    let set = port.settings().await;
                    let hooks = trust::hooks_of(&ctx, hctx.get("agent").and_then(serde_json::Value::as_str).unwrap_or_default());
                    trust::before_run(
                        &set.trust,
                        set.project_ask.as_deref(),
                        &engine.user_home,
                        hooks.as_ref(),
                        hctx,
                    )
                    .await
                }
            },
        );
        let start_st = st;
        s.on_start(move |ctx| async move {
            if let Ok(store) = ctx.service::<wisp_store::Store>() {
                pane::install(&store).map_err(|e| WireError::internal(e.to_string()))?;
            }
            let (engine, cleanup, port) = start_st.parts(&ctx).await?;
            // the pane's rows: now, and each time a look ends or a clean-up moves
            let (pub_st, pub_ctx, changed) = (start_st.clone(), ctx.clone(), cleanup.clone());
            ctx.spawn(async move {
                pub_st.look_for_offers(&pub_ctx).await;
                pub_st.refresh(&pub_ctx).await;
                loop {
                    changed.changed.notified().await;
                    pub_st.refresh(&pub_ctx).await;
                }
            });
            let mut set = port.settings().await;
            if set.cleanup_from == 0 {
                set.cleanup_from = engine.clock.now_ms();
                port.save_settings(set).await;
            }
            let clock = engine.clock.clone();
            ctx.spawn(async move {
                clock.sleep(sweep::FIRST_SWEEP_MS).await;
                loop {
                    cleanup.sweep(DiskLimits::default()).await;
                    clock.sleep(sweep::SWEEP_MS).await;
                }
            });
            Ok(())
        });
        Ok(())
    }
}

mod commands;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    #[test]
    fn the_manifest_is_valid() {
        let p = super::WorktreesPlugin::new("/tmp/h", "/tmp/u");
        let m = wisp_kernel::Plugin::manifest(&p);
        assert_eq!(m.id, "wisp.worktrees", "{:?}", m.description);
        assert!(m.requires.contains_key("git.service"));
    }

    /// v1's worktree defaults are registry settings (`wisp settings`, formulas, the Settings pane): read through
    /// `ctx.setting`, which answers only for a declared key.
    #[test]
    fn worktree_settings_are_in_the_registry() {
        let p = super::WorktreesPlugin::new("/tmp/h", "/tmp/u");
        let m = wisp_kernel::Plugin::manifest(&p);
        let keys: Vec<String> = m.contributes.get("settings").and_then(serde_json::Value::as_array).into_iter().flatten().filter_map(|s| s.get("key").and_then(serde_json::Value::as_str).map(str::to_owned)).collect();
        for k in ["worktrees.cleanup", "worktrees.max", "worktrees.onDone", "worktrees.projectAsk"] {
            assert!(keys.iter().any(|x| x == k), "{k} in {keys:?}");
        }
        // cleanup has no default: unset is "never chosen", and its clock starts at the upgrade (v1)
        let cleanup = m.contributes["settings"].as_array().and_then(|a| a.iter().find(|s| s["key"] == "worktrees.cleanup")).cloned().unwrap_or_default();
        assert!(cleanup.get("default").is_none());
        // and v1's names import to them
        assert_eq!(wisp_settings_api::key_of("worktreeMax"), "worktrees.max");
    }
}
