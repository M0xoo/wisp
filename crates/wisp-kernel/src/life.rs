//! Lifecycle (plan §6.4): `discovered → resolved → (activated) → off`. The plugin table, resolution
//! applied to it (`reconcile`: what must go off goes off, what can run and is eager starts), status,
//! lazy activation by activation events, and the exec tier's crash-restart with backoff.
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::host::{App, Ctx, Kernel, PluginStatus};
use crate::manifest::Manifest;
use crate::resolve::{Input, Resolution, resolve};
use crate::settings::SettingsBackend;
use crate::state::KernelState;
use crate::{BoxFuture, Plugin, Result, WireError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Resolved,
    Starting,
    Active,
    Off,
    Refused,
}

pub(crate) struct Slot {
    pub(crate) manifest: Manifest,
    pub(crate) plugin: Arc<dyn Plugin>,
    pub(crate) builtin: bool,
    pub(crate) phase: Phase,
    pub(crate) reason: Option<String>,
    pub(crate) scope: Option<CancellationToken>,
    pub(crate) ctx: Option<Ctx>,
    pub(crate) ready: Arc<Notify>,
    pub(crate) crashes: u32,
    pub(crate) scheduled: bool,
}

#[derive(Default)]
pub(crate) struct Plugins {
    pub(crate) slots: Vec<Slot>,
    /// switched off by the user, the group, or the kernel after a crash: id → reason
    pub(crate) off: HashMap<String, String>,
    /// setup or `on_start` failed, or the manifest is invalid: stays refused until switched on again
    pub(crate) failed: HashMap<String, String>,
    pub(crate) choices: HashMap<String, String>,
    pub(crate) res: Resolution,
    /// a second plugin with an id already taken: shown in status, never run
    pub(crate) dupes: Vec<PluginStatus>,
}

impl Plugins {
    pub(crate) fn slot(&mut self, id: &str) -> Option<&mut Slot> {
        self.slots.iter_mut().find(|s| s.manifest.id == id)
    }
    pub(crate) fn phase(&self, id: &str) -> Option<Phase> {
        self.slots
            .iter()
            .find(|s| s.manifest.id == id)
            .map(|s| s.phase)
    }
}

/// Built in: not an exec child, not a user's declarative or untrusted plugin. Anything else is an
/// override and wins a service contract over built-ins (plan §6.0.3).
fn builtin(m: &Manifest) -> bool {
    m.trust.as_deref().is_none_or(|t| t == "trusted")
        && m.exec().is_none()
        && !m.id.starts_with("user.")
}

pub(crate) async fn start(app: App) -> Result<Kernel> {
    let k = app.state;
    let backend = k.service::<Arc<dyn SettingsBackend>>();
    k.settings.load(backend.as_deref().map(|b| &**b));
    {
        let mut ps = k.lock_plugins()?;
        for p in app.group.plugins {
            let m = p.manifest();
            if let Some(first) = ps.slots.iter().find(|s| s.manifest.id == m.id) {
                let reason = format!(
                    "{} is registered twice: {} is used, {} is not",
                    m.id, first.manifest.version, m.version
                );
                ps.dupes.push(PluginStatus {
                    id: m.id.clone(),
                    version: m.version.clone(),
                    state: "refused".into(),
                    reason: Some(reason),
                    builtin: builtin(&m),
                });
                continue;
            }
            if let Err(e) = m.validate() {
                ps.failed
                    .insert(m.id.clone(), format!("invalid manifest: {}", e.message));
            }
            k.caps
                .define(&crate::caps::plugin_set(&m.id, &m.permissions));
            let b = builtin(&m);
            ps.slots.push(Slot {
                manifest: m,
                plugin: p,
                builtin: b,
                phase: Phase::Resolved,
                reason: None,
                scope: None,
                ctx: None,
                ready: Arc::new(Notify::new()),
                crashes: 0,
                scheduled: false,
            });
        }
        for d in app.group.disabled {
            ps.off.insert(
                d.clone(),
                format!("{d} is off (disabled in the plugin group)"),
            );
        }
    }
    reconcile(&k).await;
    Ok(Kernel { state: k })
}

fn compute(ps: &Plugins) -> Resolution {
    let mut off: HashMap<String, String> = ps.off.clone();
    off.extend(ps.failed.iter().map(|(k, v)| (k.clone(), v.clone())));
    // a plugin's manifest may switch others off (`disable`), while it is itself not off
    let by: Vec<(String, String)> = ps
        .slots
        .iter()
        .filter(|s| !off.contains_key(&s.manifest.id))
        .flat_map(|s| {
            s.manifest
                .disable
                .iter()
                .filter(|d| **d != s.manifest.id && ps.slots.iter().any(|x| &x.manifest.id == *d))
                .map(|d| (d.clone(), s.manifest.id.clone()))
        })
        .collect();
    for (d, who) in by {
        off.entry(d.clone())
            .or_insert_with(|| format!("{d} is off (disabled by {who})"));
    }
    let input = Input {
        manifests: ps.slots.iter().map(|s| &s.manifest).collect(),
        off,
        choices: ps.choices.clone(),
        overrides: ps
            .slots
            .iter()
            .filter(|s| !s.builtin)
            .map(|s| s.manifest.id.clone())
            .collect(),
    };
    resolve(&input)
}

