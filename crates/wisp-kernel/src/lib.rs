//! wisp-kernel: the plugin host (ADR-0003, ADR-0013, plan §6). It knows no feature. Plugins register
//! commands, interceptors, event subscribers, list-point contributions, services and HTTP routes during
//! `setup`, and everything they register belongs to their `Scope`: switching a plugin off is dropping it.
//!
//! The public API in this file is the contract every plugin crate builds against. Its signatures are
//! frozen: a change goes through the `change-a-contract` skill (monoflow graph impact first).
//!
//! Rule of thumb (plan §6.11): an action is a command, a fact is an event, a no is an interceptor, an
//! implementation is a list point, watching data is a topic, a handle is a service.

pub mod caps;
pub mod error;
pub mod http;
pub mod ids;
pub mod manifest;
pub mod scope;
pub mod services;

pub mod activation;
pub mod exec;
pub mod perm;
pub mod resolve;
pub mod semver;
pub mod spell;

mod activate;
mod call;
mod diag;
mod dispatch;
mod events;
mod hooks;
mod host;
mod kernel_api;
mod life;
mod manifest_check;
mod manifest_contrib;
mod reg;
mod routes;
mod settings;
mod state;

use std::any::Any;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub use call::MAX_DEPTH;
pub use caps::{Caller, CapabilitySet};
pub use diag::FailureRecord;
pub use error::{Code, Result, WireError};
pub use events::{EventEnvelope, QUEUE_CAP};
pub use exec::{ExecOptions, ExecPlugin, ExecSpawner};
pub use host::{App, Ctx, Kernel, PluginStatus, Setup};
pub use kernel_api::{CommitHook, Declarative, RouteEntry};
pub use manifest::{Manifest, ManifestError, SettingDecl};
pub use settings::{SettingInfo, SettingsBackend};
pub use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ---------- contracts declared in `api` crates ----------

/// A command: an action another plugin, a client or an agent asks for. Its id is also its permission
/// (`runtime.create` → `runtime:create`) unless `PERMISSION` says otherwise.
pub trait Command: 'static {
    const ID: &'static str;
    const PERMISSION: Option<&'static str> = None;
    /// true: a read, allowed inside an interceptor (interceptors never write, plan §6.11.2 rule 4)
    const READ_ONLY: bool = false;
    /// The arg keys that name a task: an agent caller may only name its own task or one under it
    /// (`scope`, v1 edge case HTTP #3). Additive (2026-11-08).
    const TASK_ARGS: &'static [&'static str] = scope::DEFAULT_TASK_ARGS;
    /// It answers about every task (a list, a search): refused to an agent caller.
    const ALL_TASKS: bool = false;
    /// A read an `agent:session` token may make about any task (`wisp_sessions` / `wisp_session`); a
    /// capped agent (`agent:capped`) stays scoped. Only for read-only commands. Additive (2026-11-08).
    const READS_ANY_TASK: bool = false;
    type Args: Serialize + DeserializeOwned + Send + 'static;
    type Out: Serialize + DeserializeOwned + Send + 'static;
}

/// A fact, published after the command that caused it commits, in order, per subscriber queue.
pub trait Event: Serialize + DeserializeOwned + Clone + Send + Sync + 'static {
    const TYPE: &'static str;
}

/// An interceptor hook (`before:run`): ordered, can continue, modify or veto.
pub trait Hook: 'static {
    const ID: &'static str;
    type Ctx: Serialize + DeserializeOwned + Clone + Send + Sync + 'static;
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict<C> {
    Continue,
    Modify {
        ctx: C,
    },
    /// `then`: follow-up commands the kernel runs after, as new root calls
    Veto {
        code: String,
        message: String,
        then: Vec<FollowUp>,
    },
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct FollowUp {
    pub cmd: String,
    pub args: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// a timeout or error skips this interceptor with a warning
    Open,
    /// a guard: a timeout or error vetoes (capped mode, budget)
    Closed,
}

#[derive(Debug, Clone, Copy)]
pub struct InterceptOpts {
    /// lower runs first
    pub priority: i32,
    pub failure: Failure,
    /// 200 ms by default, at most 2000 (plan §6.11.2 rule 5)
    pub timeout_ms: u64,
}

impl Default for InterceptOpts {
    fn default() -> Self {
        Self {
            priority: 0,
            failure: Failure::Open,
            timeout_ms: 200,
        }
    }
}

/// A typed list extension point owned by a plugin (`runtime.harness@1`): contributors add `Arc<T>`.
#[derive(Debug)]
pub struct Point<T: ?Sized + Send + Sync + 'static> {
    pub id: &'static str,
    pub version: u32,
    _t: std::marker::PhantomData<fn() -> Arc<T>>,
}

