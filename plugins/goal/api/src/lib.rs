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

/// A task's goal was met: its judges agreed (ADR-0043: the `goal.met` trigger source). Durable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalMet {
    pub session_id: String,
    pub goal: String,
    pub rounds: u32,
}
impl wisp_kernel::Event for GoalMet {
    const TYPE: &'static str = "goal.met";
    const DURABLE: bool = true;
    fn subject(&self) -> Option<String> {
        Some(self.session_id.clone())
    }
    fn key(&self) -> Option<String> {
        Some(self.session_id.clone())
    }
}

/// A task's goal stalled: past its rounds, or its judges can't agree; it asks you now (`goal.failed`). Durable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalFailed {
    pub session_id: String,
    pub goal: String,
    pub rounds: u32,
    pub why: String,
}
impl wisp_kernel::Event for GoalFailed {
    const TYPE: &'static str = "goal.failed";
    const DURABLE: bool = true;
    fn subject(&self) -> Option<String> {
        Some(self.session_id.clone())
    }
    fn key(&self) -> Option<String> {
        Some(format!("{}:{}", self.session_id, self.rounds))
    }
}
