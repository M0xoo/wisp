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
    /// the shared bundle it was made from (`wisp open`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shared_from: Option<String>,
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

/// `runtime.history`: tasks by what made them (ADR-0029). Every filter is optional; they all apply.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct HistoryArgs {
    /// the profile it was asked for, or the harness it ran on
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent: Option<String>,
    /// the crew member it worked for (name or id)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub crew: Option<String>,
    /// a workflow's name: its runs and their steps
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow: Option<String>,
    /// its folder, or a folder's last part (`api`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    /// started at or after (ms)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub since: Option<i64>,
    /// ran with one of these agent profiles (a formula's `agents`, each `{name, …spec}`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(type = "Array<unknown>", optional)]
    pub profiles: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// One task in a history answer: what it is, what made it, where it came from.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct HistoryRow {
    pub id: String,
    pub title: String,
    pub state: String,
    /// the profile (or harness) asked for
    pub agent: String,
    /// the harness it ran on
    pub harness: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "Lineage::is_empty")]
    #[ts(as = "Option<Lineage>", optional)]
    pub lineage: Lineage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
}

/// `runtime.adopt`: a read-only task from someone else's turns (a `full` share imported). It can be
/// forked to carry on.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct AdoptArgs {
    pub title: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub cwd: String,
    /// its turns (runtime's `Turn`, as JSON)
    #[ts(type = "Array<unknown>")]
    pub turns: Vec<Value>,
    #[serde(default)]
    pub spec: TaskSpec,
    /// where it came from (`{ "wisp.share": { … } }`)
    #[serde(default)]
    #[ts(type = "Record<string, unknown>")]
    pub ext: serde_json::Map<String, Value>,
    /// a session run outside wisp (ADR-0035): its id in that CLI. The task isn't read-only then, and its
    /// next follow-up continues the same session there. Additive (2026-11-09).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resume_id: Option<String>,
}
