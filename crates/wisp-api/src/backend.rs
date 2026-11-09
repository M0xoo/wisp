//! What the edge serves: the kernel's routes, status parts, commands and capability checks. A trait so
//! the edge's tests (and a peer's sandbox) can stand in for a whole kernel; `Kernel` is the real one.
//! The edge matches routes itself (bucketed, before reading a body: the route decides the body cap,
//! whether it is open, and which session the URL names), then runs the handler in a root call the
//! kernel makes. A miss wakes plugins waiting on `onRoute` once and looks again.
use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::http::{STATUS, StatusPart};
use wisp_kernel::{BoxFuture, Caller, Kernel, Result};

use crate::router::{Invoke, Spec};

/// A route and its handler, its owner's context already bound.
#[derive(Clone)]
pub struct Binding {
    pub spec: Spec,
    pub invoke: Invoke,
}

impl std::fmt::Debug for Binding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Binding")
            .field("spec", &self.spec)
            .finish_non_exhaustive()
    }
}

pub trait Backend: Send + Sync + 'static {
    /// every `kernel.http` route of the plugins that are on, in the order they were added
    fn routes(&self) -> Vec<Binding>;
    fn status_parts(&self) -> Vec<Arc<dyn StatusPart>>;
    fn call(&self, caller: Caller, cmd: &str, args: Value) -> BoxFuture<'static, Result<Value>>;
    /// Ok, or the reason the caller's capability set doesn't hold `permission`
    fn explain(&self, caller: &Caller, permission: &str) -> std::result::Result<(), String>;
    /// the set a session's agent speaks with (`agent:capped` for a capped task); None: `agent:session`
    fn agent_set(&self, _session: &str) -> Option<String> {
        None
    }
    /// Wakes lazy plugins whose `onRoute` names this request; true if any woke (the table reloads).
    fn wake_route(&self, _method: &str, _path: &str) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    /// the user capability set an API key (`x-wisp-key`) speaks with; None: not a key
    fn key_set(&self, _key: &str) -> Option<String> {
        None
    }
}

impl Backend for Kernel {
    fn routes(&self) -> Vec<Binding> {
        Kernel::routes(self)
            .into_iter()
            .map(|e| {
                let spec = Spec::of(&e.route, &e.plugin);
                let (k, ctx, route) = (self.clone(), e.ctx, e.route);
                let invoke: Invoke = Arc::new(move |caller, req| {
                    // an agent's token speaks for its own task only (wisp_kernel::scope)
                    let scope = k.route_scope(&caller, route.pattern, &req.params);
                    let run = (route.handler)(ctx.clone(), k.root_call(caller), req);
                    Box::pin(async move {
                        scope.await?;
                        run.await
                    })
                });
                Binding { spec, invoke }
            })
            .collect()
    }

    fn status_parts(&self) -> Vec<Arc<dyn StatusPart>> {
        self.contributions(&STATUS)
    }

    fn call(&self, caller: Caller, cmd: &str, args: Value) -> BoxFuture<'static, Result<Value>> {
        Kernel::call(self, caller, cmd, args)
    }

    fn explain(&self, caller: &Caller, permission: &str) -> std::result::Result<(), String> {
        Kernel::explain(self, caller, permission)
    }

    fn wake_route(&self, method: &str, path: &str) -> BoxFuture<'static, bool> {
        let fut = self.wake(
            &format!("onRoute:{} {path}", method.to_ascii_uppercase()),
            None,
        );
        Box::pin(async move { fut.await > 0 })
    }

    fn key_set(&self, key: &str) -> Option<String> {
        Kernel::key_set(self, key)
    }
}
