//! The host: `App` (boot), `Setup` (what a plugin registers), `Ctx` (what a plugin uses at runtime).
//! The signatures here are the contract; the bodies delegate to `dispatch`, `hooks`, `life` and
//! `kernel_api`. More `impl` blocks for these types (all additive) are in `kernel_api.rs`.
//!
//! size-ok: the frozen plugin contract (App, Setup, Ctx): its signatures read in one place
use std::any::Any;
use std::future::Future;
use std::sync::{Arc, Weak};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::call::CallInner;
use crate::caps::{Caller, Compiled};
use crate::events::{EventEnvelope, Payload, SubFn};
use crate::http::Route;
use crate::manifest::Manifest;
use crate::state::{Erased, KernelState};
use crate::{
    BoxFuture, Call, Clock, Command, Event, Hook, InterceptOpts, KernelService, PluginGroup, Point,
    Result, Service, Verdict, WireError,
};

pub(crate) type CmdFn =
    Arc<dyn Fn(Ctx, Call, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub(crate) type HookFn =
    Arc<dyn Fn(Ctx, Call, Value) -> BoxFuture<'static, Result<Verdict<Value>>> + Send + Sync>;
pub(crate) type StartFn = Box<dyn FnOnce(Ctx) -> BoxFuture<'static, Result<()>> + Send>;

type TypedCmdFn<A, O> = Arc<dyn Fn(Ctx, Call, A) -> BoxFuture<'static, Result<O>> + Send + Sync>;
type TypedHookFn<V> = Arc<dyn Fn(Ctx, Call, V) -> BoxFuture<'static, Verdict<V>> + Send + Sync>;
/// The typed handler of command `C`: dispatch downcasts to it and skips the JSON round trip.
pub(crate) struct TypedCmd<C: Command>(pub(crate) TypedCmdFn<C::Args, C::Out>);
/// The typed interceptor of hook `H`.
pub(crate) struct TypedHook<H: Hook>(pub(crate) TypedHookFn<H::Ctx>);

pub(crate) struct CmdReg {
    pub(crate) id: String,
    pub(crate) permission: Option<String>,
    pub(crate) read_only: bool,
    pub(crate) task_args: &'static [&'static str],
    pub(crate) all_tasks: bool,
    pub(crate) json: CmdFn,
    pub(crate) typed: Option<Erased>,
}

pub(crate) struct HookReg {
    pub(crate) hook: String,
    pub(crate) opts: InterceptOpts,
    pub(crate) json: HookFn,
    pub(crate) typed: Option<Erased>,
}

/// What a plugin registers in `setup`. Everything belongs to the plugin's scope.
pub struct Setup {
    pub(crate) plugin: String,
    pub(crate) ctx: Ctx,
    pub(crate) commands: Vec<CmdReg>,
    pub(crate) hooks: Vec<HookReg>,
    pub(crate) events: Vec<(String, SubFn)>,
    pub(crate) points: Vec<(String, u32, Erased, Option<Value>)>,
    pub(crate) services: Vec<(&'static str, u32, Erased)>,
    pub(crate) starts: Vec<StartFn>,
}

impl std::fmt::Debug for Setup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Setup")
            .field("plugin", &self.plugin)
            .finish_non_exhaustive()
    }
}

fn bad(code: &str, message: String) -> Verdict<Value> {
    Verdict::Veto {
        code: code.into(),
        message,
        then: Vec::new(),
    }
}

impl Setup {
    pub(crate) fn new(ctx: Ctx) -> Self {
        Self {
            plugin: ctx.inner.plugin.clone(),
            ctx,
            commands: Vec::new(),
            hooks: Vec::new(),
            events: Vec::new(),
            points: Vec::new(),
            services: Vec::new(),
            starts: Vec::new(),
        }
    }

    /// The plugin's own context, for handlers to capture.
    pub fn ctx(&self) -> Ctx {
        self.ctx.clone()
    }

