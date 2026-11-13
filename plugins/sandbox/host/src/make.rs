//! Making a sandbox for an owner, waiting for it, carrying the project in, starting work there, and dropping it
//! (ADR-0047). The grid is reached through wisp.grid-client, a sandbox through `machines.route`, git through proc.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;
use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_machines_api::PeerState;
use wisp_proc::{Env, ExecOpts, Proc};
use wisp_runtime_api::commands as rt;
use wisp_sandbox_api as api;
use wisp_sandbox_core::{self as core, Held, Owner};

use crate::calls;

/// How long a new sandbox has to come up (a cold start is ~25 s on a real grid).
const UP_MS: u64 = 90_000;
const POLL_MS: u64 = 1_500;

pub(crate) fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

/// The sandboxes this computer keeps.
pub(crate) async fn held(ctx: &Ctx, call: &Call) -> Vec<Held> {
    core::held(&calls::machines(ctx, call).await)
}

/// Sets a sandbox machine's owner (`data.owner`; machines keeps its other fields).
pub(crate) async fn set_owner(ctx: &Ctx, call: &Call, machine: &str, owner: &Owner) -> Result<()> {
    calls::set_data(ctx, call, machine, BTreeMap::from([("owner".to_owned(), owner.to_value())])).await
}

/// The sign-ins every sandbox starts with (`claude` when the user signed in for sandboxes).
pub(crate) async fn logins(ctx: &Ctx, call: &Call) -> Vec<String> {
    let v = calls::grid_info(ctx, call).await;
    if let Err(err) = &v {
        tracing::warn!(error = %err.message, "sandbox: grid-client.sandboxInfo");
    }
    core::logins_of(v.as_ref().ok().and_then(|v| v.get("logins")))
}

/// A sandbox for `owner`, up and answering: `(machine, peer, sandbox id)`. A full grid fails at once.
pub(crate) async fn make(ctx: &Ctx, call: &Call, owner: &Owner, name: &str) -> Result<(String, String, String)> {
    let made = calls::grid_new(ctx, call, name).await?;
    let (machine, sandbox) = (made.machine, made.id);
    if machine.is_empty() {
        return Err(WireError::internal("the sandbox was made but no machine here keeps it"));
    }
    set_owner(ctx, call, &machine, owner).await?;
    let peer = wait_up(ctx, call, &machine).await?;
    Ok((machine, peer, sandbox))
}

