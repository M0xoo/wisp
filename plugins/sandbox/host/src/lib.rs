//! wisp.sandbox (ADR-0047): sandboxes on the user's wisp Grid, each for one owner (a task's `/sandbox`, a
//! delegate, a crew job or member, a goal's judges), seeded with the project, deleted with their owner. On a
//! computer it makes, places, drops and sweeps them; inside a sandbox (`WISP_SANDBOX=1`) it only takes the project in.
//!
//! An owner going: a local task deleted (`session.deleted`: its delegates', judges' and a crew job's sandboxes), a
//! member leaving the crew (`crew.left`), and a sandboxed task deleted on its sandbox's own wisp, seen by the
//! minute's look at each task-owned sandbox (its task gone there: the sandbox goes). The sweep, at start and every
//! 10 minutes, drops what a failed drop left and launches that never got their task.

mod claude;
mod make;
mod seed;

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_sandbox_api as api;
use wisp_sandbox_core::{self as core, Owner};

pub use seed::in_sandbox;

#[derive(Debug, Default)]
pub struct SandboxPlugin {
    /// a sandbox's wisp or not; unset: `WISP_SANDBOX=1` says (tests set it)
    pub inside: Option<bool>,
    /// where projects land (`<home>/code`); unset: `$HOME`
    pub home: Option<std::path::PathBuf>,
}

/// How often task-owned sandboxes are looked at (is their task still there?).
const OWNERS_MS: u64 = 60_000;

fn home() -> std::path::PathBuf {
    std::env::var_os("HOME").map_or_else(std::env::temp_dir, std::path::PathBuf::from)
}

async fn info(ctx: &Ctx, call: &wisp_kernel::Call) -> Result<api::Info> {
    let grid = ctx.run_json(call, "grid-client.sandboxInfo", json!({})).await;
    let (enabled, why, logins, env) = match &grid {
        Ok(v) => {
            let names = |k: &str| v.get(k).and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(str::to_owned).or_else(|| x.get("agent").and_then(Value::as_str).map(str::to_owned))).collect::<Vec<_>>();
            let on = v.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            (on, (!on).then(|| "This grid doesn't make sandboxes.".to_owned()), core::logins_of(v.get("logins")), names("env"))
        }
        Err(e) => (false, Some(e.message.clone()), Vec::new(), Vec::new()),
    };
    let list = make::machines(ctx, call).await;
    let sandboxes = list
        .iter()
        .filter_map(|m| {
            let data = if m.get("sandbox").is_some() { m } else { m.get("data")? };
            let sandbox = data.get("sandbox")?.as_str()?.to_owned();
            let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            // the app reaches a machine by its own id (`/api/peer/<id>`): that's its peer there
            Some(api::SandboxView { machine: s("id"), peer: s("id"), sandbox, name: s("name"), owner: data.get("owner").cloned().unwrap_or(Value::Null), state: s("state") })
        })
        .collect();
    Ok(api::Info { enabled, why, logins, env, sandboxes })
}

/// Task-owned sandboxes whose task is gone on their own wisp go (a sandbox asleep or unreachable is kept).
async fn owners_gone(ctx: &Ctx) {
    let call = ctx.root_call();
    for h in make::held(ctx, &call).await {
        let Some(Owner::Task { task } | Owner::Job { job: task, .. }) = &h.owner else { continue };
        let id = core::bare(task);
        if let Err(e) = make::route(ctx, &call, &h.machine, "runtime.get", json!({ "id": id })).await
            && e.code == wisp_kernel::Code::NotFound
        {
            make::drop_one(ctx, &call, &h.machine, &h.sandbox).await;
        }
    }
}

async fn sweep(ctx: &Ctx) {
    let call = ctx.root_call();
    let all = make::held(ctx, &call).await;
    let n = make::drop_all(ctx, &call, &core::sweep(&all, make::now(ctx))).await;
    if n > 0 {
        tracing::info!("sandbox sweep: {n} dropped");
    }
}

