//! Activation and scopes (plan §6.4): a plugin's setup registers into its scope, its `on_start`s run
//! once the set resolved, and switching it off cancels the scope and removes every command, interceptor,
//! subscriber, contribution, service, route, setting lock and watcher it made. Nothing to write by hand.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;

use crate::caps::owned_by;
use crate::events::Sub;
use crate::host::{CmdReg, Ctx, HookReg, Setup, StartFn};
use crate::life::Phase;
use crate::reg::{CmdEntry, HookEntry, PointEntry, ProvEntry, service_key};
use crate::state::KernelState;
use crate::{BoxFuture, Code, Result, WireError};

/// Activates one plugin (and first what it depends on). Waits if it is starting already.
pub(crate) fn activate(k: &Arc<KernelState>, id: &str) -> BoxFuture<'static, Result<()>> {
    let (k, id) = (k.clone(), id.to_owned());
    Box::pin(async move {
        loop {
            let (phase, ready, reason, deps) = {
                let mut ps = k.lock_plugins()?;
                let deps: Vec<String> = ps
                    .res
                    .deps
                    .get(&id)
                    .into_iter()
                    .chain(ps.res.wants.get(&id))
                    .flatten()
                    .cloned()
                    .collect();
                let Some(s) = ps.slot(&id) else {
                    return Err(WireError::not_found(format!("no plugin {id}")));
                };
                (s.phase, s.ready.clone(), s.reason.clone(), deps)
            };
            match phase {
                Phase::Active => return Ok(()),
                Phase::Off | Phase::Refused => {
                    return Err(WireError::new(
                        Code::PluginOff,
                        reason.unwrap_or_else(|| format!("{id} is off")),
                    ));
                }
                Phase::Starting => {
                    let wait = ready.notified();
                    tokio::pin!(wait);
                    wait.as_mut().enable();
                    if k.lock_plugins()?.phase(&id) == Some(Phase::Starting) {
                        wait.await;
                    }
                }
                Phase::Resolved => {
                    for d in deps {
                        let hard = k
                            .lock_plugins()?
                            .res
                            .deps
                            .get(&id)
                            .is_some_and(|ds| ds.contains(&d));
                        let r = activate(&k, &d).await;
                        if hard {
                            r?;
                        }
                    }
                    batch(&k, vec![id.clone()]).await;
                }
            }
        }
    })
}

/// Runs every setup in order, then every `on_start` in order (`App::start`'s contract). A failure turns
/// that plugin off with the reason, and a new resolution takes its dependents with it.
pub(crate) async fn batch(k: &Arc<KernelState>, ids: Vec<String>) {
    let mut started: Vec<(String, Ctx, Vec<StartFn>)> = Vec::new();
    let mut failed = false;
    for id in ids {
        let Some((plugin, ctx, manifest)) = begin(k, &id) else {
            continue;
        };
        let mut s = Setup::new(ctx.clone());
        let r = std::panic::catch_unwind(AssertUnwindSafe(|| plugin.setup(&mut s)))
            .unwrap_or_else(|_| Err(WireError::internal("setup panicked")));
        match r.and_then(|()| install(k, &ctx, &manifest, s)) {
            Ok(starts) => started.push((id, ctx, starts)),
            Err(e) => {
                fail(k, &id, "setup", &e);
                failed = true;
            }
        }
    }
    for (id, ctx, starts) in started {
        let mut res = Ok(());
        for f in starts {
            if k.lock_plugins().ok().and_then(|ps| ps.phase(&id)) != Some(Phase::Starting) {
                break;
            }
            let fut = AssertUnwindSafe(f(ctx.clone())).catch_unwind();
            res = tokio::select! {
                biased;
                r = fut => r.unwrap_or_else(|_| Err(WireError::internal("on_start panicked"))),
                () = ctx.scope().cancelled() => Err(WireError::new(Code::PluginOff, format!("{id} went off while starting"))),
            };
            if res.is_err() {
                break;
            }
        }
        match res {
            Ok(()) => finish(k, &id),
            Err(e) => {
                fail(k, &id, "start", &e);
                failed = true;
            }
        }
    }
    if failed {
        crate::life::reconcile(k).await;
    }
}

/// Resolved → Starting, with a fresh scope and context.
fn begin(k: &Arc<KernelState>, id: &str) -> Option<(Arc<dyn crate::Plugin>, Ctx, crate::Manifest)> {
    let mut ps = k.lock_plugins().ok()?;
    let s = ps.slot(id)?;
    if s.phase != Phase::Resolved {
        return None;
    }
    let scope = k.root.child_token();
    let ctx = Ctx::new(k, id, scope.clone());
    s.phase = Phase::Starting;
    s.scope = Some(scope);
    s.ctx = Some(ctx.clone());
    s.scheduled = false;
    tracing::debug!(plugin = id, "activating");
    Some((s.plugin.clone(), ctx, s.manifest.clone()))
}

fn finish(k: &KernelState, id: &str) {
    if let Ok(mut ps) = k.lock_plugins()
        && let Some(s) = ps.slot(id)
        && s.phase == Phase::Starting
    {
        s.phase = Phase::Active;
        s.ready.notify_waiters();
        tracing::info!(plugin = id, "active");
    }
}

