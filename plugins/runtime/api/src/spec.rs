//! A task as code (ADR-0027, ADR-0029): its spec (what was asked: the prompt and the steps after it,
//! the agent, the base commit, the formula it ran under, where it came from) next to its history, and
//! named agent profiles (`agents:` in a formula).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// A named, reusable agent: which harness and how it runs ("reviewer = codex, high effort, plan mode,
/// the linear connector"). A task, a crew member, a team slot or a judge names one, or gives one inline.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "runtime/")]
pub struct AgentSpec {
    /// the harness that runs it (`claude`, `codex`, `cursor`, `opencode`, …; `auto` lets the router pick)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub harness: String,
    /// the harness's model id ('' = the harness's own default)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    /// low | medium | high | the harness's own levels
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
    /// plan | edits | auto
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mode: String,
    /// a harness account by name (accounts are personal: never exported unless asked)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account: String,
    /// the model its subagents use
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subagent_model: String,
    /// skills it gets, by name
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    /// connectors (MCP servers) it gets, by name
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connectors: Vec<String>,
    /// standing instructions every task it runs starts with
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
}

/// A stored profile: its name and spec.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Profile {
    pub name: String,
    #[serde(flatten)]
    pub spec: AgentSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct NameArgs {
    pub name: String,
}

/// The code a task started from: recorded when it starts, worktree or not.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Base {
    /// the origin's URL ('' for a repo without one)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub repo: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// a rerun at an older commit runs in a detached worktree of it
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub worktree: String,
}

/// Where a task came from (ADR-0029): every field optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Lineage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rerun_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fork_of: Option<String>,
    /// the workflow run (its parent task) it is a step of
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow_run: Option<String>,
    /// the trigger or schedule that started it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub triggered_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew_job: Option<String>,
}

impl Lineage {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// `runtime.spec`: a task's spec as it can be rerun or shared (`wisp task spec <id>`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct TaskSpec {
    pub prompt: String,
    /// the prompts after the first, in order (follow-ups add to it)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub steps: Vec<String>,
    /// the profile name (or harness) it was asked for
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub agent: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub effort: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub mode: String,
    /// the project folder
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[ts(as = "Option<String>", optional)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub dirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub base: Option<Base>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub goal: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub team: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub connectors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schedule: Option<String>,
    /// the effective formula it ran with, by content hash (`runtime.snapshot`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "Lineage::is_empty")]
    #[ts(as = "Option<Lineage>", optional)]
    pub lineage: Lineage,
}

/// `runtime.snapshot`: what a task ran with, stored once per content hash (ADR-0029). Secrets stay
/// references.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct Snapshot {
    pub hash: String,
    /// as formula sections: `agents`, `crew`, `connectors`, …
    #[ts(type = "Record<string, unknown>")]
    pub formula: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct HashArgs {
    /// a snapshot's hash, or a task's id (its snapshot)
    pub of: String,
}
