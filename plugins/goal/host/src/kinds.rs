//! wisp.goal's resource kind (ADR-0028): the default judges and how they vote (v1 `goalJudges`,
//! `goalVote`), as one object (`goal:` in a formula). Goals on a task or a workflow step sit in their specs.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

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

pub fn register(s: &mut Setup) {
    let _ = stored::<GoalSpec>(s, |sc| KindInfo::new("goal", "goal", "wisp.goal", sc).singleton().order(35));
}