impl<T: ?Sized + Send + Sync + 'static> Point<T> {
    pub const fn new(id: &'static str, version: u32) -> Self {
        Self {
            id,
            version,
            _t: std::marker::PhantomData,
        }
    }
}

/// A typed, long-lived handle another plugin may provide (plan §6.11.1), requested by contract id,
/// never by provider. Every method of `Api` takes `&Call` first and must start with
/// `call.require(<permission>)?`; `wisp-testkit` checks that each method refuses without it.
pub trait Service: 'static {
    const ID: &'static str;
    const MAJOR: u32;
    type Api: ?Sized + Send + Sync + 'static;
}

// ---------- a call in flight ----------

/// Every call carries a trace (depth ≤ 8, no re-entering a (plugin, hook) pair), the caller's
/// capability set, a cancellation token, and the events it emitted (published after it commits).
#[derive(Debug, Clone)]
pub struct Call {
    pub(crate) inner: Arc<call::CallInner>,
}

impl Call {
    pub fn caller(&self) -> &Caller {
        &self.inner.caller
    }
    pub fn depth(&self) -> u32 {
        self.inner.depth
    }
    pub fn root(&self) -> &str {
        &self.inner.root
    }
    pub fn cancelled(&self) -> &CancellationToken {
        &self.inner.cancel
    }
    /// fails with `forbidden` unless the caller's capability set holds `permission`
    pub fn require(&self, permission: &str) -> Result<()> {
        call::require(&self.inner, permission)
    }
    /// true inside an interceptor: writes are refused
    pub fn read_only(&self) -> bool {
        self.inner.read_only
    }
    /// A new root call (depth 0, fresh trace) speaking for `caller`: how the edge, MCP and tests start one.
    /// Additive (wisp-git agent, 2026-11-08): service providers need it to test their permission checks.
    pub fn new_root(caller: Caller) -> Self {
        // outside a kernel: the built-in sets (capabilities.json); a plugin set holds its own namespace only
        let set = caps::builtin(&caller.set);
        Self {
            inner: Arc::new(call::CallInner {
                root: ids::uuid7(),
                depth: 0,
                stack: Vec::new(),
                caller,
                cancel: CancellationToken::new(),
                read_only: false,
                set,
                via: None,
                via_set: None,
                kernel: std::sync::Weak::new(),
                tx: None,
            }),
        }
    }
}

/// Kernel services (store, proc, net, secrets, paths, notify, clock) are typed values an install
/// provides at boot and may override (the grid swaps `proc`, tests swap `clock`).
pub trait KernelService: Any + Send + Sync + 'static {}
impl<T: Any + Send + Sync + 'static> KernelService for T {}

/// Wall clock and monotonic time, injected so tests and the simulation control time.
pub trait Clock: Send + Sync + 'static {
    /// milliseconds since the Unix epoch
    fn now_ms(&self) -> i64;
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()>;
}

/// What a plugin crate exports. `manifest` is the parsed `wisp-plugin.json` next to its Cargo.toml
/// (`Manifest::embedded(include_str!("../wisp-plugin.json"))`).
pub trait Plugin: Send + Sync + 'static {
    fn manifest(&self) -> Manifest;
    fn setup(&self, s: &mut Setup) -> Result<()>;
}

/// A product is a list of plugins (Bevy-style): `DefaultPlugins.build().disable("wisp.telemetry")`.
#[derive(Default)]
pub struct PluginGroup {
    pub(crate) plugins: Vec<Arc<dyn Plugin>>,
    pub(crate) disabled: Vec<String>,
}

impl std::fmt::Debug for PluginGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginGroup")
            .field("plugins", &self.plugins.len())
            .field("disabled", &self.disabled)
            .finish()
    }
}

impl PluginGroup {
    pub fn new() -> Self {
        Self::default()
    }
    #[must_use]
    #[allow(clippy::should_implement_trait)] // Bevy's name, frozen in the contract
    pub fn add(mut self, p: impl Plugin) -> Self {
        self.plugins.push(Arc::new(p));
        self
    }
    /// a disabled plugin keeps its slot; dependents are refused with a reason
    #[must_use]
    pub fn disable(mut self, id: &str) -> Self {
        self.disabled.push(id.to_owned());
        self
    }
    #[must_use]
    pub fn extend(mut self, other: PluginGroup) -> Self {
        self.plugins.extend(other.plugins);
        self.disabled.extend(other.disabled);
        self
    }
}
