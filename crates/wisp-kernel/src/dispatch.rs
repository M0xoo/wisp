//! The command bus (plan §6.11.2). Every call carries a trace: depth below `MAX_DEPTH`, no re-entering a
//! frame already on the stack, read-only inside interceptors, and the permission checked against the
//! caller's set and the calling plugin's own. A root command's events go out after it returns Ok (or
//! when the store's commit hook says its transaction committed); veto follow-ups (`then`) run after it
//! settles, each as a new root command speaking for the plugin that vetoed.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use serde_json::Value;
use tracing::Instrument;

use crate::call::{CallInner, MAX_DEPTH, RootTx, check_sets};
use crate::events::{Payload, Pending};
use crate::host::{Ctx, TypedCmd};
use crate::reg::CmdEntry;
use crate::state::KernelState;
use crate::{BoxFuture, Call, Caller, Code, Command, Result, WireError};

/// A refusal by the kernel itself: kept in Diagnostics with its trace, logged, returned.
pub(crate) fn refuse(
    k: &KernelState,
    code: Code,
    message: String,
    who: &str,
    stack: Vec<String>,
) -> WireError {
    let c = serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    tracing::warn!(code = %c, stack = ?stack, "{message}");
    k.diag.refuse(k.now_ms(), who, &c, message.clone(), stack);
    WireError::new(code, message)
}

/// The command's entry, activating a lazy plugin that waits on it first.
async fn find(
    k: &Arc<KernelState>,
    id: &str,
    args: impl FnOnce() -> Option<Value>,
    who: &str,
    stack: &[String],
) -> Result<Arc<CmdEntry>> {
    if let Some(e) = k.read_reg()?.commands.get(id).cloned() {
        return Ok(e);
    }
    let args = args();
    crate::life::wake(k, "onCommand", id, args.as_ref()).await;
    if let Some(e) = k.read_reg()?.commands.get(id).cloned() {
        return Ok(e);
    }
    let mut st = stack.to_vec();
    st.push(format!("?:{id}"));
    Err(match crate::life::off_owner_of(k, id) {
        Some((owner, why)) => refuse(
            k,
            Code::PluginOff,
            format!("{id}: {owner} is off ({why})"),
            who,
            st,
        ),
        None => refuse(
            k,
            Code::NotFound,
            format!("unknown command {id} (is its plugin off?)"),
            who,
            st,
        ),
    })
}

pub(crate) struct Entered {
    pub(crate) call: Call,
    /// Some when this command is a root: its buffers
    root: Option<Arc<RootTx>>,
}

/// The checks before a command runs, and its call.
fn enter(k: &Arc<KernelState>, e: &CmdEntry, from: Option<&Ctx>, parent: &Call) -> Result<Entered> {
    let p = &parent.inner;
    let in_cmd = p.tx.is_some();
    let depth = if in_cmd { p.depth + 1 } else { p.depth };
    let who = from.map_or("edge", |c| c.plugin());
    let stack = || {
        let mut s = p.stack.clone();
        s.push(e.frame.clone());
        s
    };
    if depth >= MAX_DEPTH {
        let st = stack();
        return Err(refuse(
            k,
            Code::DepthExceeded,
            format!(
                "{} would run at depth {depth}: calls nest at most {MAX_DEPTH} deep ({})",
                e.id,
                st.join(" → ")
            ),
            who,
            st,
        ));
    }
    if p.read_only && !e.read_only {
        return Err(refuse(
            k,
            Code::Forbidden,
            format!("{} writes, and an interceptor may only read", e.id),
            who,
            stack(),
        ));
    }
    let set = p.set.clone().or_else(|| k.caps.get(&p.caller.set));
    let via = from.map(|c| (c.plugin(), c.inner.set.as_deref()));
    let checked = check_sets(set.as_deref(), &p.caller.set, via, &e.perm);
    if let Err(why) = checked {
        return Err(refuse(
            k,
            Code::Forbidden,
            format!("{} refused: {}", e.id, why.message),
            who,
            stack(),
        ));
    }
    if p.cancel.is_cancelled() {
        return Err(WireError::new(
            Code::Unavailable,
            format!("{}: the call was cancelled", e.id),
        ));
    }
    let tx = if in_cmd {
        p.tx.clone()
    } else {
        Some(Arc::new(RootTx { kernel: Arc::downgrade(k), ..RootTx::default() }))
    };
    let call = CallInner {
        root: p.root.clone(),
        depth,
        stack: stack(),
        caller: p.caller.clone(),
        // a root gets its own token, cancelled when it settles; nested calls share it
        cancel: if in_cmd {
            p.cancel.clone()
        } else {
            p.cancel.child_token()
        },
        read_only: p.read_only,
        set,
        via: Some(e.owner.clone()),
        via_set: e.ctx.inner.set.clone(),
        kernel: Arc::downgrade(k),
        tx: tx.clone(),
        cause: p.cause,
        cause_depth: p.cause_depth,
    };
    Ok(Entered {
        call: call.into_call(),
        root: if in_cmd { None } else { tx },
    })
}

