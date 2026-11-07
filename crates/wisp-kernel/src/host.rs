//! The host: `App` (boot), `Setup` (what a plugin registers), `Ctx` (what a plugin uses at runtime).
//! The signatures here are the contract; the kernel agent owns the implementation behind them.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::caps::Caller;
use crate::http::Route;
use crate::manifest::Manifest;
use crate::{BoxFuture, Call, Clock, Command, Event, Hook, InterceptOpts, KernelService, Plugin, PluginGroup, Point, Result, Service, Verdict, WireError};

#[derive(Debug)]
pub(crate) struct CallInner {
    pub(crate) root: String,
    pub(crate) depth: u32,
    pub(crate) stack: Vec<String>,
    pub(crate) caller: Caller,
    pub(crate) cancel: CancellationToken,
    pub(crate) read_only: bool,
}

pub(crate) fn require(call: &CallInner, permission: &str) -> Result<()> {
    if crate::caps::allowed(&call.caller, permission) {
        Ok(())
    } else {
        Err(WireError::forbidden(format!("{} may not {permission}", call.caller.set)))
    }
}

type Erased = Arc<dyn Any + Send + Sync>;
pub(crate) type CmdFn = Arc<dyn Fn(Ctx, Call, Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub(crate) type HookFn = Arc<dyn Fn(Ctx, Call, Value) -> BoxFuture<'static, Verdict<Value>> + Send + Sync>;
pub(crate) type EventFn = Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, ()> + Send + Sync>;
pub(crate) type StartFn = Box<dyn FnOnce(Ctx) -> BoxFuture<'static, Result<()>> + Send>;

/// What a plugin registers in `setup`. Everything belongs to the plugin's scope.
pub struct Setup {
    pub(crate) plugin: String,
    pub(crate) ctx: Ctx,
    pub(crate) commands: Vec<(&'static str, Option<&'static str>, bool, CmdFn)>,
    pub(crate) hooks: Vec<(&'static str, InterceptOpts, HookFn)>,
    pub(crate) events: Vec<(&'static str, EventFn)>,
    pub(crate) points: Vec<(&'static str, u32, Erased)>,
    pub(crate) services: Vec<(&'static str, u32, Erased)>,
    pub(crate) starts: Vec<StartFn>,
}

impl std::fmt::Debug for Setup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Setup").field("plugin", &self.plugin).finish_non_exhaustive()
    }
}

impl Setup {
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
        let erased: CmdFn = Arc::new(move |ctx, call, args| {
            let f = f.clone();
            Box::pin(async move {
                let args: C::Args = serde_json::from_value(args).map_err(|e| WireError::invalid(format!("{}: {e}", C::ID)))?;
                let out = f(ctx, call, args).await?;
                serde_json::to_value(out).map_err(|e| WireError::internal(e.to_string()))
            })
        });
        self.commands.push((C::ID, C::PERMISSION, C::READ_ONLY, erased));
    }

    /// Takes part in hook `H`, ordered by `opts.priority`.
    pub fn intercept<H, F, Fut>(&mut self, opts: InterceptOpts, f: F)
    where
        H: Hook,
        F: Fn(Ctx, Call, H::Ctx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Verdict<H::Ctx>> + Send + 'static,
    {
        let f = Arc::new(f);
        let erased: HookFn = Arc::new(move |ctx, call, v| {
            let f = f.clone();
            Box::pin(async move {
                let Ok(hctx) = serde_json::from_value::<H::Ctx>(v) else {
                    return Verdict::Veto { code: "invalid".into(), message: format!("{}: bad context", H::ID), then: Vec::new() };
                };
                match f(ctx, call, hctx).await {
                    Verdict::Continue => Verdict::Continue,
                    Verdict::Modify { ctx } => match serde_json::to_value(ctx) {
                        Ok(ctx) => Verdict::Modify { ctx },
                        Err(e) => Verdict::Veto { code: "internal".into(), message: e.to_string(), then: Vec::new() },
                    },
                    Verdict::Veto { code, message, then } => Verdict::Veto { code, message, then },
                }
            })
        });
        self.hooks.push((H::ID, opts, erased));
    }

    /// Subscribes to `E`, delivered after commit, in order, at least once (dedupe by seq).
    pub fn on<E, F, Fut>(&mut self, f: F)
    where
        E: Event,
        F: Fn(Ctx, E) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let f = Arc::new(f);
        let erased: EventFn = Arc::new(move |ctx, v| {
            let f = f.clone();
            Box::pin(async move {
                if let Ok(e) = serde_json::from_value::<E>(v) {
                    f(ctx, e).await;
                }
            })
        });
        self.events.push((E::TYPE, erased));
    }

    /// Adds an implementation to a list point owned by some plugin.
    pub fn contribute<T: ?Sized + Send + Sync + 'static>(&mut self, point: &Point<T>, item: Arc<T>) {
        self.points.push((point.id, point.version, Arc::new(item)));
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
    pub(crate) scope: CancellationToken,
    pub(crate) kernel: Arc<crate::host::KernelState>,
}

impl std::fmt::Debug for Ctx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ctx").field("plugin", &self.inner.plugin).finish_non_exhaustive()
    }
}

#[derive(Default)]
pub(crate) struct KernelState {
    pub(crate) services: std::sync::RwLock<HashMap<TypeId, Erased>>,
}