    /// Handles `C`. The kernel checks the caller's permission before calling `f`.
    pub fn command<C, F, Fut>(&mut self, f: F)
    where
        C: Command,
        F: Fn(Ctx, Call, C::Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<C::Out>> + Send + 'static,
    {
        let f = Arc::new(f);
        let g = f.clone();
        let json: CmdFn = Arc::new(move |ctx, call, args| {
            let f = f.clone();
            Box::pin(async move {
                let args: C::Args = serde_json::from_value(args)
                    .map_err(|e| WireError::invalid(format!("{}: {e}", C::ID)))?;
                let out = f(ctx, call, args).await?;
                serde_json::to_value(out).map_err(|e| WireError::internal(e.to_string()))
            })
        });
        let typed = TypedCmd::<C>(Arc::new(move |ctx, call, args| {
            Box::pin(g(ctx, call, args))
        }));
        self.commands.push(CmdReg {
            id: C::ID.to_owned(),
            permission: C::PERMISSION.map(str::to_owned),
            read_only: C::READ_ONLY,
            task_args: C::TASK_ARGS,
            all_tasks: C::ALL_TASKS,
            json,
            typed: Some(Arc::new(typed)),
        });
    }

    /// Takes part in hook `H`, ordered by `opts.priority`.
    pub fn intercept<H, F, Fut>(&mut self, opts: InterceptOpts, f: F)
    where
        H: Hook,
        F: Fn(Ctx, Call, H::Ctx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Verdict<H::Ctx>> + Send + 'static,
    {
        let f = Arc::new(f);
        let g = f.clone();
        let json: HookFn = Arc::new(move |ctx, call, v| {
            let f = f.clone();
            Box::pin(async move {
                let Ok(hctx) = serde_json::from_value::<H::Ctx>(v) else {
                    return Ok(bad("invalid", format!("{}: bad context", H::ID)));
                };
                Ok(match f(ctx, call, hctx).await {
                    Verdict::Continue => Verdict::Continue,
                    Verdict::Modify { ctx } => match serde_json::to_value(ctx) {
                        Ok(ctx) => Verdict::Modify { ctx },
                        Err(e) => bad("internal", e.to_string()),
                    },
                    Verdict::Veto {
                        code,
                        message,
                        then,
                    } => Verdict::Veto {
                        code,
                        message,
                        then,
                    },
                })
            })
        });
        let typed = TypedHook::<H>(Arc::new(move |ctx, call, c| Box::pin(g(ctx, call, c))));
        self.hooks.push(HookReg {
            hook: H::ID.to_owned(),
            opts,
            json,
            typed: Some(Arc::new(typed)),
        });
    }

    /// Subscribes to `E`, delivered after commit, in order, at least once (dedupe by seq).
    pub fn on<E, F, Fut>(&mut self, f: F)
    where
        E: Event,
        F: Fn(Ctx, E) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let f = Arc::new(f);
        let sub: SubFn = Arc::new(move |ctx, env: Arc<EventEnvelope>| {
            let f = f.clone();
            Box::pin(async move {
                if let Some(e) = env.get::<E>() {
                    f(ctx, e).await;
                }
                Ok(())
            })
        });
        self.events.push((E::TYPE.to_owned(), sub));
    }

    /// Adds an implementation to a list point owned by some plugin.
    pub fn contribute<T: ?Sized + Send + Sync + 'static>(
        &mut self,
        point: &Point<T>,
        item: Arc<T>,
    ) {
        self.points
            .push((point.id.to_owned(), point.version, Arc::new(item), None));
    }

    /// Adds an HTTP route (the `kernel.http` point).
    pub fn route(&mut self, route: Route) {
        self.contribute(&crate::http::ROUTES, Arc::new(route));
    }

    /// Provides service `S` to plugins that request it by contract.
    pub fn provide<S: Service>(&mut self, imp: Arc<S::Api>) {
        self.services.push((S::ID, S::MAJOR, Arc::new(imp)));
    }

    /// Async work once the plugin set has resolved (migrations ran, services provided). Owned by the scope.
    pub fn on_start<F, Fut>(&mut self, f: F)
    where
        F: FnOnce(Ctx) -> Fut + Send + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        self.starts.push(Box::new(move |ctx| Box::pin(f(ctx))));
    }
}

/// A plugin's runtime handle. Cheap to clone.
#[derive(Clone)]
pub struct Ctx {
    pub(crate) inner: Arc<CtxInner>,
}

pub(crate) struct CtxInner {
    pub(crate) plugin: String,
    pub(crate) id: Arc<str>,
    pub(crate) scope: CancellationToken,
    /// weak: a plugin's handles never keep a stopped kernel alive
    pub(crate) kernel: Weak<KernelState>,
    /// `plugin:<id>`: the plugin's manifest permissions
    pub(crate) set: Option<Arc<Compiled>>,
}