/// Runs a command's future inside its call: span, panic guard, the owner going off, then for a root
/// command: publish, cancel, follow-ups.
async fn run<T: Send + 'static>(
    k: &Arc<KernelState>,
    e: &CmdEntry,
    en: Entered,
    fut: BoxFuture<'static, Result<T>>,
) -> Result<T> {
    let span = tracing::debug_span!("cmd", id = %e.id, depth = en.call.inner.depth, root = %en.call.inner.root);
    let scope = e.ctx.inner.scope.clone();
    // a root command's store writes carry its durable events (and a durable handler's cursor) along
    let durable = en.root.as_ref().map(|tx| crate::durable::Scope { tx: Some(tx.clone()), cursor: crate::durable::current().cursor });
    let fut: BoxFuture<'static, Result<T>> = match durable {
        Some(d) => Box::pin(crate::durable::scoped(d, fut)),
        None => fut,
    };
    let res = async {
        tokio::select! {
            biased;
            r = AssertUnwindSafe(fut).catch_unwind() => r.unwrap_or_else(|_| Err(WireError::internal(format!("{} panicked", e.id)))),
            () = scope.cancelled() => Err(WireError::new(Code::PluginOff, format!("{}: {} was switched off", e.id, e.owner))),
        }
    }
    .instrument(span)
    .await;
    if let Err(err) = &res {
        let code = serde_json::to_value(err.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        k.diag.record(
            k.now_ms(),
            &e.owner,
            "command",
            &code,
            format!("{}: {}", e.id, err.message),
            en.call.inner.stack.clone(),
        );
    }
    if let Some(tx) = en.root {
        if res.is_ok() {
            crate::durable::append_rest(k, &tx).await;
            flush(k, &en.call.inner.root, &tx, None, 0);
        }
        en.call.inner.cancel.cancel();
        follow_ups(k, &tx);
    }
    res
}

/// Publishes a root's buffered events from `from` on (they committed).
pub(crate) fn flush(k: &KernelState, root: &str, tx: &RootTx, cursor: Option<u64>, from: usize) {
    let pending: Vec<Pending> = tx
        .events
        .lock()
        .map(|mut ev| {
            if from < ev.len() {
                ev.drain(from..).collect()
            } else {
                Vec::new()
            }
        })
        .unwrap_or_default();
    for p in pending {
        // a durable repeat (same type and key within 24 h) is the same fact: not published again
        if p.durable && p.written == crate::events::Logged::Repeat {
            continue;
        }
        k.bus.publish(k, root, cursor, p);
    }
}

fn follow_ups(k: &Arc<KernelState>, tx: &RootTx) {
    let list: Vec<(String, Value, Ctx)> = tx
        .follow
        .lock()
        .map(|mut f| std::mem::take(&mut *f))
        .unwrap_or_default();
    for (cmd, args, ctx) in list {
        spawn_root(k, ctx, cmd, args);
    }
}

/// A follow-up: a new root command (depth 0, new trace) speaking for `ctx`'s plugin.
pub(crate) fn spawn_root(k: &Arc<KernelState>, ctx: Ctx, cmd: String, args: Value) {
    k.work.add(1);
    let work = k.work.clone();
    let k = k.clone();
    tokio::spawn(async move {
        // owned by the kernel, not the vetoer's scope: the notice still goes out if it is switched off meanwhile
        let call = CallInner::detached(
            &k,
            Caller::plugin(ctx.plugin()),
            Some(ctx.inner.id.clone()),
            k.root.child_token(),
        )
        .into_call();
        if let Err(e) = json(&k, Some(ctx.clone()), &call, &cmd, args).await {
            tracing::warn!(plugin = %ctx.plugin(), "follow-up {cmd} failed: {}", e.message);
        }
        work.done(1);
    });
}

