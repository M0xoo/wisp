//! wisp.router's `pipeline` kind (ADR-0028): what happens after a run (v1 conductor/pipeline.js): escalate
//! on error, move on at a limit, best-of-N with a judge, a review.
//!
//! Acted on after each turn (`TurnEnded`), for the pipeline the task's agent profile names (a pipeline
//! with the profile's name), else `default`:
//! - **onError** `retry` asks the task to try again once; `escalate` tries again once at high effort;
//! - **review** starts a task by that agent profile reviewing what the run did (never for a review).
//!
//! `atLimit`, `bestOf` and `judge` are kept as declared: the account switch at a limit is accounts', and
//! best-of-N needs runs side by side (compare), both not ported yet.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::TurnStatus;

/// The steps after a run, by name (a task or a workflow step names one: `pipeline: careful`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipelineSpec {
    /// on an error: escalate (a stronger model) | retry | stop
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub on_error: String,
    /// at a usage limit: next (another account or harness) | wait
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub at_limit: String,
    /// run it this many times and keep the best
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best_of: Option<u32>,
    /// the agent profile that picks the best, or reviews
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub judge: String,
    /// a review by this agent profile after each run
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub review: String,
}

/// Who a pipeline's own follow-ups and tasks are by: never acted on again (no loop).
pub const BY: &str = "pipeline";

type Cache = Arc<Mutex<Vec<(String, PipelineSpec)>>>;

/// What a pipeline does after a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// try again; `true`: at high effort
    Again(bool),
    /// a review task by this profile
    Review(String),
}

/// The step `p` takes after a turn that ended `status`, by `by` (the turn's), in a task from `from`.
pub fn next(p: &PipelineSpec, status: TurnStatus, by: &str, from: &str) -> Option<Next> {
    if by == BY || from.starts_with("pipeline:") || from.starts_with("trigger:") {
        return None;
    }
    match status {
        TurnStatus::Error if p.on_error == "retry" => Some(Next::Again(false)),
        TurnStatus::Error if p.on_error == "escalate" => Some(Next::Again(true)),
        TurnStatus::Done if !p.review.is_empty() => Some(Next::Review(p.review.clone())),
        _ => None,
    }
}

/// The pipeline for a task of `profile`: the one with its name, else `default`.
fn pick(cache: &Cache, profile: &str) -> Option<(String, PipelineSpec)> {
    let all = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    [profile, "default"].iter().filter(|n| !n.is_empty()).find_map(|n| all.iter().find(|(m, _)| m == n).cloned())
}

async fn after(ctx: &Ctx, cache: &Cache, e: &TurnEnded) {
    let call = ctx.root_call();
    let id = e.session_id.as_str();
    let Ok(spec) = ctx.run_json(&call, "runtime.spec", json!({ "id": id })).await else { return };
    let Some((name, p)) = pick(cache, spec.get("agent").and_then(Value::as_str).unwrap_or_default()) else { return };
    let turns = ctx.run_json(&call, "runtime.turns", json!({ "id": id })).await.unwrap_or_default();
    let by = turns.as_array().and_then(|t| t.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(e.turn_id.as_str()))).and_then(|t| t.get("by")).and_then(Value::as_str).unwrap_or_default().to_owned();
    let from = spec.pointer("/lineage/triggeredBy").and_then(Value::as_str).unwrap_or_default();
    let out = match next(&p, e.status, &by, from) {
        None => return,
        Some(Next::Again(high)) => {
            let why = e.error_text.as_deref().unwrap_or("it stopped with an error");
            let mut a = json!({ "id": id, "text": format!("The last run failed ({why}). Try again."), "by": BY });
            if high {
                a["run"] = json!({ "effort": "high" });
            }
            ctx.run_json(&call, "runtime.followUp", a).await
        }
        Some(Next::Review(agent)) => {
            let task = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await.unwrap_or_default();
            let title = task.get("title").and_then(Value::as_str).unwrap_or_default();
            let prompt = format!("Review what the task \"{title}\" ({id}) just changed in this folder: correctness first, then risks. Report what to fix.");
            ctx.run_json(&call, "runtime.create", json!({ "prompt": prompt, "cwd": task.get("cwd"), "agent": agent, "lineage": { "triggeredBy": format!("pipeline:{name}") } })).await
        }
    };
    if let Err(err) = out {
        tracing::warn!(pipeline = %name, "didn't act: {}", err.message);
    }
}

struct PipelineKind {
    inner: Arc<StoredKind>,
    cache: Cache,
}

async fn refresh(inner: &StoredKind, cache: &Cache) {
    let list = inner.specs().await.unwrap_or_default().into_iter().filter_map(|(n, v)| Some((n, serde_json::from_value::<PipelineSpec>(v).ok()?))).collect();
    *cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
}

impl ResourceKind for PipelineKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            refresh(&self.inner, &self.cache).await;
            Ok(())
        })
    }
}

pub fn register_pipeline(s: &mut Setup) {
    let inner = Arc::new(StoredKind::new(KindInfo::new("pipeline", "pipelines", "wisp.router", schema_of::<PipelineSpec>()).order(32), s.ctx()));
    let cache: Cache = Arc::default();
    let k: Arc<dyn ResourceKind> = Arc::new(PipelineKind { inner: inner.clone(), cache: cache.clone() });
    s.contribute(&RESOURCE_KIND, k);
    let c2 = cache.clone();
    s.on::<TurnEnded, _, _>(move |ctx, e| {
        let (cache, e, ctx2) = (c2.clone(), e.clone(), ctx.clone());
        if !cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty() {
            ctx.spawn(async move { after(&ctx2, &cache, &e).await });
        }
        async {}
    });
    s.on_start(move |_ctx| async move {
        refresh(&inner, &cache).await;
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipeline_retries_escalates_and_reviews_once() {
        let p = PipelineSpec { on_error: "escalate".into(), review: "reviewer".into(), ..PipelineSpec::default() };
        assert_eq!(next(&p, TurnStatus::Error, "you", ""), Some(Next::Again(true)));
        assert_eq!(next(&PipelineSpec { on_error: "retry".into(), ..p.clone() }, TurnStatus::Error, "you", ""), Some(Next::Again(false)));
        assert_eq!(next(&p, TurnStatus::Done, "you", ""), Some(Next::Review("reviewer".into())));
        assert_eq!(next(&p, TurnStatus::Error, BY, ""), None, "its own retry isn't retried");
        assert_eq!(next(&p, TurnStatus::Done, "you", "pipeline:default"), None, "a review isn't reviewed");
        assert_eq!(next(&p, TurnStatus::Done, "you", "trigger:after"), None, "nor a trigger's task (no ping-pong)");
        assert_eq!(next(&PipelineSpec::default(), TurnStatus::Error, "you", ""), None);
    }
}
