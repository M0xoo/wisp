//! wisp.connectors' resource kind (ADR-0028): the MCP servers agents get. Kept as declared (`StoredKind`)
//! and given to runs through `runtime.run@1`: a connector goes to a run when it's on, its `agents` list
//! names the task's agent profile (or is empty) and its `modes` the task's mode (or is empty), or when
//! the task names it. `${secret:NAME}` in its env and headers is read from secrets when it's applied
//! (and at start), so a run never waits on it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};
use wisp_runtime_api::model::Session;
use wisp_runtime_api::points::{McpQuery, RUN, RunPart};

/// An MCP server: a command wisp starts, or a URL it reaches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorSpec {
    /// the program (stdio servers)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// the server's URL (HTTP servers)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// its environment; secrets as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// HTTP headers; secrets as `${secret:NAME}`
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// the agent profiles that get it (empty: every one)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    /// the modes that get it (plan, edits, auto; empty: all)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
    /// off: declared but no agent gets it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// it signs in with OAuth (the token stays in secrets)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<bool>,
}

/// The connectors as runs get them: (name, spec with secrets read).
type Cache = Arc<Mutex<Vec<(String, ConnectorSpec)>>>;

struct ConnectorKind {
    inner: Arc<StoredKind>,
    cache: Cache,
}

/// `${secret:NAME}` read from secrets (an unknown one stays as it is: the plan said so already).
pub(crate) async fn reveal(ctx: &Ctx, text: &str) -> String {
    let mut out = text.to_owned();
    let Ok(secrets) = wisp_kernel::services::secrets(ctx) else { return out };
    while let Some(a) = out.find("${secret:") {
        let Some(b) = out[a..].find('}') else { break };
        let name = out[a + 9..a + b].to_owned();
        let Ok(Some(v)) = secrets.get(&name).await else { break };
        out.replace_range(a..=a + b, &v);
    }
    out
}

/// Reads every stored connector into the cache, secrets read.
async fn refresh(inner: &StoredKind, cache: &Cache) {
    let mut list = Vec::new();
    for (name, v) in inner.specs().await.unwrap_or_default() {
        let Ok(mut c) = serde_json::from_value::<ConnectorSpec>(v) else { continue };
        for x in c.env.values_mut().chain(c.headers.values_mut()) {
            *x = reveal(&inner.ctx, x).await;
        }
        // signed in (Settings → Connectors): the token goes as a bearer header
        if c.oauth == Some(true) && !c.headers.contains_key("Authorization") {
            let t = reveal(&inner.ctx, &format!("${{secret:{}:token}}", wisp_connectors_api::secrets_ns(&name))).await;
            if !t.starts_with("${secret:") {
                c.headers.insert("Authorization".into(), format!("Bearer {t}"));
            }
        }
        list.push((name, c));
    }
    *cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
}

impl ResourceKind for ConnectorKind {
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

/// A connector as a harness's MCP config takes it.
pub fn server_of(c: &ConnectorSpec) -> Value {
    if c.url.is_empty() {
        json!({ "type": "stdio", "command": c.command, "args": c.args, "env": c.env })
    } else {
        json!({ "type": "http", "url": c.url, "headers": c.headers })
    }
}

/// Whether a run of `profile` in `mode`, naming `named`, gets connector `c` called `name`.
pub fn gets(name: &str, c: &ConnectorSpec, profile: &str, mode: &str, named: &[String]) -> bool {
    if c.enabled == Some(false) {
        return false;
    }
    named.iter().any(|n| n == name) || ((c.agents.is_empty() || c.agents.iter().any(|a| a == profile)) && (c.modes.is_empty() || c.modes.iter().any(|m| m == mode)))
}

/// A `wisp run --formula` overlay's connectors with their `${secret:}` read, by task: in memory only (a
/// secret never goes in the task's row), filled by `before:run` and dropped when the plugin stops.
type Revealed = Arc<Mutex<std::collections::HashMap<String, Vec<(String, ConnectorSpec)>>>>;

struct Runs(Cache, Revealed);

impl RunPart for Runs {
    fn id(&self) -> &'static str {
        "wisp.connectors"
    }
    fn mcp_servers(&self, session: &Session, q: &McpQuery) -> BTreeMap<String, Value> {
        let spec = session.ext.get("wisp.runtime").and_then(|m| m.get("spec"));
        let profile = spec.and_then(|s| s.get("agent")).and_then(Value::as_str).unwrap_or_default();
        let named: Vec<String> = spec.and_then(|s| s.get("connectors")).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let mode = serde_json::to_value(q.mode).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        // a `wisp run --formula` overlay's connectors first: they're this task's alone
        let only = self.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(session.id.as_str()).cloned().unwrap_or_else(|| overlay_of(session.ext.get("wisp.runtime")));
        let mut out: BTreeMap<String, Value> = only.iter().filter(|(n, c)| gets(n, c, profile, &mode, &named)).map(|(n, c)| (n.clone(), server_of(c))).collect();
        for (n, c) in self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|(n, c)| gets(n, c, profile, &mode, &named)) {
            out.entry(n.clone()).or_insert_with(|| server_of(c));
        }
        out
    }
}

