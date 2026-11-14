//! Try it two ways (v1 #650, F-comp-31; ADR-0056): one task run twice on one harness with one setting changed,
//! side by side. `runtime.trial` starts the pair, `runtime.trial.keep` says which one you kept.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Created, StartArgs};
use crate::SessionId;

/// What run B changes against run A: one setting (each left out is run A's). Claude Code's today; a harness
/// that can't run a key (`HarnessInfo::variants`) is refused.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct Variant {
    /// the model its subagents run on: '' (the task's own model), `haiku` or `sonnet`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subagent_model: Option<String>,
    /// `off`: without its skills and slash commands; `on`: as usual
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skills: Option<String>,
}

impl Variant {
    pub fn is_empty(&self) -> bool {
        self.subagent_model.is_none() && self.skills.is_none()
    }
}

/// `runtime.trial`: run A is `task` as given, run B is the same task with `vary` changed. Both on the harness
/// `task` names (not Auto), each in a worktree of its own, never in Plan.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TrialArgs {
    pub task: StartArgs,
    pub vary: Variant,
}

/// One setting the runs differ by: its value on each run, in run order (A, B). Keys: `subagentModel` (its
/// value as the run really goes: '' is the task's model) and `skills` (`on` | `off`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TrialDiff {
    pub key: String,
    pub values: Vec<String>,
}

/// The trial link, on each run (`ext["wisp.runtime"].trial`, the row's `summary.trial`): v1 `session.trial`
/// `{ differs, kept }`, with its group, its place in it and its sibling.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TrialLink {
    /// the runs' group (also `ext["wisp.runtime"].group`: Compare runs shows them)
    pub group: String,
    /// 0 for run A, 1 for run B
    pub run: u8,
    /// every run of it, A first (filled once both exist)
    #[serde(default)]
    pub runs: Vec<SessionId>,
    pub differs: Vec<TrialDiff>,
    /// the run you kept (Keep this), on every run of it; none until then
    #[serde(default)]
    #[ts(optional)]
    pub kept: Option<SessionId>,
}

/// What `runtime.trial` started: its group and the two runs, A first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "runtime/")]
pub struct TrialStarted {
    pub group: String,
    pub runs: Vec<Created>,
    pub differs: Vec<TrialDiff>,
}

/// `HarnessInfo::variants` and `TrialDiff::key`: the subagents' model.
pub const SUBAGENT_MODEL: &str = "subagentModel";
/// `HarnessInfo::variants` and `TrialDiff::key`: skills on or off.
pub const SKILLS: &str = "skills";
/// The values `subagentModel` takes ('' is the task's own model).
pub const SUBAGENT_MODELS: [&str; 3] = ["", "haiku", "sonnet"];
