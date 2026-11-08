//! The rest of the public API (all additive to the v2.0 contract in host.rs): what the edge, the store,
//! Settings → Plugins / Diagnostics and the testkit need from a running kernel, and a plugin's extras
//! (settings, raw subscriptions).
use std::sync::Arc;

use serde_json::Value;

use crate::call::CallInner;
use crate::caps::{Caller, CapabilitySet};
use crate::diag::FailureRecord;
use crate::events::{EventEnvelope, SubFn};
use crate::host::{Ctx, Kernel, Setup};
use crate::manifest::Manifest;
use crate::reg::service_key;
use crate::settings::{SettingInfo, SettingsBackend};
use crate::state::KernelState;
use crate::{BoxFuture, Call, Code, Plugin, Point, Result, Service, WireError};

pub(crate) fn contributions<T: ?Sized + Send + Sync + 'static>(
    k: &KernelState,
    p: &Point<T>,
) -> Vec<(Ctx, Arc<T>)> {
    let Ok(reg) = k.reg.read() else {
        return Vec::new();
    };
    let Some(list) = reg.points.get(p.id) else {
        return Vec::new();
    };
    let owners: Vec<(Arc<str>, Ctx)> = k
        .lock_plugins()
        .map(|ps| {
            ps.slots
                .iter()
                .filter_map(|s| s.ctx.clone().map(|c| (c.inner.id.clone(), c)))
                .collect()
        })
        .unwrap_or_default();
    list.iter()
        .filter(|e| e.version == p.version)
        .filter_map(|e| {
            let item = e.item.clone().downcast::<Arc<T>>().ok()?;
            let ctx = owners.iter().find(|(o, _)| *o == e.owner)?.1.clone();
            Some((ctx, (*item).clone()))
        })
        .collect()
}

pub(crate) fn use_service<S: Service>(k: &KernelState) -> Result<Arc<S::Api>> {
    let reg = k.read_reg()?;
    let gone = || {
        WireError::new(
            Code::ServiceGone,
            format!("{}@{}: no plugin that is on provides it", S::ID, S::MAJOR),
        )
    };
    let list = reg
        .services
        .get(&service_key(S::ID, S::MAJOR))
        .ok_or_else(gone)?;
    let chosen = reg.chosen.get(S::ID);
    let e = chosen
        .and_then(|c| list.iter().find(|p| *p.owner == **c))
        .or_else(|| list.first())
        .ok_or_else(gone)?;
    let item = e
        .item
        .clone()
        .downcast::<Arc<S::Api>>()
        .map_err(|_| WireError::internal(format!("{}: provided with another type", S::ID)))?;
    Ok((*item).clone())
}

/// A plugin that is only its manifest (a converted v1 spell, a theme): nothing runs, the host applies
/// its contributions and setting locks.
#[derive(Debug, Clone)]
pub struct Declarative(pub Manifest);

impl Plugin for Declarative {
    fn manifest(&self) -> Manifest {
        self.0.clone()
    }
    fn setup(&self, _s: &mut Setup) -> Result<()> {
        Ok(())
    }
}

/// How the store publishes a command's events when its transaction commits (plan §6.11.2 rule 6).
/// Without it, events go out when the root command returns Ok. With it: `mark` before BEGIN,
/// `committed` after COMMIT (events up to now go out, with the change cursor), `rolled_back` after a
/// ROLLBACK (events since the mark are dropped). See README.md.
#[derive(Debug, Clone)]
pub struct CommitHook {
    k: std::sync::Weak<KernelState>,
}

impl CommitHook {
    pub(crate) fn of(k: &Arc<KernelState>) -> Self {
        Self {
            k: Arc::downgrade(k),
        }
    }
    /// How many events the call's root command has buffered so far.
    pub fn mark(&self, call: &Call) -> usize {
        call.inner
            .tx
            .as_ref()
            .and_then(|tx| tx.events.lock().ok().map(|e| e.len()))
            .unwrap_or(0)
    }
    /// The transaction committed: publish what the root buffered (all of it: what was emitted before
    /// was committed by an earlier transaction or needs none).
    pub fn committed(&self, call: &Call, cursor: Option<u64>) {
        if let (Some(k), Some(tx)) = (self.k.upgrade(), &call.inner.tx) {
            crate::dispatch::flush(&k, &call.inner.root, tx, cursor, 0);
        }
    }
    /// The transaction rolled back: events emitted since `mark` never happened.
    pub fn rolled_back(&self, call: &Call, mark: usize) {
        if let Some(tx) = &call.inner.tx
            && let Ok(mut e) = tx.events.lock()
        {
            e.truncate(mark);
        }
    }
}

