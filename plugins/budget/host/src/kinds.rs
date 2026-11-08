//! wisp.budget's resource kind (ADR-0028): Automations stop at, per harness, and spend caps (`budget:`
//! in a formula, one object). The stop lines are applied through `budget.setStop`; the spec is kept as
//! declared (`StoredKind`) so export gives back what was declared.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Result, Setup};
use wisp_resources_api::{KindInfo, Op, OpKind, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// Where unattended work stops on a usage window, and what a task or workflow may spend.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetSpec {
    /// off | 50 | 75 | 90: percent of a window where automations stop
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stop_at: String,
    /// Claude Code's own line (same | off | 50 | 75 | 90)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claude: String,
    /// Codex's own line (same | off | 50 | 75 | 90)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub codex: String,
    /// at most this many dollars per task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_usd: Option<f64>,
    /// warn when a window is about to drain
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_watch: Option<bool>,
}

struct BudgetKind(Arc<StoredKind>);

impl ResourceKind for BudgetKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let lines = [("stopAt", "autoStop", "off"), ("claude", "autoStopClaude", "same"), ("codex", "autoStopCodex", "same")];
            for (field, key, reset) in lines {
                let v = op.spec.get(field).and_then(Value::as_str).filter(|_| op.op != OpKind::Delete);
                let was = op.before.as_ref().and_then(|b| b.get(field)).is_some() || op.op == OpKind::Delete;
                if let Some(v) = v {
                    self.0.ctx.run_json(call, "budget.setStop", json!({ "key": key, "value": v })).await?;
                } else if was {
                    self.0.ctx.run_json(call, "budget.setStop", json!({ "key": key, "value": reset })).await?;
                }
            }
            self.0.apply(call, op).await
        })
    }
}

pub fn register(s: &mut Setup) {
    let info = KindInfo::new("budget", "budget", "wisp.budget", schema_of::<BudgetSpec>()).singleton().order(34);
    let k: Arc<dyn ResourceKind> = Arc::new(BudgetKind(Arc::new(StoredKind::new(info, s.ctx()))));
    s.contribute(&RESOURCE_KIND, k);
}
