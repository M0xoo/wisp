//! wisp.automations' `trigger` kind (ADR-0028): what starts tasks without you, each starting a declared task
//! (or a prompt). Kept as declared (`StoredKind`); sensitive. Running: `on: finished` (a task in its
//! project finished a turn) and `on: webhook` (`POST /api/triggers/<name>` with its `secret`, as
//! `x-wisp-secret`, a Bearer token or `?secret=`; the body is handed to the task). The watchers (`ci`,
//! `issues`), `slack` and `linear` are declared and kept until those are ported.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::TurnStatus;

/// A trigger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerSpec {
    /// ci | issues | finished | done | webhook | slack | linear
    pub on: String,
    /// the declared task it starts (its `{params}` from the event)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub task: String,
    /// or a prompt of its own
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub prompt: String,
    /// the project it watches
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project: String,
    /// a crew member gets the work instead of a new task
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crew: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// the issue label it waits for
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// minutes between GitHub polls
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every: Option<u32>,
    /// a webhook's signature secret, as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

type Cache = Arc<Mutex<Vec<(String, TriggerSpec)>>>;

struct TriggerKind {
    inner: Arc<StoredKind>,
    cache: Cache,
}

async fn refresh(inner: &StoredKind, cache: &Cache) {
    let list = inner.specs().await.unwrap_or_default().into_iter().filter_map(|(n, v)| Some((n, serde_json::from_value::<TriggerSpec>(v).ok()?))).collect();
    *cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
}

impl ResourceKind for TriggerKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn describe(&self, op: &Op) -> Option<String> {
        let on = op.spec.get("on").and_then(Value::as_str).unwrap_or("?");
        let what = op.spec.get("task").and_then(Value::as_str).filter(|t| !t.is_empty()).map_or_else(|| "a task".to_owned(), |t| format!("the task {t}"));
        Some(format!("starts {what} by itself on {on} ({})", op.name))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            refresh(&self.inner, &self.cache).await;
            Ok(())
        })
    }
}

/// Whether trigger `t` fires for a turn of a task in `cwd`, started by `by` (a task a trigger started
/// never fires its own trigger again: no loops).
/// A task a trigger or a pipeline started: no trigger fires for it (they'd start each other forever).
pub fn by_automation(by: &str) -> bool {
    by.starts_with("trigger:") || by.starts_with("pipeline:")
}

pub fn fires(name: &str, t: &TriggerSpec, cwd: &str, by: &str) -> bool {
    let root = t.project.trim_end_matches('/');
    t.on == "finished" && t.enabled != Some(false) && !by_automation(by) && by != format!("trigger:{name}") && (root.is_empty() || cwd == root || cwd.starts_with(&format!("{root}/")) || cwd.ends_with(&format!("/private{root}")))
}

/// A turn ended: every `finished` trigger of its project starts its task.
async fn on_finished(ctx: &Ctx, cache: &Cache, e: &TurnEnded) {
    if e.status != TurnStatus::Done {
        return;
    }
    let call = ctx.root_call();
    let Ok(task) = ctx.run_json(&call, "runtime.get", json!({ "id": e.session_id })).await else { return };
    let cwd = task.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
    let spec = ctx.run_json(&call, "runtime.spec", json!({ "id": e.session_id })).await.unwrap_or_default();
    let by = spec.pointer("/lineage/triggeredBy").and_then(Value::as_str).unwrap_or_default().to_owned();
    let due: Vec<(String, TriggerSpec)> = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|(n, t)| fires(n, t, &cwd, &by)).cloned().collect();
    for (name, t) in due {
        let by = format!("trigger:{name}");
        let out = if t.task.is_empty() {
            ctx.run_json(&call, "runtime.create", json!({ "prompt": t.prompt, "cwd": cwd, "lineage": { "triggeredBy": by } })).await
        } else {
            let Ok(store) = ctx.service::<wisp_store::Store>() else { continue };
            crate::run_by(ctx, &call, &store, &t.task, &cwd, &by).await
        };
        if let Err(err) = out {
            tracing::warn!(trigger = %name, "didn't start: {}", err.message);
        }
    }
}

/// `${secret:NAME}` read from secrets; a literal stays as it is.
async fn secret_of(ctx: &Ctx, v: &str) -> Option<String> {
    let name = v.strip_prefix("${secret:").and_then(|r| r.strip_suffix('}'));
    match name {
        Some(n) => wisp_kernel::services::secrets(ctx).ok()?.get(n).await.ok().flatten(),
        None => Some(v.to_owned()).filter(|v| !v.is_empty()),
    }
}

