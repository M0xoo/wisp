//! wisp.mcp's resource kind (ADR-0028): which of wisp's own MCP tools agents get, per agent profile or
//! mode (`tools:` in a formula, named by the profile or mode). Acted on: a task whose agent profile (or,
//! failing that, its mode) has a `tools` spec is offered only what it allows in `tools/list`, and a
//! `tools/call` for anything else is refused. Kept in a cache refreshed on apply and at start.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// wisp's tools for one agent profile or mode (its name): what it gets and what it doesn't.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolsSpec {
    /// tool names (`wisp_ask`, `wisp_delegate`, `wisp_*`); empty: every one
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// tool names it never gets
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}

/// `wisp_*` matches by prefix, anything else by name.
fn matches(pat: &str, name: &str) -> bool {
    pat.strip_suffix('*').map_or(pat == name, |p| name.starts_with(p))
}

impl ToolsSpec {
    pub fn allows(&self, name: &str) -> bool {
        (self.allow.is_empty() || self.allow.iter().any(|p| matches(p, name))) && !self.deny.iter().any(|p| matches(p, name))
    }
}

/// The declared specs, by profile or mode name.
#[derive(Debug, Default, Clone)]
pub struct Tools(Arc<Mutex<Vec<(String, ToolsSpec)>>>);

impl Tools {
    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty()
    }
    /// The spec for a run of `profile` in `mode` (the profile's first).
    pub fn for_run(&self, profile: &str, mode: &str) -> Option<ToolsSpec> {
        let all = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        [profile, mode].iter().filter(|n| !n.is_empty()).find_map(|n| all.iter().find(|(m, _)| m == n).map(|(_, s)| s.clone()))
    }
    async fn refresh(&self, inner: &StoredKind) {
        let list = inner
            .specs()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(n, v)| serde_json::from_value(v).ok().map(|s| (n, s)))
            .collect();
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
    }
}

/// A `tools/list` result with only what `spec` allows (the text as it was when nothing goes).
pub fn filter_list(text: &str, spec: &ToolsSpec) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(text) else { return text.to_owned() };
    let Some(tools) = v.pointer_mut("/result/tools").and_then(Value::as_array_mut) else { return text.to_owned() };
    let before = tools.len();
    tools.retain(|t| t.get("name").and_then(Value::as_str).is_some_and(|n| spec.allows(n)));
    if tools.len() == before { text.to_owned() } else { v.to_string() }
}

struct ToolsKind {
    inner: Arc<StoredKind>,
    cache: Tools,
}

impl ResourceKind for ToolsKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            self.cache.refresh(&self.inner).await;
            Ok(())
        })
    }
}

pub fn register(s: &mut Setup) -> Tools {
    let inner = Arc::new(StoredKind::new(KindInfo::new("tools", "tools", "wisp.mcp", schema_of::<ToolsSpec>()).order(22), s.ctx()));
    let cache = Tools::default();
    let k: Arc<dyn ResourceKind> = Arc::new(ToolsKind { inner: inner.clone(), cache: cache.clone() });
    s.contribute(&RESOURCE_KIND, k);
    let c = cache.clone();
    s.on_start(move |_ctx| async move {
        c.refresh(&inner).await;
        Ok(())
    });
    cache
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_spec_narrows_the_list_and_the_profile_wins_over_the_mode() {
        let spec = ToolsSpec { allow: vec!["wisp_a*".into()], deny: vec!["wisp_ask".into()] };
        assert!(spec.allows("wisp_answer") && !spec.allows("wisp_ask") && !spec.allows("wisp_delegate"));
        let list = json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": [{ "name": "wisp_ask" }, { "name": "wisp_answer" }, { "name": "wisp_delegate" }] } }).to_string();
        let out: Value = serde_json::from_str(&filter_list(&list, &spec)).unwrap_or_default();
        assert_eq!(out["result"]["tools"], json!([{ "name": "wisp_answer" }]));
        let t = Tools::default();
        *t.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            vec![("plan".into(), ToolsSpec::default()), ("reviewer".into(), spec.clone())];
        assert_eq!(t.for_run("reviewer", "plan"), Some(spec));
        assert_eq!(t.for_run("other", "plan"), Some(ToolsSpec::default()));
        assert_eq!(t.for_run("other", "edits"), None);
    }
}