impl std::fmt::Debug for Ctx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ctx")
            .field("plugin", &self.inner.plugin)
            .finish_non_exhaustive()
    }
}

impl Ctx {
    pub(crate) fn new(k: &Arc<KernelState>, plugin: &str, scope: CancellationToken) -> Self {
        let set = k.caps.get(&format!("plugin:{plugin}"));
        Self {
            inner: Arc::new(CtxInner {
                plugin: plugin.to_owned(),
                id: Arc::from(plugin),
                scope,
                kernel: Arc::downgrade(k),
                set,
            }),
        }
    }

    pub(crate) fn k(&self) -> Result<Arc<KernelState>> {
        self.inner
            .kernel
            .upgrade()
            .ok_or_else(|| WireError::unavailable("the kernel has stopped"))
    }

    pub fn plugin(&self) -> &str {
        &self.inner.plugin
    }

    /// Cancelled when the plugin is switched off: tie every task, timer and child to it.
    pub fn scope(&self) -> &CancellationToken {
        &self.inner.scope
    }

    /// Spawns a task owned by the plugin's scope.
    pub fn spawn<F: Future<Output = ()> + Send + 'static>(&self, fut: F) {
        let token = self.inner.scope.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = token.cancelled() => {}
                () = fut => {}
            }
        });
    }

    /// A kernel service the install provided (store, proc, net, secrets, paths, clock).
    pub fn service<T: KernelService>(&self) -> Result<Arc<T>> {
        self.k()?
            .service::<T>()
            .ok_or_else(|| WireError::new(crate::Code::ServiceGone, std::any::type_name::<T>()))
    }

    pub fn clock(&self) -> Result<Arc<dyn Clock>> {
        self.service::<Arc<dyn Clock>>().map(|c| (*c).clone())
    }

    /// Runs command `C` as part of `call` (depth + 1, same trace and caller).
    pub fn run<C: Command>(
        &self,
        call: &Call,
        args: C::Args,
    ) -> BoxFuture<'static, Result<C::Out>> {
        crate::dispatch::typed::<C>(self.clone(), call.clone(), args)
    }

    /// Runs the command named `cmd` with JSON args as part of `call` (depth + 1, same trace and caller):
    /// for a plugin that dispatches by name (the MCP server's owner tools, a channel's command line).
    pub fn run_json(&self, call: &Call, cmd: &str, args: serde_json::Value) -> BoxFuture<'static, Result<serde_json::Value>> {
        let (ctx, call, cmd) = (self.clone(), call.clone(), cmd.to_owned());
        Box::pin(async move {
            let k = ctx.k()?;
            crate::dispatch::json(&k, Some(ctx.clone()), &call, &cmd, args).await
        })
    }

    /// Runs hook `H`'s interceptors in order. Ok: the (possibly modified) context. Err(vetoed): refused.
    pub fn run_hook<H: Hook>(
        &self,
        call: &Call,
        hctx: H::Ctx,
    ) -> BoxFuture<'static, Result<H::Ctx>> {
        crate::hooks::typed::<H>(self.clone(), call.clone(), hctx)
    }

    /// Records `e`; it is published after the call that emitted it commits.
    pub fn emit<E: Event>(&self, call: &Call, e: &E) {
        crate::dispatch::emit(self, call, E::TYPE, Payload::Typed(Arc::new(e.clone())));
    }

    pub fn contributions<T: ?Sized + Send + Sync + 'static>(
        &self,
        point: &Point<T>,
    ) -> Vec<Arc<T>> {
        self.k()
            .map(|k| {
                crate::kernel_api::contributions(&k, point)
                    .into_iter()
                    .map(|(_, t)| t)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The provider of `S`, or `service_gone`. Required services are checked when the set resolves.
    pub fn use_service<S: Service>(&self) -> Result<Arc<S::Api>> {
        crate::kernel_api::use_service::<S>(&*self.k()?)
    }

    /// A root call made by this plugin itself (a timer, a subscriber), speaking as `plugin:<id>`.
    pub fn root_call(&self) -> Call {
        let caller = Caller::plugin(&self.inner.plugin);
        let cancel = self.inner.scope.child_token();
        if let Some(k) = self.inner.kernel.upgrade() {
            CallInner::detached(&k, caller, Some(self.inner.id.clone()), cancel).into_call()
        } else {
            let mut c = Call::new_root(caller);
            if let Some(inner) = Arc::get_mut(&mut c.inner) {
                inner.cancel = cancel;
            }
            c
        }
    }
}

/// Boot: services, the plugin group, then `start`.
pub struct App {
    pub(crate) state: Arc<KernelState>,
    pub(crate) group: PluginGroup,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("group", &self.group)
            .finish_non_exhaustive()
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        let state = Arc::new(KernelState::default());
        // the store publishes a command's events when its transaction commits: it finds this hook
        // with `ctx.service::<CommitHook>()`
        let hook = crate::kernel_api::CommitHook::of(&state);
        Self {
            state,
            group: PluginGroup::new(),
        }
        .service(hook)
    }

    /// Provides (or overrides) a kernel service.
    #[must_use]
    pub fn service<T: KernelService>(self, value: T) -> Self {
        if let Ok(mut map) = self.state.services.write() {
            map.insert(
                std::any::TypeId::of::<T>(),
                Arc::new(value) as Arc<dyn Any + Send + Sync>,
            );
        }
        self
    }

    #[must_use]
    pub fn plugins(mut self, group: PluginGroup) -> Self {
        self.group = self.group.extend(group);
        self
    }

    /// Resolves the set (topological by requires/extends, refusals with reasons), runs every setup,
    /// then every `on_start`. Returns the running kernel.
    pub async fn start(self) -> Result<Kernel> {
        crate::life::start(self).await
    }
}

/// A running kernel: dispatch from the edge, plugin status, switch plugins on and off.
#[derive(Clone)]
pub struct Kernel {
    pub(crate) state: Arc<KernelState>,
}

impl std::fmt::Debug for Kernel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kernel").finish_non_exhaustive()
    }
}

