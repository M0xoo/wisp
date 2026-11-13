//! The goal's calls to other plugins, through their typed commands (`wisp-runtime-api`, `wisp-later-api`).

use serde_json::{Value, json};
use wisp_goal_api::{GoalState, PLUGIN};
use wisp_goal_core::Scheduled;
use wisp_kernel::{Call, Command, Ctx, Result, WireError};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::model::{Session, Turn};

/// `runtime.get`: the task.
pub(crate) async fn task_of(ctx: &Ctx, call: &Call, id: &str) -> Result<Session> {
    ctx.run::<rt::Get>(call, rt::IdArgs { id: id.into() }).await
}

/// `runtime.turns`: the task's turns.
pub(crate) async fn turns_of(ctx: &Ctx, call: &Call, id: &str) -> Result<Vec<Turn>> {
    ctx.run::<rt::Turns>(call, rt::TurnsArgs { id: id.into(), before: None, limit: None, masked: None }).await
}

/// `runtime.setExt`: the task's goal state written.
pub(crate) async fn put(ctx: &Ctx, call: &Call, id: &str, st: &GoalState) -> Result<()> {
    let value = serde_json::to_value(st).map_err(|e| WireError::internal(e.to_string()))?;
    ctx.run::<rt::SetExt>(call, rt::SetExtArgs { id: id.into(), plugin: PLUGIN.into(), value }).await.map(|_| ())
}

/// The goal state a task carries (`ext["wisp.goal"]`).
pub(crate) fn state_of(task: &Session) -> Option<GoalState> {
    task.ext.get(PLUGIN).and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// The task's spec (`ext["wisp.runtime"].spec`).
pub(crate) fn spec_of(task: &Session) -> Value {
    task.ext.get("wisp.runtime").and_then(|r| r.get("spec")).cloned().unwrap_or_default()
}

/// A judge's run: its profile's harness and model, or the harness itself.
pub(crate) async fn pick_of(ctx: &Ctx, judge: &str) -> rt::RunPick {
    let profiles = ctx.run::<rt::Profiles>(&ctx.root_call(), json!({})).await.unwrap_or_default();
    let some = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    match profiles.iter().find(|p| p.name == judge) {
        Some(p) => rt::RunPick { agent: some(&p.spec.harness), model: some(&p.spec.model), effort: some(&p.spec.effort) },
        None => rt::RunPick { agent: Some(judge.to_owned()), ..rt::RunPick::default() },
    }
}

/// The task's scheduled entries (`later.list`), as the goal reads them.
pub(crate) async fn scheduled(ctx: &Ctx, id: &str) -> Vec<Scheduled> {
    let list = ctx.run::<wisp_later_api::List>(&ctx.root_call(), wisp_later_api::SessionArgs { session_id: id.to_owned() }).await.unwrap_or_default();
    list.into_iter().map(|l| Scheduled { id: l.id, by: l.by, remind: l.remind, set_at: l.set_at }).collect()
}

/// A goal state write that was refused: logged, as the turn's other refusals are (the goal carries on).
pub(crate) fn warn_put(id: &str, r: Result<()>) {
    if let Err(err) = r {
        tracing::warn!(task = %id, "goal: {}", err.message);
    }
}

/// A judge's quick run, here or on the sandbox's machine: `machines.route` is typed, the command it carries is
/// named for the peer to run (its args as the JSON the peer reads). Its answer's text.
pub(crate) async fn quick(ctx: &Ctx, machine: Option<&str>, a: rt::QuickArgs) -> Result<String> {
    let Some(machine) = machine else { return ctx.run::<rt::Quick>(&ctx.root_call(), a).await.map(|r| r.text) };
    let args = serde_json::to_value(&a).map_err(|e| WireError::internal(e.to_string()))?;
    let r = wisp_machines_api::RouteArgs { id: Some(machine.to_owned()), cmd: <rt::Quick as Command>::ID.to_owned(), args, mid: format!("judge-{}", wisp_kernel::ids::uuid7()) };
    let out = ctx.run::<wisp_machines_api::Route>(&ctx.root_call(), r).await?;
    Ok(out.get("text").and_then(Value::as_str).unwrap_or_default().to_owned())
}
