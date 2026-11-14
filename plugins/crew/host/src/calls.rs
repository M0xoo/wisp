//! The crew's calls to other plugins, through their typed commands (`wisp-runtime-api`, `wisp-machines-api`,
//! `wisp-sandbox-api`, `wisp-resources-api`, `wisp-telemetry-api`).

use serde::Serialize;
use serde_json::{Map, Value};
use wisp_crew_api::PLUGIN_ID;
use wisp_kernel::{Call, Command, Ctx, WireError};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::model::{Session, Turn};

type R<T> = Result<T, WireError>;

/// A typed answer as the JSON the crew reads (what `run_json` would have answered).
pub(crate) fn to_json<T: Serialize>(v: &T) -> R<Value> {
    serde_json::to_value(v).map_err(|e| WireError::internal(e.to_string()))
}

/// `C`'s args from JSON built here, refused in the words its handler would use (`<id>: <why>`).
pub(crate) fn args_of<C: Command>(v: Value) -> R<C::Args> {
    serde_json::from_value(v).map_err(|e| WireError::invalid(format!("{}: {e}", C::ID)))
}

/// `runtime.get`: the task.
pub(crate) async fn task(ctx: &Ctx, call: &Call, id: &str) -> R<Session> {
    ctx.run::<rt::Get>(call, rt::IdArgs { id: id.into() }).await
}

/// `runtime.turns`: the task's turns.
pub(crate) async fn turns(ctx: &Ctx, call: &Call, id: &str) -> R<Vec<Turn>> {
    ctx.run::<rt::Turns>(call, rt::TurnsArgs { id: id.into(), before: None, limit: None, masked: None }).await
}

/// The crew's slot on a task (`ext["wisp.crew"]`), or `Null`.
pub(crate) fn crew_of(s: &Session) -> &Value {
    s.ext_of(PLUGIN_ID)
}

/// `runtime.setExt`: the crew's slot on a task written.
pub(crate) async fn set_ext(ctx: &Ctx, call: &Call, id: &str, value: Value) -> R<()> {
    ctx.run::<rt::SetExt>(call, rt::SetExtArgs { id: id.into(), plugin: PLUGIN_ID.into(), value }).await.map(|_| ())
}

/// `runtime.turn.setExt`: the crew's slot on one turn written.
pub(crate) async fn turn_set_ext(ctx: &Ctx, call: &Call, id: &str, turn: &str, value: Value) -> R<()> {
    ctx.run::<rt::TurnSetExt>(call, rt::TurnExtArgs { id: id.into(), turn_id: turn.into(), plugin: PLUGIN_ID.into(), value })
        .await
        .map(|_| ())
}

/// `runtime.followUp`: a crew follow-up, queued behind a running turn.
pub(crate) async fn follow_up(ctx: &Ctx, call: &Call, id: &str, text: String) -> R<()> {
    let a = rt::FollowUpArgs { id: id.into(), text, queue: Some(true), by: Some("crew".into()), ..rt::FollowUpArgs::default() };
    ctx.run::<rt::FollowUp>(call, a).await.map(|_| ())
}

/// `C` on another machine (a sandbox): `machines.route` is typed, the command it carries is named for the peer to
/// run (its args as the JSON the peer reads).
pub(crate) async fn routed<C: Command>(ctx: &Ctx, call: &Call, machine: &str, args: Value) -> R<Value> {
    let r = wisp_machines_api::RouteArgs {
        id: Some(machine.to_owned()),
        cmd: C::ID.to_owned(),
        args,
        mid: format!("crew-{}", wisp_kernel::ids::uuid7()),
    };
    ctx.run::<wisp_machines_api::Route>(call, r).await
}

/// `sandbox.place`: the sandbox an owner's work runs in. `(machine, cwd)`.
pub(crate) async fn place(ctx: &Ctx, call: &Call, owner: Value, cwd: Option<String>) -> R<(String, String)> {
    let p = ctx.run::<wisp_sandbox_api::Place>(call, wisp_sandbox_api::PlaceArgs { owner, cwd }).await?;
    Ok((p.machine, p.cwd))
}

/// `sandbox.own`: the sandbox now belongs to `owner`.
pub(crate) async fn own(ctx: &Ctx, call: &Call, machine: &str, owner: Value) -> R<()> {
    ctx.run::<wisp_sandbox_api::Own>(call, wisp_sandbox_api::OwnArgs { machine: machine.to_owned(), owner }).await.map(|_| ())
}

/// `runtime.profiles`: the agent profiles' names.
pub(crate) async fn profile_names(ctx: &Ctx, call: &Call) -> Vec<String> {
    ctx.run::<rt::Profiles>(call, Value::Object(Map::new())).await.map(|v| v.into_iter().map(|p| p.name).collect()).unwrap_or_default()
}

/// `machines.list`: the machines this wisp knows, by their handle (a member's `machine`). None known, or machines off:
/// none, and a member can't be put on one.
pub(crate) async fn machine_ids(ctx: &Ctx, call: &Call) -> Vec<String> {
    ctx.run::<wisp_machines_api::List>(call, wisp_machines_api::NoArgs {})
        .await
        .map(|v| v.into_iter().map(|p| p.id).collect())
        .unwrap_or_default()
}

/// `resources.export`: wisp's resources of these kinds.
pub(crate) async fn export(ctx: &Ctx, call: &Call, kinds: &[&str]) -> R<Vec<wisp_resources_api::Resource>> {
    let a = wisp_resources_api::ExportArgs { kinds: kinds.iter().map(|k| (*k).to_owned()).collect(), include: Vec::new() };
    ctx.run::<wisp_resources_api::Export>(call, a).await
}

/// `telemetry.track`: a catalogue event (props: a JSON object).
pub(crate) async fn track(ctx: &Ctx, event: &str, props: Value) -> R<()> {
    let props = match props {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    ctx.run::<wisp_telemetry_api::Track>(&ctx.root_call(), wisp_telemetry_api::TrackArgs { event: event.to_owned(), props })
        .await
        .map(|_| ())
}

/// A follow-up call that was refused: logged (the command it's part of carries on).
pub(crate) fn warn<T>(what: &str, r: R<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "crew: {what}");
    }
}