/// Command `C` from plugin code (`Ctx::run`).
pub(crate) fn typed<C: Command>(
    ctx: Ctx,
    call: Call,
    args: C::Args,
) -> BoxFuture<'static, Result<C::Out>> {
    Box::pin(async move {
        let k = ctx.k()?;
        let known = k.read_reg()?.commands.get(C::ID).cloned();
        let e = if let Some(e) = known {
            e
        } else {
            let probe = serde_json::to_value(&args).ok();
            find(&k, C::ID, move || probe, ctx.plugin(), &call.inner.stack).await?
        };
        let en = enter(&k, &e, Some(&ctx), &call)?;
        if crate::scope::agent_task(&en.call.inner.caller).is_some() {
            let v = serde_json::to_value(&args).unwrap_or_default();
            scoped(&k, &e, &en.call, &v).await?;
        }
        let fut: BoxFuture<'static, Result<C::Out>> = if let Some(t) = e
            .typed
            .as_deref()
            .and_then(|t| t.downcast_ref::<TypedCmd<C>>())
        {
            (t.0)(e.ctx.clone(), en.call.clone(), args)
        } else {
            let (f, ctx, child) = (e.json.clone(), e.ctx.clone(), en.call.clone());
            let v = serde_json::to_value(args)
                .map_err(|err| WireError::invalid(format!("{}: {err}", C::ID)))?;
            Box::pin(async move {
                serde_json::from_value(f(ctx, child, v).await?)
                    .map_err(|err| WireError::internal(format!("{}: {err}", C::ID)))
            })
        };
        run(&k, &e, en, fut).await
    })
}

/// The agent-token scope (`crate::scope`) for one command entry.
async fn scoped(k: &Arc<KernelState>, e: &CmdEntry, call: &Call, args: &Value) -> Result<()> {
    if crate::scope::agent_task(&call.inner.caller).is_none() {
        return Ok(());
    }
    let trees = crate::kernel_api::contributions(k, &crate::scope::TASKS).into_iter().map(|(_, t)| t).collect();
    if e.reads_any && crate::scope::reads_any(&call.inner.caller) {
        return Ok(());
    }
    crate::scope::check(trees, &call.inner.caller, &e.id, crate::scope::named(args, e.task_args), e.all_tasks).await
}

/// A command by id with JSON args: the edge, follow-ups, the exec tier.
pub(crate) async fn json(
    k: &Arc<KernelState>,
    from: Option<Ctx>,
    parent: &Call,
    cmd: &str,
    args: Value,
) -> Result<Value> {
    let who = from
        .as_ref()
        .map_or_else(|| "edge".to_owned(), |c| c.plugin().to_owned());
    let e = find(k, cmd, || Some(args.clone()), &who, &parent.inner.stack).await?;
    let en = enter(k, &e, from.as_ref(), parent)?;
    scoped(k, &e, &en.call, &args).await?;
    let fut = (e.json)(e.ctx.clone(), en.call.clone(), args);
    run(k, &e, en, fut).await
}

pub(crate) fn edge(
    k: Arc<KernelState>,
    caller: Caller,
    cmd: String,
    args: Value,
) -> BoxFuture<'static, Result<Value>> {
    Box::pin(async move {
        let parent = CallInner::detached(&k, caller, None, k.root.child_token()).into_call();
        json(&k, None, &parent, &cmd, args).await
    })
}

/// What an event says about itself (ADR-0044): durable, what it's about, its dedupe key.
#[derive(Debug, Clone, Default)]
pub(crate) struct Meta {
    pub(crate) durable: bool,
    pub(crate) subject: Option<String>,
    pub(crate) key: Option<String>,
}

/// Records an event on the call's root command, or publishes it at once outside a command (a durable one
/// outside a command goes to the log first, in its own transaction).
pub(crate) fn emit(ctx: &Ctx, call: &Call, ty: &str, data: Payload, meta: Meta) {
    let at = ctx.k().map_or(0, |k| k.now_ms());
    let p = Pending {
        ty: ty.to_owned(),
        plugin: ctx.inner.id.clone(),
        data,
        durable: meta.durable,
        subject: meta.subject,
        key: meta.key,
        cause: call.inner.cause,
        depth: call.inner.cause_depth,
        root: call.inner.root.clone(),
        at,
        written: crate::events::Logged::Not,
        taken: false,
    };
    if p.durable && call.inner.tx.is_none() {
        // outside a command: in-process subscribers get it at once (in order with what follows), the
        // log and the durable subscribers once it's appended
        if let Ok(k) = ctx.k() {
            let tx = Arc::new(RootTx { kernel: Arc::downgrade(&k), ..RootTx::default() });
            if let Ok(mut ev) = tx.events.lock() {
                ev.push(p.clone());
            }
            k.bus.publish(&k, &call.inner.root, None, p);
            k.work.add(1);
            tokio::spawn(async move {
                crate::durable::append_rest(&k, &tx).await;
                k.work.done(1);
            });
        }
        return;
    }
    match &call.inner.tx {
        Some(tx) => {
            if let Ok(mut ev) = tx.events.lock() {
                ev.push(p);
            }
        }
        None => {
            if let Ok(k) = ctx.k() {
                k.bus.publish(&k, &call.inner.root, None, p);
            }
        }
    }
}