/// An owner going takes its sandboxes with it; the sweep and the look at task owners run on the plugin's clock.
fn watch(s: &mut Setup) {
        // an owner going takes its sandboxes with it
        s.on::<wisp_runtime_api::events::SessionDeleted, _, _>(|ctx, e| async move {
            let call = ctx.root_call();
            let all = make::held(&ctx, &call).await;
            make::drop_all(&ctx, &call, &core::gone_with_task(&all, e.id.as_str())).await;
        });
        s.on::<wisp_crew_api::events::Left, _, _>(|ctx, e| async move {
            let call = ctx.root_call();
            let all = make::held(&ctx, &call).await;
            make::drop_all(&ctx, &call, &core::gone_with_member(&all, &e.crew_id)).await;
        });
        s.on_start(|ctx| async move {
            let Ok(clock) = ctx.clock() else { return Ok(()) };
            // tests look sooner (`WISP_SANDBOX_TICK_MS`); everywhere else, once a minute
            let every = std::env::var("WISP_SANDBOX_TICK_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(OWNERS_MS).max(200);
            let scope = ctx.scope().clone();
            let c = ctx.clone();
            ctx.spawn(async move {
                let mut since_sweep = core::SWEEP_MS;
                loop {
                    if since_sweep >= core::SWEEP_MS {
                        sweep(&c).await;
                        since_sweep = 0;
                    }
                    owners_gone(&c).await;
                    tokio::select! {
                        () = scope.cancelled() => return,
                        () = clock.sleep(every) => since_sweep += every,
                    }
                }
            });
            Ok(())
        });
}

impl Plugin for SandboxPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let inside = self.inside.unwrap_or_else(|| in_sandbox(&|k| std::env::var(k).ok()));
        let at = self.home.clone().unwrap_or_else(home);
        s.command::<api::Seed, _, _>(move |ctx, _call, a| {
            let at = at.clone();
            async move {
                // only a sandbox takes a project in: anywhere else this would overwrite ~/code
                if !inside {
                    return Err(WireError::forbidden("Only a sandbox takes a project in (sandbox.seed)."));
                }
                seed::seed(&ctx, &at, &a).await
            }
        });
        let at = self.home.clone().unwrap_or_else(home);
        s.command::<api::PatchCmd, _, _>(move |ctx, _call, a| {
            let at = at.clone();
            async move {
                if !inside {
                    return Err(WireError::forbidden("Only a sandbox gives its changes back (sandbox.patch)."));
                }
                seed::patch(&ctx, &at, &a.cwd).await
            }
        });
        if inside {
            // a sandbox makes no sandboxes and has no owners to watch
            return Ok(());
        }
        s.command::<api::Bring, _, _>(|ctx, call, a| async move { make::bring(&ctx, &call, &a).await });
        s.command::<api::Launch, _, _>(|ctx, call, a| async move { make::launch(&ctx, &call, &a).await });
        s.command::<api::Place, _, _>(|ctx, call, a| async move { make::place(&ctx, &call, &a).await });
        s.command::<api::Drop, _, _>(|ctx, call, a| async move {
            let all = make::held(&ctx, &call).await;
            let list: Vec<&core::Held> = if let Some(m) = &a.machine {
                all.iter().filter(|h| &h.machine == m).collect()
            } else if let Some(t) = &a.task {
                core::gone_with_task(&all, t)
            } else if let Some(c) = &a.crew {
                core::gone_with_member(&all, c)
            } else {
                return Err(WireError::invalid("say whose sandboxes: a task, a crew member, or a machine"));
            };
            Ok(api::Dropped { dropped: make::drop_all(&ctx, &call, &list).await })
        });
        s.command::<api::Own, _, _>(|ctx, call, a| async move {
            let owner: Owner = serde_json::from_value(a.owner).map_err(|_| WireError::invalid("not a sandbox owner"))?;
            if !make::held(&ctx, &call).await.iter().any(|h| h.machine == a.machine) {
                return Err(WireError::not_found("That machine isn't a sandbox."));
            }
            make::set_owner(&ctx, &call, &a.machine, &owner).await?;
            Ok(api::Empty {})
        });
        s.command::<api::InfoCmd, _, _>(|ctx, call, _a| async move { info(&ctx, &call).await });
        let flow: claude::Shared = Arc::new(Mutex::new(claude::Flow::default()));
        let f = flow.clone();
        s.command::<api::ClaudeBegin, _, _>(move |ctx, _call, _a| {
            let f = f.clone();
            async move { claude::begin(&ctx, &f).await }
        });
        let f = flow.clone();
        s.command::<api::ClaudeCode, _, _>(move |ctx, call, a| {
            let f = f.clone();
            async move { claude::code(&ctx, &call, &f, &a.code).await }
        });
        let f = flow;
        s.command::<api::ClaudeState, _, _>(move |_ctx, _call, _a| {
            let f = f.clone();
            async move { Ok(claude::current(&f)) }
        });
        s.command::<api::Logout, _, _>(|ctx, call, a| async move {
            ctx.run_json(&call, "grid-client.sandboxLogout", json!({ "agent": a.agent })).await?;
            info(&ctx, &call).await
        });
        s.command::<api::Env, _, _>(|ctx, call, a| async move {
            ctx.run_json(&call, "grid-client.sandboxEnv", json!({ "key": a.key, "value": a.value })).await?;
            info(&ctx, &call).await
        });
        watch(s);
        Ok(())
    }
}
