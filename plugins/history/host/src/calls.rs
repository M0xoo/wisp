//! wisp.history's calls to other plugins, through their typed commands (`wisp-runtime-api`,
//! `wisp-share-api`).

use serde_json::Value;
use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::Session;
use wisp_runtime_api::spec::{Lineage, TaskSpec};
use wisp_share_api::{Level, Preview, PreviewCmd, ShareArgs};

/// `runtime.get`.
pub(crate) async fn task(ctx: &Ctx, call: &Call, id: &str) -> Result<Session> {
    ctx.run::<r::Get>(call, r::IdArgs { id: id.into() }).await
}

/// `runtime.spec`.
pub(crate) async fn spec(ctx: &Ctx, call: &Call, id: &str) -> Result<TaskSpec> {
    ctx.run::<r::SpecOf>(call, r::IdArgs { id: id.into() }).await
}

/// How many turns a task has (`runtime.turns`, every one); 0 when refused (logged).
pub(crate) async fn turn_count(ctx: &Ctx, call: &Call, id: &str) -> usize {
    let a = r::TurnsArgs { id: id.into(), before: None, limit: None, masked: None };
    ctx.run::<r::Turns>(call, a).await.map_or_else(
        |err| {
            tracing::warn!(task = id, error = %err.message, "history: runtime.turns");
            0
        },
        |t| t.len(),
    )
}

/// `runtime.setExt` under `wisp.history`: a refusal is logged (what it marks is only a hint).
pub(crate) async fn set_ext(ctx: &Ctx, call: &Call, id: &str, value: Value) {
    let a = r::SetExtArgs { id: id.into(), plugin: wisp_history_api::EXT.into(), value };
    warn("marking the task (setExt)", ctx.run::<r::SetExt>(call, a).await);
}

/// `runtime.create`: a task forked from `of` (a resumed one).
pub(crate) async fn create_fork(ctx: &Ctx, call: &Call, prompt: String, title: String, cwd: String, of: String) -> Result<String> {
    let a = r::StartArgs { prompt, title: Some(title), cwd: Some(cwd), lineage: Lineage { fork_of: Some(of), ..Lineage::default() }, ..r::StartArgs::default() };
    ctx.run::<r::Create>(call, a).await.map(|c| c.id.as_str().to_owned())
}

/// `share.preview` at `level` (`spec` | `report` | `full`; anything else is refused).
pub(crate) async fn preview(ctx: &Ctx, call: &Call, id: &str, level: &str) -> Result<Preview> {
    let level: Level = serde_json::from_value(Value::String(level.to_owned())).map_err(|_| WireError::invalid(format!("no share level `{level}` (spec | report | full)")))?;
    ctx.run::<PreviewCmd>(call, ShareArgs { id: id.to_owned(), level }).await
}

/// A follow-up call that was refused: logged.
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "history: {what}");
    }
}
