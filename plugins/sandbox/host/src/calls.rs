//! The sandbox plugin's calls to other plugins, through their typed commands (`wisp-machines-api`,
//! `wisp-grid-client-api`), and to a sandbox's own wisp through `machines.route`, typed by the command it carries.

use std::collections::BTreeMap;

use serde_json::Value;
use wisp_grid_client_api as g;
use wisp_kernel::{Call, Command, Ctx, Result, WireError};
use wisp_machines_api::{PeerView, commands as m};

/// `machines.list`, each peer as JSON with its transport fields flattened in (none when refused).
pub(crate) async fn machines(ctx: &Ctx, call: &Call) -> Vec<Value> {
    match ctx.run::<m::List>(call, m::NoArgs {}).await {
        Ok(list) => list.iter().filter_map(|p| serde_json::to_value(p).ok()).collect(),
        Err(err) => {
            tracing::warn!(error = %err.message, "sandbox: machines.list");
            Vec::new()
        }
    }
}

/// `machines.get`.
pub(crate) async fn machine(ctx: &Ctx, call: &Call, id: &str) -> Result<PeerView> {
    ctx.run::<m::Get>(call, m::IdArgs { id: id.to_owned() }).await
}

/// `machines.update` with these transport fields; the machine keeps the rest (`data` is merged there).
pub(crate) async fn set_data(ctx: &Ctx, call: &Call, id: &str, data: BTreeMap<String, Value>) -> Result<()> {
    let set = m::AddArgs { data, ..m::AddArgs::default() };
    ctx.run::<m::Update>(call, m::UpdateArgs { id: id.to_owned(), set }).await.map(|_| ())
}

/// `machines.connect`: a refusal is logged (the wait for it carries on).
pub(crate) async fn connect(ctx: &Ctx, call: &Call, id: &str) {
    warn("connecting a sandbox", ctx.run::<m::Connect>(call, m::IdArgs { id: id.to_owned() }).await);
}

/// One real request to an asleep box, which wakes it (a passive watch never does): a refusal is logged.
pub(crate) async fn wake(ctx: &Ctx, call: &Call, id: &str) {
    let a = m::CallArgs { id: id.to_owned(), method: "GET".into(), path: "/health".into(), body: None, timeout_ms: Some(30_000) };
    warn("machines.call /health", ctx.run::<m::CallPeer>(call, a).await);
}

/// Command `C` on a sandbox's own wisp, through `machines.route`.
pub(crate) async fn route<C: Command>(ctx: &Ctx, call: &Call, machine: &str, args: C::Args) -> Result<C::Out> {
    let args = serde_json::to_value(args).map_err(|e| WireError::internal(format!("{}: {e}", C::ID)))?;
    let mid = format!("sbx-{}", wisp_kernel::ids::uuid7());
    let out = ctx.run::<m::Route>(call, m::RouteArgs { id: Some(machine.to_owned()), cmd: C::ID.to_owned(), args, mid }).await?;
    serde_json::from_value(out).map_err(|e| WireError::internal(format!("the sandbox's answer to {}: {e}", C::ID)))
}

/// `grid-client.sandboxInfo`: the grid's sandbox settings as it says them (`enabled`, `logins`, `env`).
pub(crate) async fn grid_info(ctx: &Ctx, call: &Call) -> Result<Value> {
    ctx.run::<g::SandboxInfo>(call, g::NoArgs {}).await
}

/// `grid-client.sandbox`: a new sandbox on the grid, and the machine here that keeps it.
pub(crate) async fn grid_new(ctx: &Ctx, call: &Call, name: &str) -> Result<g::Sandbox> {
    ctx.run::<g::SandboxNew>(call, g::SandboxArgs { name: name.to_owned() }).await
}

/// `grid-client.sandboxRemove`.
pub(crate) async fn grid_remove(ctx: &Ctx, call: &Call, sandbox: &str) -> Result<()> {
    ctx.run::<g::SandboxRemove>(call, g::IdArgs { id: sandbox.to_owned() }).await.map(|_| ())
}

/// `grid-client.sandboxLogin`: a sign-in every sandbox starts with.
pub(crate) async fn grid_login(ctx: &Ctx, call: &Call, agent: &str, token: &str) -> Result<()> {
    let a = g::SandboxSetArgs { agent: agent.to_owned(), token: token.to_owned(), ..g::SandboxSetArgs::default() };
    ctx.run::<g::SandboxLogin>(call, a).await.map(|_| ())
}

/// `grid-client.sandboxLogout`.
pub(crate) async fn grid_logout(ctx: &Ctx, call: &Call, agent: &str) -> Result<()> {
    ctx.run::<g::SandboxLogout>(call, g::SandboxSetArgs { agent: agent.to_owned(), ..g::SandboxSetArgs::default() }).await.map(|_| ())
}

/// `grid-client.sandboxEnv`: an env var every sandbox gets (an empty `value` takes it out).
pub(crate) async fn grid_env(ctx: &Ctx, call: &Call, key: &str, value: &str) -> Result<()> {
    let a = g::SandboxSetArgs { key: key.to_owned(), value: value.to_owned(), ..g::SandboxSetArgs::default() };
    ctx.run::<g::SandboxEnv>(call, a).await.map(|_| ())
}

/// A follow-up call that was refused: logged (the command it's part of carries on).
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "sandbox: {what}");
    }
}