impl Ctx {
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
        let map = self.inner.kernel.services.read().map_err(|_| WireError::internal("services lock"))?;
        map.get(&TypeId::of::<T>()).and_then(|v| v.clone().downcast::<T>().ok()).ok_or_else(|| WireError::new(crate::Code::ServiceGone, std::any::type_name::<T>()))
    }

    pub fn clock(&self) -> Result<Arc<dyn Clock>> {
        self.service::<Arc<dyn Clock>>().map(|c| (*c).clone())
    }

    /// Runs command `C` as part of `call` (depth + 1, same trace and caller).
    pub fn run<C: Command>(&self, call: &Call, args: C::Args) -> BoxFuture<'static, Result<C::Out>> {
        crate::host::dispatch::<C>(self.clone(), call.clone(), args)
    }

    /// Runs hook `H`'s interceptors in order. Ok: the (possibly modified) context. Err(vetoed): refused.
    pub fn run_hook<H: Hook>(&self, call: &Call, hctx: H::Ctx) -> BoxFuture<'static, Result<H::Ctx>> {
        crate::host::run_hook::<H>(self.clone(), call.clone(), hctx)
    }

    /// Records `e`; it is published after the call that emitted it commits.
    pub fn emit<E: Event>(&self, call: &Call, e: &E) {
        crate::host::emit(self, call, E::TYPE, serde_json::to_value(e).unwrap_or(Value::Null));
    }

    pub fn contributions<T: ?Sized + Send + Sync + 'static>(&self, point: &Point<T>) -> Vec<Arc<T>> {
        crate::host::contributions(self, point)
    }

    /// The provider of `S`, or `service_gone`. Required services are checked when the set resolves.
    pub fn use_service<S: Service>(&self) -> Result<Arc<S::Api>> {
        crate::host::use_service::<S>(self)
    }

    /// A root call made by this plugin itself (a timer, a subscriber), speaking as `plugin:<id>`.
    pub fn root_call(&self) -> Call {
        Call {
            inner: Arc::new(CallInner {
                root: crate::ids::uuid7(),
                depth: 0,
                stack: Vec::new(),
                caller: Caller { set: format!("plugin:{}", self.inner.plugin), session: None, plugin: Some(self.inner.plugin.clone()) },
                cancel: self.inner.scope.child_token(),
                read_only: false,
            }),
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
        f.debug_struct("App").field("group", &self.group).finish_non_exhaustive()
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        Self { state: Arc::new(KernelState::default()), group: PluginGroup::new() }
    }

    /// Provides (or overrides) a kernel service.
    #[must_use]
    pub fn service<T: KernelService>(self, value: T) -> Self {
        if let Ok(mut map) = self.state.services.write() {
            map.insert(TypeId::of::<T>(), Arc::new(value));
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
        crate::host::start(self).await
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
    pub fn call(&self, caller: Caller, cmd: &str, args: Value) -> BoxFuture<'static, Result<Value>> {
        crate::host::call_json(self.clone(), caller, cmd.to_owned(), args)
    }
    /// Every contribution to `point`, across plugins that are on.
    pub fn contributions<T: ?Sized + Send + Sync + 'static>(&self, point: &Point<T>) -> Vec<Arc<T>> {
        crate::host::kernel_contributions(self, point)
    }
    pub fn status(&self) -> Vec<PluginStatus> {
        crate::host::status(self)
    }
    pub fn set_enabled(&self, plugin: &str, on: bool) -> BoxFuture<'static, Result<()>> {
        crate::host::set_enabled(self.clone(), plugin.to_owned(), on)
    }
    pub fn manifests(&self) -> Vec<Manifest> {
        crate::host::manifests(self)
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

// ---- implementation seams: the kernel agent replaces these bodies (signatures stay) ----

pub(crate) fn dispatch<C: Command>(_ctx: Ctx, _call: Call, _args: C::Args) -> BoxFuture<'static, Result<C::Out>> {
    Box::pin(async { Err(WireError::unavailable(format!("{}: kernel dispatch not built yet", C::ID))) })
}
pub(crate) fn run_hook<H: Hook>(_ctx: Ctx, _call: Call, hctx: H::Ctx) -> BoxFuture<'static, Result<H::Ctx>> {
    Box::pin(async move { Ok(hctx) })
}
pub(crate) fn emit(_ctx: &Ctx, _call: &Call, _ty: &'static str, _v: Value) {}
pub(crate) fn contributions<T: ?Sized + Send + Sync + 'static>(_ctx: &Ctx, _p: &Point<T>) -> Vec<Arc<T>> {
    Vec::new()
}
pub(crate) fn use_service<S: Service>(_ctx: &Ctx) -> Result<Arc<S::Api>> {
    Err(WireError::new(crate::Code::ServiceGone, S::ID))
}
pub(crate) async fn start(app: App) -> Result<Kernel> {
    let _ = Setup::ctx;
    let _ = (&app.group, Plugin::manifest as fn(&dyn Plugin) -> Manifest);
    Ok(Kernel { state: app.state })
}
pub(crate) fn call_json(_k: Kernel, _caller: Caller, cmd: String, _args: Value) -> BoxFuture<'static, Result<Value>> {
    Box::pin(async move { Err(WireError::unavailable(format!("{cmd}: kernel dispatch not built yet"))) })
}
pub(crate) fn kernel_contributions<T: ?Sized + Send + Sync + 'static>(_k: &Kernel, _p: &Point<T>) -> Vec<Arc<T>> {
    Vec::new()
}
pub(crate) fn status(_k: &Kernel) -> Vec<PluginStatus> {
    Vec::new()
}
pub(crate) fn set_enabled(_k: Kernel, _plugin: String, _on: bool) -> BoxFuture<'static, Result<()>> {
    Box::pin(async { Ok(()) })
}
pub(crate) fn manifests(_k: &Kernel) -> Vec<Manifest> {
    Vec::new()
}
