//! The interceptor chain (plan §6.1b, §6.11.2 rules 3–5): ordered by priority (ties: registration
//! order, or a seeded shuffle under test), each in a read-only call one level deeper, with a time budget
//! (200 ms by default, 2000 at most). A guard (`Failure::Closed`) that times out or fails vetoes; any
//! other interceptor is skipped with a warning. A veto's `then` runs after the root command settles.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::call::{CallInner, MAX_DEPTH};
use crate::dispatch::{refuse, spawn_root};
use crate::events::{Payload, Pending};
use crate::host::{Ctx, TypedHook};
use crate::reg::HookEntry;
use crate::state::KernelState;
use crate::{BoxFuture, Call, Code, Failure, FollowUp, Hook, Result, Verdict, WireError};

pub const TIMEOUT_MAX_MS: u64 = 2000;

type Typed<V> = Arc<dyn Fn(Ctx, Call, V) -> BoxFuture<'static, Verdict<V>> + Send + Sync>;

/// Hook `H` from plugin code (`Ctx::run_hook`).
pub(crate) fn typed<H: Hook>(
    ctx: Ctx,
    call: Call,
    hctx: H::Ctx,
) -> BoxFuture<'static, Result<H::Ctx>> {
    Box::pin(async move {
        let k = ctx.k()?;
        chain(&k, &call, H::ID, hctx, |h| {
            h.typed
                .as_deref()
                .and_then(|t| t.downcast_ref::<TypedHook<H>>())
                .map(|t| t.0.clone())
        })
        .await
    })
}

/// A hook by id with a JSON context (the exec tier).
pub(crate) async fn json(k: &Arc<KernelState>, call: &Call, hook: &str, v: Value) -> Result<Value> {
    chain(k, call, hook, v, |_| None).await
}

