//! wisp.plugins' resource kind (ADR-0028): which plugins are on, their config, and users' plugins (a path,
//! gist or URL, a version pin). `enabled` is acted on: applying it switches the plugin on or off through
//! the kernel, and the stored state is put back at start (removing the resource switches it back on).
//! `source`, `version` and `config` are kept as declared until installing users' plugins lands.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// A plugin by its id (`wisp.telegram`, `user.mine`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PluginSpec {
    /// on or off
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// where a user's plugin comes from: a path, `gist:<id>` or a URL
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// the version it stays on
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    /// its own configuration
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

fn enabled(spec: &Value) -> Option<bool> {
    spec.get("enabled").and_then(Value::as_bool)
}

/// What the kernel should do for this op: `Some(on)`, or nothing when it doesn't say.
fn wanted(op: &Op) -> Option<bool> {
    if op.op == OpKind::Delete { Some(true) } else { enabled(&op.spec) }
}

struct PluginKind(Arc<StoredKind>);

impl ResourceKind for PluginKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn describe(&self, op: &Op) -> Option<String> {
        wanted(op).map(|on| format!("switches {} {}", op.name, if on { "on" } else { "off" }))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if let Some(on) = wanted(op) {
                // the kernel refuses an unknown plugin or wisp.plugins itself: nothing is stored then.
                crate::find(&self.0.ctx, &op.name)?;
                self.0.ctx.set_plugin_enabled(&op.name, on).await?;
            }
            self.0.apply(call, op).await
        })
    }
}

async fn put_back(ctx: &Ctx, inner: &StoredKind) {
    for (name, spec) in inner.specs().await.unwrap_or_default() {
        if enabled(&spec) == Some(false)
            && let Err(e) = ctx.set_plugin_enabled(&name, false).await
        {
            tracing::warn!(plugin = %name, "not switched off: {}", e.message);
        }
    }
}

pub fn register(s: &mut Setup) {
    let inner = Arc::new(StoredKind::new(KindInfo::new("plugin", "plugins", "wisp.plugins", schema_of::<PluginSpec>()).order(2).sensitive(), s.ctx()));
    let k: Arc<dyn ResourceKind> = Arc::new(PluginKind(inner.clone()));
    s.contribute(&RESOURCE_KIND, k);
    s.on_start(move |ctx| async move {
        put_back(&ctx, &inner).await;
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delete_switches_back_on_and_a_silent_spec_does_nothing() {
        let op = |op, spec| Op { op, kind: "plugin".into(), name: "wisp.x".into(), spec, id: None, changes: vec![], before: None };
        assert_eq!(wanted(&op(OpKind::Create, json!({ "enabled": false }))), Some(false));
        assert_eq!(wanted(&op(OpKind::Create, json!({ "version": "1" }))), None);
        assert_eq!(wanted(&op(OpKind::Delete, json!({}))), Some(true));
    }
}
