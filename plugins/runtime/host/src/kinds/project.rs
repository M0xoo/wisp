//! The `project` kind: a folder wisp works in, and how (its worktrees, setup, trust, tests, instructions), and
//! how a task's folder finds the project that holds it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// the command that runs its tests (Auto learns from whether a task's tests pass)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub test: String,
    /// notes every task in it starts with (learned preferences, per-project rules)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub instructions: String,
}

/// A project spec as it's stored: its path canonical (`wisp_runtime_api::paths`), `~` your home's.
pub fn tidy_project(spec: &mut Value) {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
    tidy_project_at(spec, home.as_deref());
}

/// [`tidy_project`] with the home folder given: "~/code/app" typed in Projects is that folder under your home (v1's
/// server expanded it; v2 stored a folder named `~`).
pub fn tidy_project_at(spec: &mut Value, home: Option<&std::path::Path>) {
    if let Some(p) = spec.get("path").and_then(Value::as_str) {
        let p = match (p.trim().strip_prefix('~'), home) {
            (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{}{rest}", h.display()),
            _ => p.to_owned(),
        };
        let c = wisp_runtime_api::paths::canonical_project_path(&p, None);
        if let Some(o) = spec.as_object_mut() {
            o.insert("path".into(), Value::String(c));
        }
    }
}

/// A project's spec with its test command set (empty clears it): what `runtime.projectTest` writes.
pub fn with_test(spec: &Value, command: &str) -> Value {
    let mut s = spec.clone();
    if let Some(o) = s.as_object_mut() {
        if command.trim().is_empty() {
            o.remove("test");
        } else {
            o.insert("test".into(), Value::String(command.trim().to_owned()));
        }
    }
    s
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::kinds::brief::brief_text;


    /// `wisp add .` (or a resource applied by hand) stored "/repo/."; on apply the project kind stores it canonical.
    #[test]
    fn a_project_applied_with_a_trailing_dot_or_verbatim_prefix_is_stored_canonical() {
        let mut spec = json!({ "path": "/work/api/.", "color": "teal" });
        tidy_project(&mut spec);
        assert_eq!(spec, json!({ "path": "/work/api", "color": "teal" }));
        let mut win = json!({ "path": r"\\?\C:\work\api\" });
        tidy_project(&mut win);
        assert_eq!(win["path"], r"C:\work\api");
        let mut url = json!({ "path": "https://github.com/acme/api.git" });
        tidy_project(&mut url);
        assert_eq!(url["path"], "https://github.com/acme/api.git");
    }

    /// Projects' box takes "~/code/app" (its folder suggestions answer in that form): stored under your home, as v1's
    /// server did. `~bob` stays as typed.
    #[test]
    fn a_project_typed_from_home_is_stored_under_home() {
        let h = std::path::Path::new("/home/ada");
        let mut spec = json!({ "path": "~/code/app/" });
        tidy_project_at(&mut spec, Some(h));
        assert_eq!(spec["path"], "/home/ada/code/app");
        let mut bob = json!({ "path": "~bob/app" });
        tidy_project_at(&mut bob, Some(h));
        assert_eq!(bob["path"], "~bob/app");
    }

    #[test]
    fn a_projects_test_command_is_set_cleared_and_read_back() {
        let spec = serde_json::json!({ "path": "/w/app" });
        let set = with_test(&spec, "  cargo test ");
        assert_eq!(set["test"], "cargo test");
        let p: ProjectSpec = serde_json::from_value(set.clone()).unwrap();
        assert_eq!(p.test, "cargo test", "the spec reads it back (deny_unknown_fields knows it)");
        assert!(with_test(&set, "").get("test").is_none());
    }

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