fn same(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq as _;
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn answer(status: u16, body: Value) -> wisp_kernel::http::Response {
    wisp_kernel::http::Response::Json { status, body }
}

/// `POST /api/triggers/:name`: an open route, so the secret is the only key. A wrong or missing one,
/// an unknown or off trigger, and a trigger with no secret all answer the same 404.
async fn webhook(ctx: Ctx, cache: Cache, req: wisp_kernel::http::Request) -> Result<wisp_kernel::http::Response> {
    let name = req.param("name").unwrap_or_default().to_owned();
    let gone = || Ok(answer(404, json!({ "error": "no such trigger" })));
    let Some(t) = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().find(|(n, t)| *n == name && t.on == "webhook" && t.enabled != Some(false)).map(|(_, t)| t.clone()) else { return gone() };
    let Some(want) = secret_of(&ctx, &t.secret).await else { return gone() };
    let given = req.header("x-wisp-secret").map(str::to_owned).or_else(|| req.header("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(str::to_owned)).or_else(|| req.query("secret").map(str::to_owned)).unwrap_or_default();
    if !same(&given, &want) {
        return gone();
    }
    let call = ctx.root_call();
    let by = format!("trigger:{name}");
    let sent: String = String::from_utf8_lossy(&req.body).chars().take(4000).collect();
    let made = if t.task.is_empty() {
        let prompt = if sent.trim().is_empty() { t.prompt.clone() } else { format!("{}\n\nThe webhook sent:\n{sent}", t.prompt) };
        ctx.run_json(&call, "runtime.create", json!({ "prompt": prompt, "cwd": t.project, "lineage": { "triggeredBy": by } })).await
    } else {
        let store = ctx.service::<wisp_store::Store>()?;
        crate::run_by(&ctx, &call, &store, &t.task, &t.project, &by).await
    };
    match made {
        Ok(m) => Ok(answer(202, json!({ "id": m.get("id") }))),
        Err(e) => Ok(answer(e.status(), json!({ "error": e.message }))),
    }
}

pub fn register(s: &mut Setup) {
    let inner = Arc::new(StoredKind::new(KindInfo::new("trigger", "triggers", "wisp.automations", schema_of::<TriggerSpec>()).order(85).sensitive(), s.ctx()));
    let cache: Cache = Arc::default();
    let k: Arc<dyn ResourceKind> = Arc::new(TriggerKind { inner: inner.clone(), cache: cache.clone() });
    s.contribute(&RESOURCE_KIND, k);
    let c2 = cache.clone();
    s.on::<TurnEnded, _, _>(move |ctx, e| {
        let cache = c2.clone();
        let e = e.clone();
        let ctx2 = ctx.clone();
        ctx.spawn(async move {
            on_finished(&ctx2, &cache, &e).await;
        });
        async {}
    });
    let hooks = cache.clone();
    s.route(wisp_kernel::http::Route {
        method: "POST",
        pattern: "/api/triggers/:name",
        permission: wisp_kernel::http::OPEN,
        doc: true,
        summary: "Start a webhook trigger's task (its secret as x-wisp-secret)",
        raw: true,
        max_body: Some(256 * 1024),
        handler: Arc::new(move |ctx, _call, req| {
            let cache = hooks.clone();
            Box::pin(async move { webhook(ctx, cache, req).await })
        }),
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
    fn a_finished_trigger_fires_for_its_project_and_never_for_its_own_tasks() {
        let t = TriggerSpec { on: "finished".into(), project: "/w/api".into(), task: "review".into(), ..TriggerSpec::default() };
        assert!(fires("rev", &t, "/w/api", "hand"));
        assert!(fires("rev", &t, "/w/api/src", ""));
        assert!(!fires("rev", &t, "/w/web", ""));
        assert!(!fires("rev", &t, "/w/api", "trigger:rev"), "no loop");
        assert!(!fires("rev", &t, "/w/api", "trigger:other") && !fires("rev", &t, "/w/api", "pipeline:default"), "nor one through another automation");
        assert!(!fires("rev", &TriggerSpec { on: "ci".into(), ..t.clone() }, "/w/api", ""));
    }
}
