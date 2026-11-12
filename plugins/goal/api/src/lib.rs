//! wisp.goal contract (goals: rounds, verdicts, judges, stalls). A task's goal is its spec's `goal`
//! (`{ text, judges?, vote?, maxRounds? }` or the text alone); what the plugin knows of it is the task's
//! `ext["wisp.goal"]` ([`GoalState`]). The defaults are the `goal` resource.

use serde::{Deserialize, Serialize};
use wisp_kernel::Command;

pub const PLUGIN: &str = "wisp.goal";

/// `goal.set`: set, change or clear a task's goal after it started (the task's Done-when, the GUI's goal band).
/// Empty `text` clears it. A new goal starts its count again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct SetArgs {
    /// the task
    pub id: String,
    /// what done means; empty: no goal
    pub text: String,
}

/// `goal.pause` / `goal.resume` / `goal.drop` / `goal.check`: a task's goal held, going again, gone, or judged now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskArgs {
    /// the task
    pub id: String,
    /// why it's paused (shown on the band)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub why: Option<String>,
}

macro_rules! goal_command {
    ($ty:ident, $id:literal) => {
        #[derive(Debug)]
        pub struct $ty;
        impl Command for $ty {
            const ID: &'static str = $id;
            type Args = TaskArgs;
            type Out = serde_json::Value;
            fn args_ts() -> Option<String> {
                Some(format!("{}{}", <TaskArgs as ::ts_rs::TS>::docs().unwrap_or_default(), <TaskArgs as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
            }
        }
    };
}
goal_command!(Pause, "goal.pause");
goal_command!(Resume, "goal.resume");
goal_command!(Drop, "goal.drop");
goal_command!(Check, "goal.check");

#[derive(Debug)]
pub struct Set;
impl Command for Set {
    const ID: &'static str = "goal.set";
    type Args = SetArgs;
    type Out = serde_json::Value;
    fn args_ts() -> Option<String> {
        Some(format!("{}{}", <SetArgs as ::ts_rs::TS>::docs().unwrap_or_default(), <SetArgs as ::ts_rs::TS>::inline(&::ts_rs::Config::default())))
    }
}

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
    /// the goal set after the task started (`goal.set`), over its spec's
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// the agent's own wake-up (a `wisp.later` entry) the goal waits for before it's checked (v1 #775). Additive.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub wake: String,
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
