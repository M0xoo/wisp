//! wisp.goal's resource kind (ADR-0028): the default judges and how they vote (v1 `goalJudges`,
//! `goalVote`), as one object (`goal:` in a formula). Acted on: a task's goal without its own judges,
//! vote or round limit takes these (kept in memory, refreshed on apply and at start).

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Call, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

/// How a goal is judged after each turn.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSpec {
    /// the agent profiles that judge
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub judges: Vec<String>,
    /// majority | all | any
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub vote: String,
    /// turns a goal may take before it stops and asks
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
}

pub type Defaults = Arc<Mutex<GoalSpec>>;

struct GoalKind {
    inner: Arc<StoredKind>,
    d: Defaults,
}

async fn refresh(inner: &StoredKind, d: &Defaults) {
    let spec =
        inner.specs().await.unwrap_or_default().into_iter().next().and_then(|(_, v)| serde_json::from_value(v).ok()).unwrap_or_default();
    *d.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = spec;
}

impl ResourceKind for GoalKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            refresh(&self.inner, &self.d).await;
            Ok(())
        })
    }
}

pub fn register(s: &mut Setup) -> Defaults {
    let inner =
        Arc::new(StoredKind::new(KindInfo::new("goal", "goal", "wisp.goal", schema_of::<GoalSpec>()).singleton().order(35), s.ctx()));
    let d: Defaults = Arc::default();
    let k: Arc<dyn ResourceKind> = Arc::new(GoalKind { inner: inner.clone(), d: d.clone() });
    s.contribute(&RESOURCE_KIND, k);
    let d2 = d.clone();
    s.on_start(move |_ctx| async move {
        refresh(&inner, &d2).await;
        Ok(())
    });
    d
}
