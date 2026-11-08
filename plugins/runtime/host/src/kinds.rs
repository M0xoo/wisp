//! wisp.runtime's other resource kinds (ADR-0028): projects, harnesses, teams and skills, kept as declared
//! (`StoredKind`) and acted on when a task starts (`specs::prepare`):
//! - a **project** whose path holds the task's folder gives its agent (when the task names none), its
//!   worktree default, runs its setup commands first, and its instructions go in the system prompt;
//! - a **harness** that is off refuses the task; its model and effort fill what the task left out;
//! - a **team** the task names becomes its subagents;
//! - the **skills** its agent profile names go in the system prompt.

use std::collections::BTreeMap;
use std::fmt::Write as _;

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

/// `runtime.agents` with what `harnesses:` declares: one that's off isn't offered (not available, and
/// why), and one whose version isn't the pinned one says so (it still runs: a newer one asks first).
pub fn declared(list: &mut [wisp_runtime_api::commands::AgentStatus], specs: &[(String, Value)]) {
    for a in list.iter_mut() {
        let Some(h) = specs.iter().find(|(n, _)| *n == a.id).and_then(|(_, v)| serde_json::from_value::<HarnessSpec>(v.clone()).ok()) else { continue };
        if h.enabled == Some(false) {
            a.available = false;
            a.error = Some(format!("switched off (harnesses: {}: {{ enabled: false }})", a.id));
        } else if !h.pin.is_empty() && a.version.as_deref().is_some_and(|v| !v.trim_start_matches('v').starts_with(h.pin.trim_start_matches('v'))) {
            a.error = Some(format!("{} isn't the pinned {} (harnesses: {}: {{ pin }})", a.version.clone().unwrap_or_default(), h.pin, a.id));
        }
    }
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

/// The stored kinds, for `prepare` to read.
#[derive(Debug)]
pub struct Kinds {
    pub project: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub harness: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub skill: std::sync::Arc<wisp_resources_api::StoredKind>,
    pub team: std::sync::Arc<wisp_resources_api::StoredKind>,
}

pub fn register(s: &mut Setup) -> std::sync::Arc<Kinds> {
    let owner = "wisp.runtime";
    std::sync::Arc::new(Kinds {
        project: stored::<ProjectSpec>(s, |sc| KindInfo::new("project", "projects", owner, sc).order(10)),
        harness: stored::<HarnessSpec>(s, |sc| KindInfo::new("harness", "harnesses", owner, sc).order(12)),
        skill: stored::<SkillSpec>(s, |sc| KindInfo::new("skill", "skills", owner, sc).order(15)),
        team: stored::<TeamSpec>(s, |sc| KindInfo::new("team", "teams", owner, sc).order(25)),
    })
}

/// The project whose path holds `cwd` (the longest), if one is declared.
pub fn project_for(projects: &[(String, Value)], cwd: &str) -> Option<(String, ProjectSpec)> {
    let norm = |p: &str| p.trim_end_matches('/').to_owned();
    let cwd = norm(cwd);
    projects
        .iter()
        .filter_map(|(n, v)| Some((n.clone(), serde_json::from_value::<ProjectSpec>(v.clone()).ok()?)))
        .filter(|(_, p)| {
            let root = norm(&p.path);
            !root.is_empty() && (cwd == root || cwd.starts_with(&format!("{root}/")) || cwd.ends_with(&format!("/private{root}")))
        })
        .max_by_key(|(_, p)| p.path.len())
}

/// The system prompt's brief from what `prepare` resolved (`ext["wisp.runtime"].brief`).
pub fn brief_text(brief: &Value) -> String {
    let mut out = String::new();
    let s = |k: &str| brief.get(k).and_then(Value::as_str).unwrap_or_default();
    if !s("project").is_empty() {
        let _ = write!(out, "## This project's instructions\n\n{}\n", s("project").trim());
    }
    if !s("agent").is_empty() {
        let _ = write!(out, "\n## Your instructions\n\n{}\n", s("agent").trim());
    }
    let skills = brief.get("skills").and_then(Value::as_array).cloned().unwrap_or_default();
    if !skills.is_empty() {
        out.push_str("\n## Skills you have\n");
        for k in skills {
            let (n, d, b) = (k.get("name").and_then(Value::as_str).unwrap_or(""), k.get("description").and_then(Value::as_str).unwrap_or(""), k.get("body").and_then(Value::as_str).unwrap_or(""));
            let _ = write!(out, "\n### {n}\n{d}\n\n{}\n", b.trim());
        }
    }
    let team = brief.get("team").and_then(Value::as_array).cloned().unwrap_or_default();
    if !team.is_empty() {
        out.push_str("\n## Your team\n\nHand work to these with wisp_delegate (by name):\n");
        for m in team {
            let g = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            let n = m.get("count").and_then(Value::as_u64).map_or_else(String::new, |c| format!(", up to {c} at once"));
            let why = g("why");
            let _ = writeln!(out, "- {} ({}{n}){}", g("name"), g("agent"), if why.is_empty() { String::new() } else { format!(": {why}") });
        }
    }
    out.trim().to_owned()
}

/// `runtime.prompt@1`: a task's brief (its project's instructions, its agent's, its skills).
#[derive(Debug)]
pub struct Brief;

impl wisp_runtime_api::points::PromptPart for Brief {
    fn id(&self) -> &'static str {
        "wisp.runtime.brief"
    }
    fn part(&self, session: &wisp_runtime_api::model::Session) -> String {
        session.ext.get("wisp.runtime").and_then(|m| m.get("brief")).map(brief_text).unwrap_or_default()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_deepest_project_holds_the_folder_and_the_brief_reads() {
        let ps = vec![("mono".to_owned(), json!({ "path": "/w" })), ("api".to_owned(), json!({ "path": "/w/api", "instructions": "small PRs" }))];
        assert_eq!(project_for(&ps, "/w/api/src").unwrap().0, "api");
        assert_eq!(project_for(&ps, "/w/web").unwrap().0, "mono");
        assert!(project_for(&ps, "/x").is_none());
        let b = brief_text(&json!({ "project": "small PRs", "agent": "plan first", "skills": [{ "name": "notes", "description": "release notes", "body": "Keep it short." }] }));
        assert!(b.contains("## This project's instructions\n\nsmall PRs") && b.contains("## Your instructions") && b.contains("### notes"), "{b}");
    }
}