/// Waits for a sandbox's wisp to answer; its peer id.
///
/// As v1's `waitOnline`: a box that is off or in error (its tunnel failed once, a first connect that failed) gets one
/// fresh connect per wait, so it's usable again the next time it's used, and the machine card shows *connecting*
/// meanwhile. In error after that try, the wait fails at once with the box's own reason: machines put it in error
/// because retrying wouldn't help (a lost tunnel it retries itself, with backoff, as *reconnecting*).
async fn wait_up(ctx: &Ctx, call: &Call, machine: &str) -> Result<String> {
    let clock = ctx.clock()?;
    let until = clock.now_ms() + i64::try_from(UP_MS).unwrap_or(i64::MAX);
    let mut tried = false;
    loop {
        let m = calls::machine(ctx, call, machine).await?;
        let state = m.state;
        if state == PeerState::Online {
            // the app reaches it as the peer named by this machine's own id (`/api/peer/<id>`)
            return Ok(machine.to_owned());
        }
        if state == PeerState::Error && tried {
            let why = if m.error.is_empty() { "no answer" } else { m.error.as_str() };
            return Err(WireError::unavailable(format!("The sandbox didn't start: {why}")));
        }
        if state == PeerState::Off || state == PeerState::Error {
            calls::connect(ctx, call, machine).await;
            tried = true;
        }
        // a new box sleeps until it's used: one real request wakes it (a passive watch never does)
        if state == PeerState::Asleep {
            calls::wake(ctx, call, machine).await;
        }
        if clock.now_ms() > until {
            let why = if m.error.is_empty() { "it didn't answer in 3 minutes" } else { m.error.as_str() };
            let state = serde_json::to_value(state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
            return Err(WireError::unavailable(format!("The sandbox didn't come up ({state}): {why}")));
        }
        clock.sleep(POLL_MS).await;
    }
}

async fn git(proc: &Proc, cwd: &Path, args: &[String]) -> Option<String> {
    let opts = ExecOpts { cwd: Some(cwd.to_owned()), env: Env::default().with("GIT_TERMINAL_PROMPT", "0"), timeout: Some(Duration::from_secs(120)), max_output: 64 << 20, ..ExecOpts::default() };
    let r = proc.exec("git", args, opts).await.ok()?;
    r.exit.success().then(|| r.stdout_text())
}

/// The project in `cwd` as `sandbox.seed` takes it: a bundle of every ref, what isn't committed, branch, origin, author.
async fn pack(ctx: &Ctx, cwd: &str) -> Result<api::SeedArgs> {
    let proc = ctx.service::<Proc>()?;
    let dir = PathBuf::from(cwd);
    let tmp = std::env::temp_dir().join(format!("wisp-sbx-{}.bundle", wisp_kernel::ids::uuid7()));
    let [bundle, diff] = core::pack_commands(&tmp.display().to_string());
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    if git(&proc, &dir, &bundle).await.is_none() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(WireError::invalid(format!("{cwd} isn't a git repo with a commit: only a repo goes into a sandbox")));
    }
    let bytes = tokio::fs::read(&tmp).await.map_err(|e| WireError::internal(format!("the bundle: {e}")))?;
    let _ = tokio::fs::remove_file(&tmp).await;
    let line = |o: Option<String>| o.map(|x| x.trim().to_owned()).unwrap_or_default();
    Ok(api::SeedArgs {
        name: core::name_of(cwd),
        bundle: base64::engine::general_purpose::STANDARD.encode(bytes),
        patch: git(&proc, &dir, &diff).await.unwrap_or_default(),
        branch: line(git(&proc, &dir, &s(&["rev-parse", "--abbrev-ref", "HEAD"])).await).replace("HEAD", ""),
        origin: line(git(&proc, &dir, &s(&["remote", "get-url", "origin"])).await),
        author_name: line(git(&proc, &dir, &s(&["config", "user.name"])).await),
        author_email: line(git(&proc, &dir, &s(&["config", "user.email"])).await),
    })
}

/// The project in, there: its folder in the sandbox (an empty `~/code/scratch` when there's none).
async fn seed(ctx: &Ctx, call: &Call, machine: &str, cwd: Option<&str>) -> Result<String> {
    let args = match cwd.filter(|c| !c.is_empty()) {
        Some(c) => pack(ctx, c).await?,
        None => api::SeedArgs { name: "scratch".into(), ..api::SeedArgs::default() },
    };
    let out = calls::route::<api::Seed>(ctx, call, machine, args).await?;
    if out.cwd.is_empty() {
        return Err(WireError::internal("the sandbox took the project but didn't say where"));
    }
    Ok(out.cwd)
}

/// `sandbox.place`: the owner's sandbox from before (a member's own, a delegate's, a task's judges'), else a new one,
/// seeded.
pub(crate) async fn place(ctx: &Ctx, call: &Call, a: &api::PlaceArgs) -> Result<api::Placed> {
    let owner: Owner = serde_json::from_value(a.owner.clone()).map_err(|_| WireError::invalid("a sandbox's owner is a task, a delegate, a crew job or member, or a goal's judges"))?;
    if let Some(h) = core::reusable(&held(ctx, call).await, &owner) {
        let peer = wait_up(ctx, call, &h.machine).await?;
        let cwd = seed(ctx, call, &h.machine, a.cwd.as_deref()).await?;
        return Ok(api::Placed { machine: h.machine.clone(), peer, sandbox: h.sandbox.clone(), cwd, made: false });
    }
    let name = a.cwd.as_deref().map_or_else(|| "work".to_owned(), core::name_of);
    let (machine, peer, sandbox) = make(ctx, call, &owner, &name).await?;
    match seed(ctx, call, &machine, a.cwd.as_deref()).await {
        Ok(cwd) => Ok(api::Placed { machine, peer, sandbox, cwd, made: true }),
        Err(e) => {
            drop_one(ctx, call, &machine, &sandbox).await;
            Err(e)
        }
    }
}

