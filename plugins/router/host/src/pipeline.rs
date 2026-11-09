//! wisp.router's `pipeline` kind (ADR-0028): what happens after a run (v1 conductor/pipeline.js): escalate
//! on error, move on at a limit, best-of-N with a judge, a review.
//!
//! Acted on after each turn (`TurnEnded`), for the pipeline the task's agent profile names (a pipeline
//! with the profile's name), else `default`:
//! - **atLimit** `next`: a run that hit its usage limit carries on, once, on another harness that's there
//!   (`wait`, the default, leaves it to the limit's own hold);
//! - **onError** `retry` asks the task to try again once; `escalate` tries again once at high effort;
//! - **bestOf** N: after the first turn, N−1 more runs of the same ask side by side, then the **judge**
//!   (an agent profile or harness; else the task's) picks the best (`ext["wisp.router"].bestOf`);
//! - **review** starts a task by that agent profile reviewing what the run did (never for a review).

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
    /// carry on on another harness (a usage limit)
    Switch,
    /// N runs in all, judged by this (empty: the task's own harness)
    BestOf(u32, String),
}

/// A run that stopped at its usage limit says so (Claude Code, Codex, Gemini's words).
pub fn hit_limit(error: Option<&str>) -> bool {
    let e = error.unwrap_or_default().to_ascii_lowercase();
    ["usage limit", "rate limit", "limit reached", "quota"].iter().any(|w| e.contains(w))
}

/// The judge's pick among `n`: the first number 1..=n it says (1 when it says none).
pub fn winner(answer: &str, n: usize) -> usize {
    answer.split(|c: char| !c.is_ascii_digit()).filter_map(|w| w.parse::<usize>().ok()).find(|k| (1..=n).contains(k)).unwrap_or(1)
}

/// What a turn was: how it ended, who started it, what started its task, its error, whether it's the first.
#[derive(Debug, Clone, Copy)]
pub struct Ended<'a> {
    pub status: TurnStatus,
    pub by: &'a str,
    pub from: &'a str,
    pub error: Option<&'a str>,
    pub first: bool,
}