/// A route with the plugin that serves it.
#[derive(Debug, Clone)]
pub struct RouteEntry {
    pub plugin: String,
    pub ctx: Ctx,
    pub route: Arc<crate::http::Route>,
}

impl Kernel {
    /// Waits until every queued event is delivered and every follow-up has run.
    pub fn idle(&self) -> BoxFuture<'static, ()> {
        let w = self.state.work.clone();
        Box::pin(async move { w.idle().await })
    }
    /// A root call speaking for `caller` (depth 0, new trace), for the edge and tests.
    pub fn root_call(&self, caller: Caller) -> Call {
        CallInner::detached(&self.state, caller, None, self.state.root.child_token()).into_call()
    }
    pub fn commit_hook(&self) -> CommitHook {
        CommitHook {
            k: Arc::downgrade(&self.state),
        }
    }
    /// Activates every lazy plugin waiting on `event` (`onTopic:session:abc`, `onView:shell.task`,
    /// `onBlock:chart`, `onSchedule:nightly`, `onCommand:x.y`). Returns how many woke.
    pub fn wake(&self, event: &str, args: Option<Value>) -> BoxFuture<'static, usize> {
        let (k, event) = (self.state.clone(), event.to_owned());
        Box::pin(async move {
            let (kind, name) = event.split_once(':').unwrap_or((event.as_str(), ""));
            crate::life::wake(&k, kind, name, args.as_ref()).await
        })
    }
    /// Picks which plugin provides `contract` when several do (Settings → Plugins).
    pub fn choose_provider(&self, contract: &str, plugin: &str) -> BoxFuture<'static, Result<()>> {
        let (k, c, p) = (self.state.clone(), contract.to_owned(), plugin.to_owned());
        Box::pin(async move {
            k.lock_plugins()?.choices.insert(c, p);
            crate::life::reconcile(&k).await;
            Ok(())
        })
    }
    /// The contract → provider choice resolution made.
    pub fn providers(&self) -> Vec<(String, String)> {
        self.state
            .lock_plugins()
            .map(|ps| {
                ps.res
                    .providers
                    .iter()
                    .map(|(a, b)| (a.clone(), b.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
    /// Adds or replaces a capability set (a crew member's, a pane's allowed list).
    pub fn define_set(&self, set: &CapabilitySet) {
        self.state.caps.define(set);
    }
    /// Allowed, or the message the caller would read.
    pub fn explain(&self, caller: &Caller, permission: &str) -> std::result::Result<(), String> {
        crate::caps::explain_in(&self.state.caps, caller, permission)
    }
    /// Static contributions to a point from every plugin that is on or resolved (live before code
    /// loads), plus JSON contributions made over RPC.
    pub fn declared(&self, point: &str) -> Vec<(String, Value)> {
        let mut out: Vec<(String, Value)> = self
            .state
            .lock_plugins()
            .map(|ps| {
                ps.slots
                    .iter()
                    .filter(|s| {
                        !matches!(
                            s.phase,
                            crate::life::Phase::Off | crate::life::Phase::Refused
                        )
                    })
                    .flat_map(|s| {
                        s.manifest
                            .contributions(point)
                            .into_iter()
                            .map(|v| (s.manifest.id.clone(), v))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(reg) = self.state.reg.read() {
            out.extend(
                reg.points
                    .get(point)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.json.clone().map(|j| (e.owner.to_string(), j))),
            );
        }
        out
    }
    pub fn settings(&self) -> Vec<SettingInfo> {
        self.state.settings.list()
    }
    pub fn setting(&self, key: &str) -> Option<Value> {
        self.state.settings.get(key)
    }
    pub fn setting_info(&self, key: &str) -> Option<SettingInfo> {
        self.state.settings.info(key)
    }
    /// The user's write; `None` resets to the default. Refused when another plugin locked it.
    pub fn set_setting(&self, key: &str, value: Option<Value>) -> Result<()> {
        let b = self.state.service::<Arc<dyn SettingsBackend>>();
        self.state
            .settings
            .set(key, value, b.as_deref().map(|b| &**b))
    }
    /// The last failures of a plugin (Settings → Diagnostics).
    pub fn failures(&self, plugin: &str) -> Vec<FailureRecord> {
        self.state.diag.failures(plugin)
    }
    /// The calls the kernel refused, with their traces.
    pub fn refusals(&self) -> Vec<FailureRecord> {
        self.state.diag.refusals()
    }
    /// Since which seq a plugin's queue overflowed, if it is lagging.
    pub fn lagging(&self, plugin: &str) -> Option<u64> {
        self.state.bus.lagging(plugin)
    }
    /// The plugin caught up from the change feed: deliver to it again.
    pub fn caught_up(&self, plugin: &str) {
        self.state.bus.caught_up(plugin);
    }
    /// What a plugin has registered right now: commands, interceptors, contributions, services,
    /// subscriptions, setting watchers. Zero once it is off (the testkit's leak check).
    pub fn registrations(&self, plugin: &str) -> usize {
        self.state.reg.read().map_or(0, |r| r.count_owner(plugin))
            + self.state.bus.subscriptions(plugin)
            + self.state.settings.watchers_of(plugin)
    }
    /// The context of a plugin that is on (tests, the exec bridge).
    pub fn ctx(&self, plugin: &str) -> Option<Ctx> {
        self.state
            .lock_plugins()
            .ok()?
            .slots
            .iter()
            .find(|s| s.manifest.id == plugin)?
            .ctx
            .clone()
    }
    /// Test knobs (plan §6.11.2 rule 8): shuffle interceptors of equal priority with `seed`, and delay
    /// (plugin, hook) by some milliseconds.
    #[doc(hidden)]
    pub fn chaos(&self, seed: Option<u64>, delays: Vec<(String, String, u64)>) {
        if let Ok(mut c) = self.state.chaos.write() {
            *c = crate::state::Chaos { seed, delays };
        }
    }
    /// Every route of every plugin that is on.
    pub fn routes(&self) -> Vec<RouteEntry> {
        self.contributions_owned(&crate::http::ROUTES)
            .into_iter()
            .map(|(ctx, route)| RouteEntry {
                plugin: ctx.plugin().to_owned(),
                ctx,
                route,
            })
            .collect()
    }
    /// Serves one HTTP request: matches a route (activating a lazy plugin by `onRoute` first),
    /// checks the caller's permission, runs the handler in a new root call.
    pub fn serve(
        &self,
        caller: Caller,
        req: crate::http::Request,
    ) -> BoxFuture<'static, Result<crate::http::Response>> {
        crate::routes::serve(self.clone(), caller, req)
    }
}

impl Ctx {
    /// A setting's value: a lock first, then the user's value, then the default.
    pub fn setting(&self, key: &str) -> Option<Value> {
        self.k().ok()?.settings.get(key)
    }
    /// Every declared setting with its value and lock (Settings). Needs `settings:read` in the plugin's
    /// manifest. Additive (2026-11-08).
    pub fn settings_list(&self) -> Result<Vec<SettingInfo>> {
        if !self.may("settings:read") {
            return Err(WireError::forbidden(format!("{} doesn't declare settings:read", self.plugin())));
        }
        Ok(self.k()?.settings.list())
    }
    /// The user's write of a setting; `None` resets it. Needs `settings:write`. Validated against the
    /// declaration, refused when another plugin locked it. Additive (2026-11-08).
    pub fn set_setting(&self, key: &str, value: Option<Value>) -> Result<()> {
        if !self.may("settings:write") {
            return Err(WireError::forbidden(format!("{} doesn't declare settings:write", self.plugin())));
        }
        let k = self.k()?;
        let b = k.service::<Arc<dyn SettingsBackend>>();
        k.settings.set(key, value, b.as_deref().map(|b| &**b))
    }
    /// Calls `f` with the new value whenever `key` changes. Dropped when this plugin goes off.
    pub fn watch_setting(&self, key: &str, f: impl Fn(Option<Value>) + Send + Sync + 'static) {
        if let Ok(k) = self.k() {
            k.settings.watch(self.plugin(), key, Arc::new(f));
        }
    }
    /// The plugin's own capability set allows `permission`? (its manifest's permissions)
    pub fn may(&self, permission: &str) -> bool {
        crate::perm::parse(permission).is_some_and(|p| {
            self.inner
                .set
                .as_ref()
                .is_some_and(|s| s.explain(&p).is_ok())
        })
    }
}

impl Setup {
    /// Subscribes to every event whose type matches `pattern` (`x.*`, `*`), with its envelope (seq,
    /// root, cursor). For dedupe, the sync layer and exec plugins.
    pub fn on_raw<F, Fut>(&mut self, pattern: &str, f: F)
    where
        F: Fn(Ctx, Arc<EventEnvelope>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send + 'static,
    {
        let f = Arc::new(f);
        let sub: SubFn = Arc::new(move |ctx, env| Box::pin(f(ctx, env)));
        self.events.push((pattern.to_owned(), sub));
    }

    /// The plugin's manifest id.
    pub fn plugin(&self) -> &str {
        &self.plugin
    }
}
