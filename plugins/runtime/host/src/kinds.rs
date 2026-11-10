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
    /// the command that runs its tests (Auto learns from whether a task's tests pass)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub test: String,
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
    /// the version wisp trusts (a newer one asks first); `from: npm` installs this one
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pin: String,
    /// what `from` installs: the npm package (default: the harness's own) or the brew formula
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub package: String,
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
        harness: harness_kind(s),
        skill: stored::<SkillSpec>(s, |sc| KindInfo::new("skill", "skills", owner, sc).order(15)),
        team: stored::<TeamSpec>(s, |sc| KindInfo::new("team", "teams", owner, sc).order(25)),
    })
}

/// How a harness gets installed when it's applied: what to run, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// `npm install <pkg>@<version>` into wisp's tools folder (`accounts.install`)
    Npm(String),
    /// `brew install <formula>`
    Brew(String),
}

/// `from: npm|brew` installs a harness that isn't there, or whose version isn't its pin. `npm_package`
/// is the harness's own (opencode's); a spec's `package` names another.
pub fn install_plan(h: &HarnessSpec, available: bool, version: Option<&str>, npm_package: Option<&str>) -> Option<Install> {
    if h.enabled == Some(false) {
        return None;
    }
    let pinned = h.pin.trim_start_matches('v');
    let wrong = !pinned.is_empty() && version.is_some_and(|v| !v.trim_start_matches('v').starts_with(pinned));
    if available && !wrong {
        return None;
    }
    let pkg = Some(h.package.clone()).filter(|p| !p.is_empty());
    match h.from.as_str() {
        "npm" => pkg.or_else(|| npm_package.map(str::to_owned)).map(Install::Npm),
        "brew" => pkg.map(Install::Brew),
        _ => None,
    }
}

/// The `harness` kind: kept as declared, and `from: npm|brew` installs it on apply.
struct HarnessKind(std::sync::Arc<wisp_resources_api::StoredKind>);

impl HarnessKind {
    async fn install(&self, name: &str, h: &HarnessSpec) -> wisp_kernel::Result<()> {
        let ctx = &self.0.ctx;
        let call = ctx.root_call();
        let agents = ctx.run_json(&call, "runtime.agents", serde_json::json!({})).await.unwrap_or_default();
        let me = agents.as_array().and_then(|l| l.iter().find(|a| a["id"] == name).cloned()).unwrap_or_default();
        let npm = ctx.contributions(&wisp_runtime_api::harness::HARNESS).into_iter().find(|x| x.info().id == name).and_then(|x| x.npm_package());
        let plan = install_plan(h, me["available"] == true, me["version"].as_str(), npm.as_deref());
        match plan {
            None => Ok(()),
            Some(Install::Npm(pkg)) => {
                let want = if h.pin.is_empty() { pkg } else { format!("{pkg}@{}", h.pin.trim_start_matches('v')) };
                ctx.run_json(&call, "accounts.install", serde_json::json!({ "agent": name, "package": want })).await.map(drop)
            }
            Some(Install::Brew(formula)) => {
                let proc = ctx.service::<wisp_proc::Proc>()?;
                let brew = std::env::var("WISP_BREW").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "brew".into());
                let opts = wisp_proc::ExecOpts { timeout: Some(std::time::Duration::from_secs(600)), ..wisp_proc::ExecOpts::default() };
                let r = proc.exec(&brew, &["install".to_owned(), formula.clone()], opts).await.map_err(|e| wisp_kernel::WireError::invalid(format!("brew isn't there to install {formula}: {e}")))?;
                if r.exit.success() { Ok(()) } else { Err(wisp_kernel::WireError::invalid(format!("brew install {formula} failed: {}", r.stderr_text().trim()))) }
            }
        }
    }
}

impl wisp_resources_api::ResourceKind for HarnessKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a wisp_kernel::Call) -> wisp_kernel::BoxFuture<'a, wisp_kernel::Result<Vec<wisp_resources_api::Resource>>> {
        self.0.read(call)
    }
    fn describe(&self, op: &wisp_resources_api::Op) -> Option<String> {
        let from = op.spec.get("from").and_then(Value::as_str).filter(|f| matches!(*f, "npm" | "brew"))?;
        Some(format!("installs {} with {from} if it isn't there", op.name))
    }
    fn apply<'a>(&'a self, call: &'a wisp_kernel::Call, op: &'a wisp_resources_api::Op) -> wisp_kernel::BoxFuture<'a, wisp_kernel::Result<()>> {
        Box::pin(async move {
            if op.op != wisp_resources_api::OpKind::Delete {
                let h: HarnessSpec = serde_json::from_value(op.spec.clone()).unwrap_or_default();
                self.install(&op.name, &h).await?;
            }
            self.0.apply(call, op).await
        })
    }
}

fn harness_kind(s: &mut Setup) -> std::sync::Arc<wisp_resources_api::StoredKind> {
    let inner = std::sync::Arc::new(wisp_resources_api::StoredKind::new(KindInfo::new("harness", "harnesses", "wisp.runtime", wisp_resources_api::schema_of::<HarnessSpec>()).order(12), s.ctx()));
    let k: std::sync::Arc<dyn wisp_resources_api::ResourceKind> = std::sync::Arc::new(HarnessKind(inner.clone()));
    s.contribute(&wisp_resources_api::RESOURCE_KIND, k);
    inner
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
    fn a_harness_installs_only_when_missing_or_off_its_pin() {
        let npm = HarnessSpec { from: "npm".into(), ..HarnessSpec::default() };
        assert_eq!(install_plan(&npm, true, Some("1.2.0"), Some("opencode-ai")), None);
        assert_eq!(install_plan(&npm, false, None, Some("opencode-ai")), Some(Install::Npm("opencode-ai".into())));
        assert_eq!(install_plan(&npm, false, None, None), None, "no package: nothing to install");
        let pinned = HarnessSpec { pin: "0.60.0".into(), package: "@openai/codex".into(), ..npm.clone() };
        assert_eq!(install_plan(&pinned, true, Some("0.61.2"), None), Some(Install::Npm("@openai/codex".into())));
        assert_eq!(install_plan(&pinned, true, Some("v0.60.0"), None), None);
        let brew = HarnessSpec { from: "brew".into(), package: "grok-cli".into(), ..HarnessSpec::default() };
        assert_eq!(install_plan(&brew, false, None, None), Some(Install::Brew("grok-cli".into())));
        assert_eq!(install_plan(&HarnessSpec { enabled: Some(false), ..brew }, false, None, None), None);
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