/// Applies a fresh resolution: plugins that can no longer run go off, plugins that can run again are
/// resolved, eager ones (and what they depend on) start. Settings and schedules follow.
pub(crate) fn reconcile(k: &Arc<KernelState>) -> BoxFuture<'static, ()> {
    let k = k.clone();
    Box::pin(async move {
        let Some((stop, start)) = plan(&k) else {
            return;
        };
        for (id, why, to) in stop {
            crate::activate::deactivate(&k, &id, why, to);
        }
        sync_settings(&k);
        arm_schedules(&k);
        crate::activate::batch(&k, start).await;
    })
}

type Stop = Vec<(String, String, Phase)>;

/// The synchronous half of `reconcile`: new phases, and what to stop and start.
fn plan(k: &KernelState) -> Option<(Stop, Vec<String>)> {
    let mut ps = k.lock_plugins().ok()?;
    let res = compute(&ps);
    let mut stop: Stop = Vec::new();
    let off_ids: BTreeSet<String> = ps
        .off
        .keys()
        .cloned()
        .chain(
            res.refused
                .iter()
                .filter(|(_, w)| w.contains("(disabled by "))
                .map(|(k, _)| k.clone()),
        )
        .collect();
    for s in &mut ps.slots {
        let id = s.manifest.id.clone();
        let to = if off_ids.contains(&id) {
            Phase::Off
        } else {
            Phase::Refused
        };
        match res.refused.get(&id) {
            Some(why) if matches!(s.phase, Phase::Active | Phase::Starting) => {
                stop.push((id, why.clone(), to));
            }
            Some(why) => {
                s.phase = to;
                s.reason = Some(why.clone());
                s.scheduled = false;
            }
            None if matches!(s.phase, Phase::Off | Phase::Refused) => {
                s.phase = Phase::Resolved;
                s.reason = None;
            }
            None => {}
        }
    }
    let start = to_start(&ps, &res);
    if let Ok(mut reg) = k.reg.write() {
        reg.chosen = res
            .providers
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect();
    }
    ps.res = res;
    Some((stop, start))
}

/// Eager plugins that are resolved, and every resolved plugin they need, in resolution order.
fn to_start(ps: &Plugins, res: &Resolution) -> Vec<String> {
    let resolved = |id: &str| ps.phase(id) == Some(Phase::Resolved);
    let mut need: BTreeSet<String> = ps
        .slots
        .iter()
        .filter(|s| s.phase == Phase::Resolved && s.manifest.eager())
        .map(|s| s.manifest.id.clone())
        .collect();
    let mut frontier: Vec<String> = need.iter().cloned().collect();
    while let Some(id) = frontier.pop() {
        for d in res
            .deps
            .get(&id)
            .into_iter()
            .chain(res.wants.get(&id))
            .flatten()
        {
            if resolved(d) && need.insert(d.clone()) {
                frontier.push(d.clone());
            }
        }
    }
    res.order
        .iter()
        .filter(|id| need.contains(*id))
        .cloned()
        .collect()
}

fn sync_settings(k: &KernelState) {
    let Ok(ps) = k.lock_plugins() else { return };
    let on = |s: &&Slot| !matches!(s.phase, Phase::Off | Phase::Refused);
    let now = k.now_ms();
    for s in &ps.slots {
        if on(&s) {
            if let Err(e) = k.settings.declare(&s.manifest.id, s.manifest.settings()) {
                k.diag.record(
                    now,
                    &s.manifest.id,
                    "setting",
                    "conflict",
                    e.message,
                    Vec::new(),
                );
            }
        } else {
            k.settings.undeclare(&s.manifest.id);
            k.settings.release(&s.manifest.id);
        }
    }
    for s in ps.slots.iter().filter(on) {
        for (key, v) in s.manifest.set_settings() {
            if let Err(e) = k.settings.lock_by(&s.manifest.id, &key, v) {
                k.diag.record(
                    now,
                    &s.manifest.id,
                    "setting",
                    "invalid",
                    e.message,
                    Vec::new(),
                );
            }
        }
    }
}

/// `onSchedule:<every>`: a lazy plugin wakes after that long (on the injected clock).
fn arm_schedules(k: &Arc<KernelState>) {
    let Ok(mut ps) = k.lock_plugins() else { return };
    for s in ps
        .slots
        .iter_mut()
        .filter(|s| s.phase == Phase::Resolved && !s.scheduled)
    {
        let every = s
            .manifest
            .activation
            .iter()
            .filter_map(|a| a.strip_prefix("onSchedule:"))
            .find_map(crate::activation::schedule_ms);
        let Some(ms) = every else { continue };
        s.scheduled = true;
        let (id, weak, sleep, stop) = (
            s.manifest.id.clone(),
            Arc::downgrade(k),
            k.sleep(ms),
            k.root.clone(),
        );
        tokio::spawn(async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = sleep => if let Some(k) = weak.upgrade() {
                    if let Ok(mut ps) = k.lock_plugins() && let Some(s) = ps.slot(&id) { s.scheduled = false; }
                    let _ = crate::activate::activate(&k, &id).await;
                },
            }
        });
    }
}