/// The overlay's connectors as the task carries them (secrets still `${secret:NAME}`).
fn overlay_of(own: Option<&Value>) -> Vec<(String, ConnectorSpec)> {
    own.and_then(|m| m.get("connectors")).and_then(Value::as_object).into_iter().flatten().filter_map(|(n, v)| Some((n.clone(), serde_json::from_value(v.clone()).ok()?))).collect()
}

/// Before a run of a task with overlay connectors: their secrets read into memory.
async fn reveal_overlay(ctx: &Ctx, call: &Call, revealed: &Revealed, session: &str) {
    if revealed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains_key(session) {
        return;
    }
    let Ok(task) = ctx.run_json(call, "runtime.get", json!({ "id": session })).await else { return };
    let mut list = overlay_of(task.pointer("/ext/wisp.runtime"));
    if list.is_empty() {
        return;
    }
    for (_, c) in &mut list {
        for x in c.env.values_mut().chain(c.headers.values_mut()) {
            *x = reveal(ctx, x).await;
        }
    }
    revealed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(session.to_owned(), list);
}

pub fn register(s: &mut Setup) -> (Arc<StoredKind>, Arc<dyn ResourceKind>) {
    let inner = Arc::new(StoredKind::new(KindInfo::new("connector", "connectors", "wisp.connectors", schema_of::<ConnectorSpec>()).order(18), s.ctx()));
    let cache: Cache = Arc::default();
    let k: Arc<dyn ResourceKind> = Arc::new(ConnectorKind { inner: inner.clone(), cache: cache.clone() });
    s.contribute(&RESOURCE_KIND, k.clone());
    let out = (inner.clone(), k);
    let revealed: Revealed = Arc::default();
    let runs: Arc<dyn RunPart> = Arc::new(Runs(cache.clone(), revealed.clone()));
    s.contribute(&RUN, runs);
    s.intercept::<wisp_runtime_api::hooks::BeforeRun, _, _>(wisp_kernel::InterceptOpts { priority: 60, failure: wisp_kernel::Failure::Open, timeout_ms: 2000 }, move |ctx, call, c| {
        let revealed = revealed.clone();
        async move {
            reveal_overlay(&ctx, &call, &revealed, c.session_id.as_str()).await;
            wisp_kernel::Verdict::Continue
        }
    });
    s.on_start(move |_ctx| async move {
        refresh(&inner, &cache).await;
        Ok(())
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn who_gets_a_connector() {
        let mut c = ConnectorSpec { url: "https://mcp.linear.app/sse".into(), agents: vec!["reviewer".into()], ..ConnectorSpec::default() };
        assert!(gets("linear", &c, "reviewer", "plan", &[]));
        assert!(!gets("linear", &c, "fixer", "plan", &[]));
        assert!(gets("linear", &c, "fixer", "plan", &["linear".into()]), "the task names it");
        c.enabled = Some(false);
        assert!(!gets("linear", &c, "reviewer", "plan", &[]));
        assert_eq!(server_of(&ConnectorSpec { command: "npx".into(), args: vec!["x".into()], ..ConnectorSpec::default() })["type"], "stdio");
    }
}
