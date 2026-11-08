//! wisp.router's `pipeline` kind (ADR-0028): what happens after a run (v1 conductor/pipeline.js): escalate
//! on error, move on at a limit, best-of-N with a judge, a review.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

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

pub fn register_pipeline(s: &mut Setup) {
    let _ = stored::<PipelineSpec>(s, |sc| KindInfo::new("pipeline", "pipelines", "wisp.router", sc).order(32));
}
