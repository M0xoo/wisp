//! The `router` resource kind (ADR-0028): Auto's settings as one object (`router:` in a formula), read
//! from `router.view` and written with `router.set`. What the router learned stays data.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Ctx, Result};
use wisp_resources_api::{KindInfo, Op, OpKind, Resource, ResourceKind, schema_of};

/// How Auto picks a harness and model for a task.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RouterSpec {
    /// what it optimises for (`balanced`, `cheap`, `best`, …)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// try models it knows less about now and then
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explore: Option<bool>,
    /// the harnesses it may pick (null: every one)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<String>>,
    /// harnesses or models it never picks
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<Vec<String>>,
    /// ones it picks first when they fit
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefer: Option<Vec<String>>,
    /// learn from what you pick by hand
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub habits: Option<bool>,
    /// a failed run goes again on a stronger model
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalate: Option<bool>,
    /// hard tasks run twice and the better answer is kept
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub best2: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scout: Option<Value>,
}

#[derive(Debug)]
pub struct RouterKind {
    pub ctx: Ctx,
}

impl ResourceKind for RouterKind {
    fn info(&self) -> KindInfo {
        KindInfo::new("router", "router", wisp_router_api::PLUGIN_ID, schema_of::<RouterSpec>()).singleton().order(30)
    }

    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        Box::pin(async move {
            let v = self.ctx.run_json(call, "router.view", json!({})).await?;
            let mut spec = v.get("settings").cloned().unwrap_or_else(|| json!({}));
            if let Some(o) = spec.as_object_mut() {
                o.insert("goal".into(), v.get("goal").cloned().unwrap_or(Value::Null));
                o.retain(|k, x| {
                    !x.is_null()
                        && ["goal", "explore", "allowed", "blocked", "prefer", "habits", "escalate", "best2", "scout"].contains(&k.as_str())
                });
            }
            Ok(vec![Resource::new("router", "default", spec)])
        })
    }

    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if op.op == OpKind::Delete {
                return Ok(());
            }
            self.ctx.run_json(call, "router.set", op.spec.clone()).await.map(|_| ())
        })
    }
}
