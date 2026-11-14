//! The router's calls to other plugins, through their typed commands (`wisp-runtime-api`,
//! `wisp-resources-api`, `wisp-telemetry-api`).

use serde_json::{Map, Value};
use wisp_kernel::{Call, Ctx, Result};
use wisp_resources_api::{Export, ExportArgs, Resource};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_api::spec::{Lineage, TaskSpec};
use wisp_telemetry_api::{Track, TrackArgs};

/// `runtime.agents`: this computer's harnesses.
pub(crate) async fn agents(ctx: &Ctx, call: &Call) -> Result<Vec<r::AgentStatus>> {
    ctx.run::<r::Agents>(call, r::AgentsArgs::default()).await
}

/// `resources.export` of these kinds.
pub(crate) async fn export(ctx: &Ctx, call: &Call, kinds: &[&str]) -> Result<Vec<Resource>> {
    let a = ExportArgs { kinds: kinds.iter().map(|k| (*k).to_owned()).collect(), include: Vec::new() };
    ctx.run::<Export>(call, a).await
}

/// `telemetry.track`: a refusal is logged (the report it's part of carries on).
pub(crate) async fn track(ctx: &Ctx, call: &Call, event: &str, props: Value) {
    let props = match props {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    warn("tracking an event", ctx.run::<Track>(call, TrackArgs { event: event.to_owned(), props }).await);
}

/// `runtime.spec`.
pub(crate) async fn spec(ctx: &Ctx, call: &Call, id: &str) -> Result<TaskSpec> {
    ctx.run::<r::SpecOf>(call, r::IdArgs { id: id.into() }).await
}

/// `runtime.get`.
pub(crate) async fn task(ctx: &Ctx, call: &Call, id: &str) -> Result<Session> {
    ctx.run::<r::Get>(call, r::IdArgs { id: id.into() }).await
}

/// `runtime.turns` (none when refused).
pub(crate) async fn turns(ctx: &Ctx, call: &Call, id: &str) -> Vec<Turn> {
    let a = r::TurnsArgs { id: id.into(), before: None, limit: None, masked: None };
    ctx.run::<r::Turns>(call, a).await.unwrap_or_else(|err| {
        tracing::warn!(error = %err.message, "router: runtime.turns");
        Vec::new()
    })
}

/// `runtime.followUp` by `by`, on `run` when given.
pub(crate) async fn follow_up(ctx: &Ctx, call: &Call, id: &str, text: String, by: &str, run: Option<r::RunPick>) -> Result<()> {
    let a = r::FollowUpArgs { id: id.into(), text, by: Some(by.to_owned()), run, ..r::FollowUpArgs::default() };
    ctx.run::<r::FollowUp>(call, a).await.map(|_| ())
}

/// `runtime.create`: a new task (`agent` empty: the default harness), triggered by `from`.
pub(crate) async fn create(ctx: &Ctx, call: &Call, prompt: String, cwd: &str, agent: &str, from: String) -> Result<String> {
    let a = r::StartArgs {
        prompt,
        cwd: some(cwd),
        agent: some(agent),
        lineage: Lineage { triggered_by: Some(from), ..Lineage::default() },
        ..r::StartArgs::default()
    };
    ctx.run::<r::Create>(call, a).await.map(|c| c.id.0)
}

/// `runtime.quick`'s answer text.
pub(crate) async fn quick(ctx: &Ctx, call: &Call, prompt: String, cwd: &str, agent: &str) -> Result<String> {
    let pick = r::RunPick { agent: some(agent), ..r::RunPick::default() };
    let a = r::QuickArgs { prompt, cwd: cwd.to_owned(), pick: Some(pick), timeout_ms: Some(300_000), json: false };
    ctx.run::<r::Quick>(call, a).await.map(|q| q.text)
}

/// `runtime.setExt` under `wisp.router`.
pub(crate) async fn set_ext(ctx: &Ctx, call: &Call, id: &str, value: Value) -> Result<()> {
    ctx.run::<r::SetExt>(call, r::SetExtArgs { id: id.into(), plugin: "wisp.router".into(), value, expect: None }).await.map(|_| ())
}

/// Merges `patch`'s keys into the task's `wisp.router` slot (`runtime.setExt` replaces the slot: the route stays).
pub(crate) async fn merge_ext(ctx: &Ctx, call: &Call, id: &str, patch: Value) -> Result<()> {
    let mut slot = task(ctx, call, id).await?.ext_of("wisp.router").as_object().cloned().unwrap_or_default();
    if let Value::Object(p) = patch {
        slot.extend(p);
    }
    set_ext(ctx, call, id, Value::Object(slot)).await
}

fn some(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_owned())
}

/// A follow-up call that was refused: logged.
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "router: {what}");
    }
}