/// A small deterministic shuffle key (splitmix64) for the testkit's random interceptor order.
fn mix(seed: u64, n: u64) -> u64 {
    let mut z = seed.wrapping_add(n.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn ordered(k: &KernelState, hook: &str) -> Result<Vec<Arc<HookEntry>>> {
    let Some(list) = k.read_reg()?.hooks.get(hook).cloned() else {
        return Ok(Vec::new());
    };
    let mut list = list.as_ref().clone();
    if let Some(seed) = k.chaos.read().ok().and_then(|c| c.seed) {
        list.sort_by_key(|h| (h.opts.priority, mix(seed, h.order)));
    }
    Ok(list)
}

fn delay(k: &KernelState, owner: &str, hook: &str) -> u64 {
    k.chaos
        .read()
        .ok()
        .and_then(|c| {
            c.delays
                .iter()
                .find(|(p, h, _)| p == owner && h == hook)
                .map(|(_, _, ms)| *ms)
        })
        .unwrap_or(0)
}

#[allow(clippy::many_single_char_names)]
async fn chain<V, F>(
    k: &Arc<KernelState>,
    call: &Call,
    hook: &str,
    mut v: V,
    typed_of: F,
) -> Result<V>
where
    V: Clone + Serialize + DeserializeOwned + Send + 'static,
    F: Fn(&HookEntry) -> Option<Typed<V>>,
{
    for h in ordered(k, hook)? {
        let p = &call.inner;
        let mut stack = p.stack.clone();
        stack.push(h.frame.clone());
        if p.stack.contains(&h.frame) {
            let m = format!(
                "{hook} would run {}'s interceptor again inside itself ({})",
                h.owner,
                stack.join(" → ")
            );
            return Err(refuse(k, Code::ReentrantHook, m, &h.owner, stack));
        }
        if p.depth + 1 >= MAX_DEPTH {
            let m = format!(
                "{hook} would run at depth {} ({})",
                p.depth + 1,
                stack.join(" → ")
            );
            return Err(refuse(k, Code::DepthExceeded, m, &h.owner, stack));
        }
        let child = CallInner {
            root: p.root.clone(),
            depth: p.depth + 1,
            stack: stack.clone(),
            caller: p.caller.clone(),
            cancel: p.cancel.clone(),
            read_only: true,
            set: p.set.clone(),
            via: Some(h.owner.clone()),
            via_set: h.ctx.inner.set.clone(),
            kernel: Arc::downgrade(k),
            tx: p.tx.clone(),
        }
        .into_call();
        let ms = h.opts.timeout_ms.clamp(1, TIMEOUT_MAX_MS);
        let work = one(k, &h, hook, child, v.clone(), typed_of(&h));
        let slow = k.sleep(ms);
        let out: std::result::Result<Verdict<V>, (String, String)> = tokio::select! {
            biased;
            r = AssertUnwindSafe(work).catch_unwind() => match r {
                Ok(Ok(verdict)) => Ok(verdict),
                Ok(Err(e)) => Err((code_of(e.code), format!("{} failed on {hook}: {}", h.owner, e.message))),
                Err(_) => Err(("internal".into(), format!("{} panicked on {hook}", h.owner))),
            },
            () = slow => Err(("timeout".into(), format!("{} didn't answer {hook} within {ms} ms", h.owner))),
        };
        match out {
            Ok(Verdict::Continue) => {}
            Ok(Verdict::Modify { ctx }) => v = ctx,
            Ok(Verdict::Veto {
                code,
                message,
                then,
            }) => return Err(veto(k, call, &h, hook, &code, message, then)),
            Err((code, message)) => {
                k.diag.record(
                    k.now_ms(),
                    &h.owner,
                    "interceptor",
                    &code,
                    message.clone(),
                    stack,
                );
                if h.opts.failure == Failure::Closed {
                    return Err(veto(k, call, &h, hook, &code, message, Vec::new()));
                }
                tracing::warn!(plugin = %h.owner, "{message}; skipped (failure open)");
            }
        }
    }
    Ok(v)
}

fn code_of(c: Code) -> String {
    serde_json::to_value(c)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// One interceptor, typed when it shares the hook's Rust type, else through JSON.
fn one<V>(
    k: &KernelState,
    h: &HookEntry,
    hook: &str,
    child: Call,
    v: V,
    typed: Option<Typed<V>>,
) -> BoxFuture<'static, Result<Verdict<V>>>
where
    V: Serialize + DeserializeOwned + Send + 'static,
{
    let pause = delay(k, &h.owner, hook);
    let sleep = (pause > 0).then(|| k.sleep(pause));
    let (ctx, json_fn) = (h.ctx.clone(), h.json.clone());
    Box::pin(async move {
        if let Some(s) = sleep {
            s.await;
        }
        if let Some(t) = typed {
            return Ok(t(ctx, child, v).await);
        }
        let input = serde_json::to_value(v).map_err(|e| WireError::internal(e.to_string()))?;
        Ok(match json_fn(ctx, child, input).await? {
            Verdict::Continue => Verdict::Continue,
            Verdict::Modify { ctx } => Verdict::Modify {
                ctx: serde_json::from_value(ctx).map_err(|e| {
                    WireError::invalid(format!("a modified context that doesn't fit: {e}"))
                })?,
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
}

/// A veto: follow-ups queued on the root (or run now outside a command), `kernel.vetoed` published
/// (nothing commits for a refused action, so the fact goes out at once), and the error the caller reads.
fn veto(
    k: &Arc<KernelState>,
    call: &Call,
    h: &HookEntry,
    hook: &str,
    code: &str,
    message: String,
    then: Vec<FollowUp>,
) -> WireError {
    match &call.inner.tx {
        Some(tx) => {
            if let Ok(mut f) = tx.follow.lock() {
                f.extend(then.into_iter().map(|t| (t.cmd, t.args, h.ctx.clone())));
            }
        }
        None => then
            .into_iter()
            .for_each(|t| spawn_root(k, h.ctx.clone(), t.cmd, t.args)),
    }
    let data = json!({ "hook": hook, "by": &*h.owner, "code": code, "message": &message, "root": &call.inner.root, "stack": &call.inner.stack });
    k.bus.publish(
        k,
        &call.inner.root,
        None,
        Pending {
            ty: "kernel.vetoed".into(),
            plugin: Arc::from("wisp.kernel"),
            data: Payload::Json(Arc::new(data)),
        },
    );
    WireError::new(Code::Vetoed, message)
        .with_details(json!({ "by": &*h.owner, "reason": code, "hook": hook }))
}