impl Kernel {
    /// A command by id with JSON args, as the edge, MCP and the sync layer call it.
    pub fn call(
        &self,
        caller: Caller,
        cmd: &str,
        args: Value,
    ) -> BoxFuture<'static, Result<Value>> {
        crate::dispatch::edge(self.state.clone(), caller, cmd.to_owned(), args)
    }
    /// The agent-token scope for a route (`crate::scope`): its task params against the caller's task.
    /// The edge runs it before every route handler. Additive (2026-11-08).
    pub fn route_scope(&self, caller: &Caller, pattern: &str, params: &std::collections::BTreeMap<String, String>) -> BoxFuture<'static, Result<()>> {
        let ids = crate::scope::route_tasks(pattern, params);
        let caller = caller.clone();
        let what = pattern.to_owned();
        let trees: Vec<Arc<dyn crate::scope::TaskTree>> = if crate::scope::agent_task(&caller).is_some() && !ids.is_empty() { crate::kernel_api::contributions(&self.state, &crate::scope::TASKS).into_iter().map(|(_, t)| t).collect() } else { Vec::new() };
        Box::pin(async move { crate::scope::check(trees, &caller, &what, ids, false).await })
    }

    /// Every contribution to `point`, across plugins that are on.
    pub fn contributions<T: ?Sized + Send + Sync + 'static>(
        &self,
        point: &Point<T>,
    ) -> Vec<Arc<T>> {
        crate::kernel_api::contributions(&self.state, point)
            .into_iter()
            .map(|(_, t)| t)
            .collect()
    }
    /// Each contribution to `point` with the context of the plugin that made it: the edge calls a
    /// `kernel.http` route's handler with its owner's `Ctx`. Additive (wisp-api/edge agent, 2026-11-08).
    pub fn contributions_owned<T: ?Sized + Send + Sync + 'static>(
        &self,
        point: &Point<T>,
    ) -> Vec<(Ctx, Arc<T>)> {
        crate::kernel_api::contributions(&self.state, point)
    }
    pub fn status(&self) -> Vec<PluginStatus> {
        crate::life::status(&self.state)
    }
    pub fn set_enabled(&self, plugin: &str, on: bool) -> BoxFuture<'static, Result<()>> {
        crate::life::set_enabled(self.state.clone(), plugin.to_owned(), on)
    }
    pub fn manifests(&self) -> Vec<Manifest> {
        crate::life::manifests(&self.state)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PluginStatus {
    pub id: String,
    pub version: String,
    /// 'active' | 'resolved' | 'off' | 'refused'
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub builtin: bool,
}