/// `sandbox.launch`: `/sandbox <prompt>` in New task. Refused up front when the harness can't start there.
pub(crate) async fn launch(ctx: &Ctx, call: &Call, a: &api::LaunchArgs) -> Result<api::Launched> {
    let agent = a.agent.clone().unwrap_or_default();
    core::may_start(&agent, &logins(ctx, call).await).map_err(WireError::invalid)?;
    let mode = match &a.mode {
        Some(m) => Some(serde_json::from_value::<wisp_runtime_api::model::Mode>(Value::String(m.clone())).map_err(|_| WireError::invalid(format!("{m} isn't a mode (plan, edits or auto)")))?),
        None => None,
    };
    let name = a.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| a.prompt.lines().next().unwrap_or("task").chars().take(40).collect());
    let pending = Owner::Pending { pending: now(ctx) };
    let (machine, peer, sandbox) = make(ctx, call, &pending, &name).await?;
    let cwd = match seed(ctx, call, &machine, a.cwd.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            drop_one(ctx, call, &machine, &sandbox).await;
            return Err(e);
        }
    };
    let args = rt::StartArgs {
        prompt: a.prompt.clone(),
        cwd: Some(cwd),
        title: a.title.clone(),
        // Auto picks Claude in a sandbox
        agent: Some(if agent == "auto" || agent.is_empty() { "claude".to_owned() } else { agent }),
        model: a.model.clone(),
        effort: a.effort.clone(),
        mode,
        goal: a.goal.clone(),
        ..rt::StartArgs::default()
    };
    let made = match calls::route::<rt::Create>(ctx, call, &machine, args).await {
        Ok(m) => m,
        Err(e) => {
            drop_one(ctx, call, &machine, &sandbox).await;
            return Err(e);
        }
    };
    let task = made.id.0;
    set_owner(ctx, call, &machine, &Owner::Task { task: format!("{peer}:{task}") }).await?;
    Ok(api::Launched { machine, peer, task, sandbox })
}

/// Deletes one on the grid, then its machine here. A grid that can't be reached marks it `dropping` for the sweep.
pub(crate) async fn drop_one(ctx: &Ctx, call: &Call, machine: &str, sandbox: &str) -> bool {
    match calls::grid_remove(ctx, call, sandbox).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(sandbox, "a sandbox's drop failed, the sweep tries again: {}", e.message);
            calls::warn("marking a sandbox dropping", calls::set_data(ctx, call, machine, BTreeMap::from([("dropping".to_owned(), Value::Bool(true))])).await);
            false
        }
    }
}

pub(crate) async fn drop_all(ctx: &Ctx, call: &Call, list: &[&Held]) -> u32 {
    let mut n = 0;
    for h in list {
        if drop_one(ctx, call, &h.machine, &h.sandbox).await {
            n += 1;
        }
    }
    n
}

/// `sandbox.bring`: a delegate's changes in its sandbox, applied to the lead's folder here.
pub(crate) async fn bring(ctx: &Ctx, call: &Call, a: &api::BringArgs) -> Result<api::Brought> {
    let patch = calls::route::<api::PatchCmd>(ctx, call, &a.machine, api::PatchArgs { cwd: a.from.clone() }).await?.patch;
    if patch.trim().is_empty() {
        return Ok(api::Brought { files: 0, error: None });
    }
    let files = u32::try_from(patch.lines().filter(|l| l.starts_with("diff --git ")).count()).unwrap_or(u32::MAX);
    let proc = ctx.service::<Proc>()?;
    let opts = ExecOpts { cwd: Some(PathBuf::from(&a.into)), input: Some(patch.into_bytes()), timeout: Some(Duration::from_secs(60)), max_output: 1 << 20, ..ExecOpts::default() };
    let args = ["apply", "--whitespace=nowarn", "-"].map(str::to_owned).to_vec();
    let r = proc.exec("git", &args, opts).await.map_err(|e| WireError::unavailable(format!("git: {e}")))?;
    if r.exit.success() {
        Ok(api::Brought { files, error: None })
    } else {
        Ok(api::Brought { files, error: Some(format!("Its changes clash with yours here: {}", r.stderr_text().trim())) })
    }
}