/// Activates every resolved plugin waiting on (`kind`, `name`). Returns how many woke.
pub(crate) async fn wake(
    k: &Arc<KernelState>,
    kind: &str,
    name: &str,
    args: Option<&serde_json::Value>,
) -> usize {
    let ids: Vec<String> = match k.lock_plugins() {
        Ok(ps) => ps
            .slots
            .iter()
            .filter(|s| {
                s.phase == Phase::Resolved
                    && crate::activation::wakes(&s.manifest, kind, name, args)
            })
            .map(|s| s.manifest.id.clone())
            .collect(),
        Err(_) => return 0,
    };
    let mut n = 0;
    for id in ids {
        if crate::activate::activate(k, &id).await.is_ok() {
            n += 1;
        }
    }
    n
}

/// The off plugin that declares command `cmd`, with why it is off.
pub(crate) fn off_owner_of(k: &KernelState, cmd: &str) -> Option<(String, String)> {
    let ps = k.lock_plugins().ok()?;
    let s = ps.slots.iter().find(|s| {
        matches!(s.phase, Phase::Off | Phase::Refused)
            && s.manifest.commands().iter().any(|c| c.id == cmd)
    })?;
    Some((s.manifest.id.clone(), s.reason.clone().unwrap_or_default()))
}

pub(crate) fn status(k: &KernelState) -> Vec<PluginStatus> {
    let Ok(ps) = k.lock_plugins() else {
        return Vec::new();
    };
    let state = |p: Phase| match p {
        Phase::Active => "active",
        Phase::Resolved | Phase::Starting => "resolved",
        Phase::Off => "off",
        Phase::Refused => "refused",
    };
    let mut out: Vec<PluginStatus> = ps
        .slots
        .iter()
        .map(|s| PluginStatus {
            id: s.manifest.id.clone(),
            version: s.manifest.version.clone(),
            state: state(s.phase).into(),
            reason: s.reason.clone(),
            builtin: s.builtin,
        })
        .collect();
    out.extend(ps.dupes.iter().cloned());
    out
}

pub(crate) fn manifests(k: &KernelState) -> Vec<Manifest> {
    k.lock_plugins()
        .map(|ps| ps.slots.iter().map(|s| s.manifest.clone()).collect())
        .unwrap_or_default()
}

pub(crate) fn set_enabled(
    k: Arc<KernelState>,
    id: String,
    on: bool,
) -> BoxFuture<'static, Result<()>> {
    Box::pin(async move {
        {
            let mut ps = k.lock_plugins()?;
            if ps.slot(&id).is_none() {
                return Err(WireError::not_found(format!("no plugin {id}")));
            }
            if on {
                ps.off.remove(&id);
                ps.failed
                    .retain(|f, why| f != &id || why.starts_with("invalid manifest"));
                if let Some(s) = ps.slot(&id) {
                    s.crashes = 0;
                }
            } else {
                ps.off.insert(id.clone(), format!("{id} was switched off"));
            }
        }
        reconcile(&k).await;
        Ok(())
    })
}

/// A plugin's process died (exec tier): off with the reason, then back on after a backoff
/// (`base_ms` doubling), until `max` restarts.
pub(crate) fn crashed(k: &Arc<KernelState>, id: &str, why: &str, base_ms: u64, max: u32) {
    let attempt = match k.lock_plugins() {
        Ok(mut ps) => {
            let Some(s) = ps.slot(id) else { return };
            s.crashes += 1;
            let n = s.crashes;
            let wait = base_ms.saturating_mul(1u64 << (n - 1).min(16));
            let reason = if n > max {
                format!("{why} (gave up after {max} restarts)")
            } else {
                format!("{why}; restarting in {wait} ms")
            };
            ps.off.insert(id.to_owned(), reason.clone());
            (n <= max).then_some((wait, reason))
        }
        Err(_) => return,
    };
    let (k, id) = (k.clone(), id.to_owned());
    tokio::spawn(async move {
        reconcile(&k).await;
        let Some((wait, reason)) = attempt else {
            return;
        };
        let (sleep, stop) = (k.sleep(wait), k.root.clone());
        tokio::select! {
            () = stop.cancelled() => {}
            () = sleep => {
                let again = k.lock_plugins().is_ok_and(|mut ps| ps.off.get(&id) == Some(&reason) && ps.off.remove(&id).is_some());
                if again {
                    reconcile(&k).await;
                }
            }
        }
    });
}
