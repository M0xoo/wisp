//! wisp.goal contract (goals: rounds, verdicts, judges, stalls). A task's goal is its spec's `goal`
//! (`{ text, judges?, vote?, maxRounds? }` or the text alone); what the plugin knows of it is the task's
//! `ext["wisp.goal"]` ([`GoalState`]). The defaults are the `goal` resource.

use serde::{Deserialize, Serialize};

pub const PLUGIN: &str = "wisp.goal";

/// `ext["wisp.goal"]`: where the goal stands.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    /// judging | again | met | stalled
    pub state: String,
    pub rounds: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verdicts: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub why: String,
}
