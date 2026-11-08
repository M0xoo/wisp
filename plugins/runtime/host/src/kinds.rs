//! wisp.runtime's other resource kinds (ADR-0028): projects, harnesses, teams and skills. Kept as
//! declared (`StoredKind`): exported, diffed and applied like every kind; the parts that port them
//! (worktree policy, setup scripts, harness pins, project instructions, teams) read them from here.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::Setup;
use wisp_resources_api::{KindInfo, stored};

/// How a project uses worktrees (v1 `worktree`, `worktreeOnDone`, `worktreeCleanup`, `worktreeMax`,
/// `cloneDir`, `fixConflicts`, `.worktreeinclude`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreePolicy {
    /// each task in a worktree of its own
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// when a task is done: ask | remove-clean | keep
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub on_done: String,
    /// days a finished task's worktree stays before cleanup
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_days: Option<u32>,
    /// at most this many worktrees at once
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    /// where clones and worktrees go
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dir: String,
    /// resolve merge conflicts with an agent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_conflicts: Option<bool>,
    /// untracked files copied into each worktree (`.env`, `node_modules`)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
}

/// What a project trusts without asking: its hooks, MCP servers and setup script.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTrust {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hooks: bool,
    /// the project's own MCP servers, by name
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub setup: bool,
}

/// A project: a folder wisp works in, and how.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSpec {
    /// the folder (absolute), or a repo URL cloned into the worktree dir
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// the agent profile or harness its tasks use unless they say
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreePolicy>,
    /// commands run in a new worktree before the first turn
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup: Vec<String>,
    /// commands that start the project (a dev server), for Run
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub run: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<ProjectTrust>,
    /// notes every task in it starts with (learned preferences, per-project rules)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
}

/// A harness CLI: where it comes from, which version is trusted, its own defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessSpec {
    /// installed or not (false: wisp never offers it)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// npm | brew | path
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub from: String,
    /// its program when `from: path`
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// the version wisp trusts (a newer one asks first)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pin: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub effort: String,
    /// lean runs: wisp's short base prompt instead of the harness's own
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lean: Option<bool>,
    /// read its usage limits while it runs
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_limits: Option<bool>,
}

/// One seat on a team.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamSlot {
    /// an agent profile's name or a harness
    pub agent: String,
    /// copies of it the lead may run at once
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// what the lead gives it
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub why: String,
}

/// A lead and the subagents it may hand work to (v1 `teams`, `subagents`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TeamSpec {
    /// the lead's agent profile
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub lead: String,
    /// its subagents, by name
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub members: BTreeMap<String, TeamSlot>,
}

/// A skill given to agents: a folder or file, or the text inline.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkillSpec {
    /// what it is for (agents read it to pick it)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// a SKILL.md or its folder
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// the skill's text, when it isn't a file
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body: String,
    /// extra fields a harness's skill format has
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

pub fn register(s: &mut Setup) {
    let owner = "wisp.runtime";
    let _ = stored::<ProjectSpec>(s, |sc| KindInfo::new("project", "projects", owner, sc).order(10));
    let _ = stored::<HarnessSpec>(s, |sc| KindInfo::new("harness", "harnesses", owner, sc).order(12));
    let _ = stored::<SkillSpec>(s, |sc| KindInfo::new("skill", "skills", owner, sc).order(15));
    let _ = stored::<TeamSpec>(s, |sc| KindInfo::new("team", "teams", owner, sc).order(25));
}