fn fail(k: &Arc<KernelState>, id: &str, kind: &str, e: &WireError) {
    let why = format!("{id}: {kind} failed: {}", e.message);
    k.diag.record(
        k.now_ms(),
        id,
        kind,
        "internal",
        e.message.clone(),
        Vec::new(),
    );
    tracing::warn!(plugin = id, "{why}");
    if let Ok(mut ps) = k.lock_plugins() {
        ps.failed.insert(id.to_owned(), why.clone());
    }
    deactivate(k, id, why, Phase::Refused);
}

/// Drops a plugin's scope: tasks, timers and children are cancelled, every registration is removed.
pub(crate) fn deactivate(k: &KernelState, id: &str, why: String, to: Phase) {
    let scope = match k.lock_plugins() {
        Ok(mut ps) => {
            let Some(s) = ps.slot(id) else { return };
            s.phase = to;
            s.reason = Some(why);
            s.ctx = None;
            s.scheduled = false;
            s.ready.notify_waiters();
            s.scope.take()
        }
        Err(_) => return,
    };
    if let Some(scope) = scope {
        scope.cancel();
    }
    if let Ok(mut reg) = k.reg.write() {
        reg.remove_owner(id);
    }
    k.bus.drop_owner(id);
    k.settings.release(id);
    tracing::info!(plugin = id, "off");
}

/// Checks then installs what `setup` registered. Nothing is installed if anything is refused.
fn install(k: &Arc<KernelState>, ctx: &Ctx, m: &crate::Manifest, s: Setup) -> Result<Vec<StartFn>> {
    let id = ctx.plugin();
    {
        let reg = k.read_reg()?;
        for c in &s.commands {
            check_command(&reg, id, c)?;
        }
    }
    for (sid, major, _) in &s.services {
        let declared = m.provided(sid).ok_or_else(|| {
            WireError::invalid(format!(
                "{id} provides {sid} without declaring it in its manifest's provides"
            ))
        })?;
        if crate::semver::major_of(declared) != Some(u64::from(*major)) {
            return Err(WireError::invalid(format!(
                "{id} provides {sid}@{major}, but its manifest says {declared}"
            )));
        }
    }
    for c in s.commands {
        add_command(k, ctx, c)?;
    }
    for h in s.hooks {
        add_hook(k, ctx, h)?;
    }
    for (point, version, item, json) in s.points {
        k.write_reg()?.add_point(
            &point,
            PointEntry {
                owner: ctx.inner.id.clone(),
                version,
                item,
                json,
            },
        );
    }
    for (sid, major, item) in s.services {
        k.write_reg()?.add_service(
            service_key(sid, major),
            ProvEntry {
                owner: ctx.inner.id.clone(),
                item,
            },
        );
    }
    for (pattern, f) in s.events {
        add_sub(k, ctx, pattern, f);
    }
    Ok(s.starts)
}

fn check_command(reg: &crate::reg::Registry, id: &str, c: &CmdReg) -> Result<()> {
    if !owned_by(&c.id, id) {
        return Err(WireError::invalid(format!(
            "{id} registers {} outside its namespace (\"{}.\")",
            c.id,
            crate::caps::owner_prefix(id)
        )));
    }
    if let Some(had) = reg.commands.get(&c.id) {
        return Err(WireError::conflict(format!(
            "{} is already registered by {}",
            c.id, had.owner
        )));
    }
    Ok(())
}

/// Registers one command for `ctx`'s plugin (setup, or later over RPC for the exec tier).
pub(crate) fn add_command(k: &KernelState, ctx: &Ctx, c: CmdReg) -> Result<()> {
    let id = ctx.plugin();
    let mut reg = k.write_reg()?;
    check_command(&reg, id, &c)?;
    let perm_s = c
        .permission
        .clone()
        .unwrap_or_else(|| crate::perm::of_command(&c.id));
    let perm = crate::perm::parse(&perm_s)
        .ok_or_else(|| WireError::invalid(format!("{}: \"{perm_s}\" is not a permission", c.id)))?;
    let frame = format!("{id}:{}", c.id);
    reg.add_command(CmdEntry {
        id: c.id,
        owner: ctx.inner.id.clone(),
        perm,
        read_only: c.read_only,
        task_args: c.task_args,
        all_tasks: c.all_tasks,
        reads_any: c.reads_any,
        args_ts: c.args_ts,
        json: c.json,
        typed: c.typed,
        ctx: ctx.clone(),
        frame,
    })
}

pub(crate) fn add_hook(k: &KernelState, ctx: &Ctx, h: HookReg) -> Result<()> {
    let frame = format!("{}:{}", ctx.plugin(), h.hook);
    let e = HookEntry {
        owner: ctx.inner.id.clone(),
        opts: h.opts,
        order: 0,
        json: h.json,
        typed: h.typed,
        ctx: ctx.clone(),
        frame,
    };
    k.write_reg()?.add_hook(&h.hook, e);
    Ok(())
}

pub(crate) fn add_sub(k: &Arc<KernelState>, ctx: &Ctx, pattern: String, f: crate::events::SubFn) {
    k.bus.subscribe(
        k,
        &ctx.inner.id,
        Sub {
            pattern,
            f,
            ctx: ctx.clone(),
        },
        ctx.scope(),
    );
}
