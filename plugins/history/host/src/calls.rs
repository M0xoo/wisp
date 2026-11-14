//! wisp.history's calls to other plugins, through their typed commands (`wisp-runtime-api`,
//! `wisp-share-api`).

use serde_json::Value;
use wisp_kernel::{Call, Code, Ctx, Result, WireError};
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

/// How many times [`update_ext`] reads again after another write landed between its read and its write.
const RACES: usize = 8;

/// The task's `wisp.history` slot, read then written in one compare-and-set (`runtime.setExt`'s `expect`): `next`
/// decides from what the slot holds now (None: write nothing), and if another write landed between the read and
/// the write, the slot is read again and `next` decides again, so a value computed from a stale copy never lands.
/// `Ok(true)`: written.
pub(crate) async fn update_ext(ctx: &Ctx, call: &Call, id: &str, mut next: impl FnMut(&Value) -> Option<Value>) -> Result<bool> {
    for _ in 0..RACES {
        let slot = task(ctx, call, id).await?.ext_of(wisp_history_api::EXT).clone();
        let Some(value) = next(&slot) else { return Ok(false) };
        let expect = Some(r::ExtExpect { value: slot });
        let a = r::SetExtArgs { id: id.into(), plugin: wisp_history_api::EXT.into(), value, expect };
        match ctx.run::<r::SetExt>(call, a).await {
            Ok(_) => return Ok(true),
            Err(e) if e.code == Code::Conflict => {}
            Err(e) => return Err(e),
        }
    }
    Err(WireError::conflict(format!("{id}'s history mark kept changing ({RACES} writes in a row)")))
}

/// `slot` (an object, or `{}`) with `extra`'s keys set over it.
pub(crate) fn merged(slot: &Value, extra: &Value) -> Value {
    let mut v = Some(slot.clone()).filter(Value::is_object).unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    v
}

/// `runtime.create`: a task forked from `of` (a resumed one).
pub(crate) async fn create_fork(ctx: &Ctx, call: &Call, prompt: String, title: String, cwd: String, of: String) -> Result<String> {
    let a = r::StartArgs {
        prompt,
        title: Some(title),
        cwd: Some(cwd),
        lineage: Lineage { fork_of: Some(of), ..Lineage::default() },
        ..r::StartArgs::default()
    };
    ctx.run::<r::Create>(call, a).await.map(|c| c.id.as_str().to_owned())
}

/// `share.preview` at `level` (`spec` | `report` | `full`; anything else is refused).
pub(crate) async fn preview(ctx: &Ctx, call: &Call, id: &str, level: &str) -> Result<Preview> {
    let level: Level = serde_json::from_value(Value::String(level.to_owned()))
        .map_err(|_| WireError::invalid(format!("no share level `{level}` (spec | report | full)")))?;
    ctx.run::<PreviewCmd>(call, ShareArgs { id: id.to_owned(), level }).await
}

/// A follow-up call that was refused: logged.
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "history: {what}");
    }
}