/// The step `p` takes after a turn.
pub fn next(p: &PipelineSpec, t: Ended<'_>) -> Option<Next> {
    if t.by == BY || t.from.starts_with("pipeline:") || t.from.starts_with("trigger:") {
        return None;
    }
    let status = t.status;
    if status == TurnStatus::Error && p.at_limit == "next" && hit_limit(t.error) {
        return Some(Next::Switch);
    }
    if status == TurnStatus::Done && t.first && p.best_of.is_some_and(|n| n >= 2) {
        return Some(Next::BestOf(p.best_of.unwrap_or(2), p.judge.clone()));
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
    let this = turns.as_array().and_then(|t| t.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(e.turn_id.as_str())).cloned()).unwrap_or_default();
    let by = this.get("by").and_then(Value::as_str).unwrap_or_default().to_owned();
    let from = spec.pointer("/lineage/triggeredBy").and_then(Value::as_str).unwrap_or_default();
    let ended = Ended { status: e.status, by: &by, from, error: e.error_text.as_deref(), first: this.get("idx").and_then(Value::as_u64) == Some(0) };
    let out = match next(&p, ended) {
        None => return,
        Some(Next::Switch) => switch(ctx, id, &e.agent).await,
        Some(Next::BestOf(n, judge)) => best_of(ctx, &name, id, &spec, n, &judge).await,
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

/// Carries on on the first other harness that's there.
async fn switch(ctx: &Ctx, id: &str, was: &str) -> Result<Value> {
    let call = ctx.root_call();
    let agents = ctx.run_json(&call, "runtime.agents", json!({})).await?;
    let Some(other) = agents.as_array().and_then(|l| l.iter().find(|a| a["available"] == true && a["id"] != was)).and_then(|a| a["id"].as_str()).map(str::to_owned) else {
        return Ok(Value::Null);
    };
    let text = format!("{was} hit its usage limit. Carry on from where it stopped.");
    ctx.run_json(&call, "runtime.followUp", json!({ "id": id, "text": text, "by": BY, "run": { "agent": other } })).await
}

/// N−1 more runs of the same ask, all waited for, then the judge's pick.
async fn best_of(ctx: &Ctx, name: &str, id: &str, spec: &Value, n: u32, judge: &str) -> Result<Value> {
    let call = ctx.root_call();
    let mut runs = vec![id.to_owned()];
    for _ in 1..n.min(8) {
        let a = json!({ "prompt": spec.get("prompt"), "cwd": spec.get("cwd"), "agent": spec.get("agent"), "lineage": { "triggeredBy": format!("pipeline:{name}") } });
        let made = ctx.run_json(&call, "runtime.create", a).await?;
        runs.push(made.get("id").and_then(Value::as_str).unwrap_or_default().to_owned());
    }
    let clock = ctx.clock()?;
    let until = clock.now_ms() + 30 * 60_000;
    let mut answers = Vec::new();
    for r in &runs {
        loop {
            let t = ctx.run_json(&call, "runtime.get", json!({ "id": r })).await?;
            if t.get("state").and_then(Value::as_str) != Some("running") || clock.now_ms() > until {
                break;
            }
            clock.sleep(500).await;
        }
        let turns = ctx.run_json(&call, "runtime.turns", json!({ "id": r })).await.unwrap_or_default();
        let text: String = turns.as_array().and_then(|t| t.last()).and_then(|t| t.get("text")).and_then(Value::as_str).unwrap_or_default().chars().take(3000).collect();
        answers.push(text);
    }
    let list: Vec<String> = answers.iter().enumerate().map(|(i, a)| format!("## Run {}\n{a}", i + 1)).collect();
    let prompt = format!("These are {} runs of the same task: \"{}\". Which did it best? Answer with its number first, then one line why.\n\n{}", runs.len(), spec.get("prompt").and_then(Value::as_str).unwrap_or_default(), list.join("\n\n"));
    let pick = if judge.is_empty() { json!({ "agent": spec.get("agent") }) } else { json!({ "agent": judge }) };
    let said = ctx.run_json(&call, "runtime.quick", json!({ "prompt": prompt, "cwd": spec.get("cwd"), "pick": pick, "timeoutMs": 300_000 })).await.map(|r| r.get("text").and_then(Value::as_str).unwrap_or_default().to_owned()).unwrap_or_default();
    let best = runs.get(winner(&said, runs.len()) - 1).cloned().unwrap_or_default();
    let why: String = said.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().chars().take(300).collect();
    ctx.run_json(&call, "runtime.setExt", json!({ "id": id, "plugin": "wisp.router", "value": { "bestOf": { "runs": runs, "winner": best, "why": why } } })).await
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
        let t = |status, by, from| Ended { status, by, from, error: None, first: false };
        let p = PipelineSpec { on_error: "escalate".into(), review: "reviewer".into(), ..PipelineSpec::default() };
        assert_eq!(next(&p, t(TurnStatus::Error, "you", "")), Some(Next::Again(true)));
        assert_eq!(next(&PipelineSpec { on_error: "retry".into(), ..p.clone() }, t(TurnStatus::Error, "you", "")), Some(Next::Again(false)));
        assert_eq!(next(&p, t(TurnStatus::Done, "you", "")), Some(Next::Review("reviewer".into())));
        assert_eq!(next(&p, t(TurnStatus::Error, BY, "")), None, "its own retry isn't retried");
        assert_eq!(next(&p, t(TurnStatus::Done, "you", "pipeline:default")), None, "a review isn't reviewed");
        assert_eq!(next(&p, t(TurnStatus::Done, "you", "trigger:after")), None, "nor a trigger's task (no ping-pong)");
        assert_eq!(next(&PipelineSpec::default(), t(TurnStatus::Error, "you", "")), None);
        // at a limit: another harness, before onError; best of N after the first turn only
        let lim = PipelineSpec { at_limit: "next".into(), best_of: Some(3), judge: "reviewer".into(), ..p.clone() };
        assert_eq!(next(&lim, Ended { error: Some("Claude AI usage limit reached|1767225600"), ..t(TurnStatus::Error, "you", "") }), Some(Next::Switch));
        assert_eq!(next(&lim, Ended { first: true, ..t(TurnStatus::Done, "you", "") }), Some(Next::BestOf(3, "reviewer".into())));
        assert_eq!(next(&lim, t(TurnStatus::Done, "you", "")), Some(Next::Review("reviewer".into())), "later turns: the review");
        assert_eq!((winner("Run 2 did it best", 3), winner("none", 3), winner("9", 3)), (2, 1, 1));
    }
}
