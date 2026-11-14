//! The share's calls to other plugins, through their typed commands (`wisp-runtime-api`, `wisp-crew-api`,
//! `wisp-telemetry-api`, `wisp-grid-client-api`). What they answer is read as the JSON the scrub walks: the
//! same JSON a by-name call would have answered.

use serde::Serialize;
use serde_json::{Map, Value};
use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::model::Session;
use wisp_runtime_api::spec::{AdoptArgs, HashArgs};

/// A typed answer as JSON.
pub(crate) fn to_json<T: Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| WireError::internal(e.to_string()))
}

/// `runtime.get`: the task.
pub(crate) async fn task(ctx: &Ctx, call: &Call, id: &str) -> Result<Session> {
    ctx.run::<rt::Get>(call, rt::IdArgs { id: id.into() }).await
}

/// `runtime.spec`: the task's spec, as JSON.
pub(crate) async fn spec(ctx: &Ctx, call: &Call, id: &str) -> Result<Value> {
    to_json(&ctx.run::<rt::SpecOf>(call, rt::IdArgs { id: id.into() }).await?)
}

/// `runtime.snapshot`: the formula the task ran with (`Null` when there's none).
pub(crate) async fn formula(ctx: &Ctx, call: &Call, id: &str) -> Value {
    ctx.run::<rt::SnapshotOf>(call, HashArgs { of: id.to_owned() }).await.map_or(Value::Null, |s| s.formula)
}

/// `runtime.turns`, masked: a share never carries a .env value, whatever Hide .env values says (ADR-0050).
pub(crate) async fn masked_turns(ctx: &Ctx, call: &Call, id: &str) -> Result<Vec<(String, Value)>> {
    let turns = ctx.run::<rt::Turns>(call, rt::TurnsArgs { id: id.into(), before: None, limit: None, masked: Some(true) }).await?;
    turns.iter().map(|t| Ok((t.id.to_string(), to_json(t)?))).collect()
}

/// `runtime.activity`, masked (ADR-0050): a turn's steps as JSON (`Null` when refused).
pub(crate) async fn masked_steps(ctx: &Ctx, call: &Call, id: &str, turn: &str) -> Value {
    let a = rt::ActivityArgs { id: id.into(), turn_id: turn.into(), since_seq: None, masked: Some(true) };
    match ctx.run::<rt::ActivityOf>(call, a).await {
        Ok(page) => to_json(&page).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

/// `runtime.list`: every task's `(id, title)`.
pub(crate) async fn titles(ctx: &Ctx, call: &Call) -> Result<Vec<(String, String)>> {
    let list = ctx.run::<rt::List>(call, rt::ListArgs::default()).await?;
    Ok(list.into_iter().map(|t| (t.id.to_string(), t.title)).collect())
}

/// `crew.list`: every member's `(id, name)`.
pub(crate) async fn crew(ctx: &Ctx, call: &Call) -> Result<Vec<(String, String)>> {
    let list = ctx.run::<wisp_crew_api::commands::List>(call, wisp_crew_api::commands::NoArgs {}).await?;
    Ok(list.into_iter().map(|m| (m.member.id, m.member.name)).collect())
}

/// `runtime.agents`: the harnesses this wisp has (`(id, available)`); none when refused.
pub(crate) async fn agents(ctx: &Ctx, call: &Call) -> Vec<(String, bool)> {
    ctx.run::<rt::Agents>(call, rt::AgentsArgs { fresh: None })
        .await
        .map(|v| v.into_iter().map(|a| (a.id, a.available)).collect())
        .unwrap_or_default()
}

/// `runtime.adopt`: a read-only task from shared turns, as JSON. Its args from JSON built here (a bundle's spec),
/// refused in the words its handler would use.
pub(crate) async fn adopt(ctx: &Ctx, call: &Call, args: Value) -> Result<Value> {
    let a: AdoptArgs =
        serde_json::from_value(args).map_err(|e| WireError::invalid(format!("{}: {e}", <rt::Adopt as wisp_kernel::Command>::ID)))?;
    to_json(&ctx.run::<rt::Adopt>(call, a).await?)
}

/// `telemetry.track`: a catalogue event (props: a JSON object), on the root call.
pub(crate) async fn track(ctx: &Ctx, event: &str, props: Value) -> Result<()> {
    let props = match props {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    ctx.run::<wisp_telemetry_api::Track>(&ctx.root_call(), wisp_telemetry_api::TrackArgs { event: event.to_owned(), props })
        .await
        .map(|_| ())
}

/// `grid-client.revoke`: a link taken back.
pub(crate) async fn revoke(ctx: &Ctx, call: &Call, id: String) -> Result<()> {
    ctx.run::<wisp_grid_client_api::Revoke>(call, wisp_grid_client_api::IdArgs { id }).await.map(|_| ())
}

/// `grid-client.fetch`: a pasted link fetched.
pub(crate) async fn fetch(ctx: &Ctx, call: &Call, link: String, password: Option<String>) -> Result<wisp_grid_client_api::Fetched> {
    ctx.run::<wisp_grid_client_api::Fetch>(call, wisp_grid_client_api::FetchArgs { link, password }).await
}

/// A follow-up call that was refused: logged (the command it's part of carries on).
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "share: {what}");
    }
}
