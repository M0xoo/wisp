//! wisp.claude: Claude Code as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes: the CLI's description (models, efforts, flags), `detect` (`WISP_CLAUDE_BIN`,
//! else `claude` on PATH, then `--version`), the launch (`launch.rs`, v1 adapters/claude.js `run()`)
//! and a driver over `wisp-claude-core`'s stream-json parser. Everything that touches the system goes
//! through the runtime's `HarnessSys`.

pub mod sessions;

mod driver;
mod launch;

use std::sync::{Arc, Mutex};

use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::RunPaths;
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_harness_kit::Re;
use wisp_runtime_api::harness::{ExecReq, HarnessAccounts, HarnessFound, HarnessInfo, HarnessLogin, HarnessModel, HarnessRun, HarnessSys, Launch, PermissionAsk, RunDriver, SetupTip};
use wisp_runtime_api::{HARNESS, Harness};

pub use launch::{DEFAULT_BIN, launch};

fn model(id: &str, label: &str, hint: &str) -> HarnessModel {
    HarnessModel { id: id.into(), label: label.into(), hint: Some(hint.into()), efforts: Vec::new() }
}

/// v1 adapters/claude.js's static fields.
pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "claude".into(),
        name: "Claude Code".into(),
        models: vec![
            model("", "Default", "Whatever Claude Code is set to"),
            // Claude Code 2.1.321 takes `--model fable` (Fable 5.2, claude-fable-5-2)
            model("fable", "Fable", "Newest and most capable"),
            model("opus", "Opus", "Most capable, for hard problems"),
            model("sonnet", "Sonnet", "Fast and smart, everyday work"),
            model("haiku", "Haiku", "Fastest, for quick tasks"),
        ],
        efforts: ["low", "medium", "high", "xhigh", "max"].map(str::to_owned).to_vec(),
        ask_tool: Some("mcp__wisp__ask_user".into()),
        approve_tool: Some(launch::APPROVE_TOOL.into()),
        side_gate: true,
        fork: true,
        reports_cli: true,
        session_ids: true,
        system_prompt_flag: true,
    }
}

/// What a run says when it is signed out (v1 agent-login.js LOGINS.claude.authFailed).
static AUTH_FAILED: Re = Re::new(r"(?im)^(?:Not logged in|Login expired|OAuth token revoked|Login reached its time limit|Authentication required|Failed to authenticate)\b|please run /login|run /login to (?:sign in|re-?authenticate)|oauth (?:access )?token has (?:expired|been revoked)|authentication_error|authentication_failed");
static LOGGED_IN: Re = Re::new(r#""loggedIn":\s*(true|false)"#);

/// Signing in from wisp (v1 agent-login.js LOGINS.claude).
pub fn login() -> HarnessLogin {
    let v = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    HarnessLogin {
        bin: DEFAULT_BIN.into(),
        bin_env: "WISP_CLAUDE_BIN".into(),
        args: v(&["auth", "login", "--claudeai"]),
        logout: v(&["auth", "logout"]),
        status: v(&["auth", "status"]),
        keys: v(&["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]),
        ..HarnessLogin::default()
    }
}

/// Several accounts: each is a `CLAUDE_CONFIG_DIR` (v1 accounts.js `HOMES.claude`).
pub fn accounts() -> HarnessAccounts {
    HarnessAccounts {
        env: "CLAUDE_CONFIG_DIR".into(),
        home_dir: ".claude".into(),
        own: [".credentials.json", ".claude.json", ".claude.json.lock", "backups", "statsig", "session-env", "shell-snapshots"].map(str::to_owned).to_vec(),
        resumes: true,
        extra: "https://support.claude.com/en/articles/11145838".into(),
        label: "Claude".into(),
    }
}

/// The harness. `bin`: what the last detect found, used when a run names none.
#[derive(Debug)]
pub struct ClaudeHarness {
    info: HarnessInfo,
    bin: Mutex<Option<String>>,
    login: HarnessLogin,
    accounts: HarnessAccounts,
}

impl Default for ClaudeHarness {
    fn default() -> Self {
        Self { info: info(), bin: Mutex::new(None), login: login(), accounts: accounts() }
    }
}

impl ClaudeHarness {
    fn found_bin(&self) -> Option<String> {
        self.bin.lock().ok().and_then(|b| b.clone())
    }
}

impl Harness for ClaudeHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }
    /// Claude Code runs a project's hooks and plugins from its settings files, and its MCP servers from `.mcp.json`.
    fn project_hooks(&self) -> Option<wisp_runtime_api::harness::ProjectHooks> {
        Some(wisp_runtime_api::harness::ProjectHooks { settings: vec![".claude/settings.json".into(), ".claude/settings.local.json".into()], mcp: Some(".mcp.json".into()) })
    }
    /// Claude Code loads `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and the project's `.claude/skills`.
    fn skill_dirs(&self, cwd: &str) -> Vec<(std::path::PathBuf, String)> {
        vec![(sessions::store().join("skills"), "~/.claude/skills".into()), (std::path::Path::new(cwd).join(".claude/skills"), ".claude/skills".into())]
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let bin = match sys.env("WISP_CLAUDE_BIN") {
                Some(b) if !b.is_empty() => Some(b),
                _ => sys.which(DEFAULT_BIN).await,
            };
            let Some(bin) = bin else {
                return HarnessFound { available: false, error: Some("Claude Code isn't installed".into()), ..HarnessFound::default() };
            };
            let req = ExecReq { program: bin.clone(), args: vec!["--version".into()], timeout_ms: 10_000, ..ExecReq::default() };
            let version = match sys.exec(req).await {
                Ok(o) if o.code == Some(0) => o.stdout.split_whitespace().next().map(str::to_owned),
                _ => None,
            };
            if let Ok(mut b) = self.bin.lock() {
                *b = Some(bin.clone());
            }
            HarnessFound { available: true, version, bin: Some(bin), ..HarnessFound::default() }
        })
    }

    fn program(&self) -> Option<String> {
        Some(self.found_bin().or_else(|| std::env::var("WISP_CLAUDE_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned()))
    }

    fn launch(&self, run: &HarnessRun) -> Result<Launch> {
        let bin = run.bin.clone().or_else(|| self.found_bin()).or_else(|| std::env::var("WISP_CLAUDE_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned());
        Ok(launch(run, &bin))
    }

    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        let paths = RunPaths::same(run.cwd.clone());
        let parser = ClaudeParser::new(ClaudeOptions { paths: paths.clone(), prior: run.prior.clone(), unknown_prior: run.unknown_prior });
        driver::KitDriver::boxed(parser, paths, false)
    }

    /// A live approval in words (v1 claude.js `permission`): `detail` is the exact command or file,
    /// so "Always allow in this task" covers only the same action (v1 runner.js `sameAction`).
    fn permission(&self, tool: &str, input: &serde_json::Value, cwd: &str) -> Option<PermissionAsk> {
        let paths = RunPaths::same(cwd);
        let why = (tool == "Bash").then(|| input["description"].as_str().unwrap_or("").to_owned()).filter(|w| !w.is_empty());
        Some(PermissionAsk { tool: tool.to_owned(), action: wisp_claude_core::describe::action_of(tool, input, &paths), detail: wisp_claude_core::describe::detail_of(tool, input, &paths), why })
    }

    fn login(&self) -> Option<&HarnessLogin> {
        Some(&self.login)
    }

    fn signed_in(&self, out: &str, _code: Option<i32>) -> Option<bool> {
        LOGGED_IN.group(out, 1).map(|v| v == "true")
    }

    fn auth_failed(&self, text: &str) -> bool {
        text.len() <= 1200 && AUTH_FAILED.is_match(text)
    }

    /// `claude auth status` is JSON: its email and plan.
    fn who_is(&self, out: &str) -> Option<(Option<String>, Option<String>)> {
        let j: serde_json::Value = serde_json::from_str(&out[out.find('{')?..]).ok()?;
        let plan = j["subscriptionType"].as_str().filter(|p| !p.is_empty()).map(|p| {
            let mut c = p.chars();
            c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
        });
        Some((j["email"].as_str().map(str::to_owned), plan))
    }

    fn accounts(&self) -> Option<&HarnessAccounts> {
        Some(&self.accounts)
    }

    fn setup(&self, platform: &str) -> Option<SetupTip> {
        Some(SetupTip {
            tip: if platform == "linux" { "Install Claude Code, then run claude once to sign in" } else { "Install Claude Code and run claude once to sign in. Or open the Claude app’s Code tab once: wisp uses the copy it downloads" }.into(),
            command: Some(if platform == "win32" { "irm https://claude.ai/install.ps1 | iex" } else { "curl -fsSL https://claude.ai/install.sh | bash" }.into()),
            url: Some("https://claude.com/claude-code".into()),
        })
    }
}

#[derive(Debug, Default)]
pub struct ClaudePlugin;

impl Plugin for ClaudePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(ClaudeHarness::default());
        s.contribute(&HARNESS, h);
        let sessions: Arc<dyn wisp_runtime_api::harness::sessions::HarnessSessions> = Arc::new(crate::sessions::ClaudeSessions);
        s.contribute(&wisp_runtime_api::harness::sessions::SESSIONS, sessions);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        let m = ClaudePlugin.manifest();
        assert_eq!(m.id, "wisp.claude");
    }

    #[test]
    fn claude_catalogue_lists_fable() {
        let ids: Vec<String> = info().models.iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids[..2], [String::new(), "fable".to_owned()], "Fable first after Default");
        let f = &info().models[1];
        assert_eq!((f.label.as_str(), f.hint.as_deref()), ("Fable", Some("Newest and most capable")));
    }

    #[test]
    fn info_is_v1s() {
        let i = info();
        assert_eq!((i.id.as_str(), i.models.len(), i.efforts.len()), ("claude", 5, 5));
        assert!(i.fork && i.reports_cli && i.system_prompt_flag);
    }

    #[test]
    fn a_permission_names_the_exact_command() {
        // verify round 4: Always on `npm publish` must not cover `rm -rf build`
        let h = ClaudeHarness::default();
        let p = h.permission("Bash", &serde_json::json!({ "command": "npm publish", "description": "Publish" }), "/w").expect("an ask");
        let q = h.permission("Bash", &serde_json::json!({ "command": "rm -rf build" }), "/w").expect("an ask");
        assert_eq!((p.detail.as_str(), p.action.as_str(), p.why.as_deref()), ("npm publish", "run `npm publish`", Some("Publish")));
        assert_ne!((p.tool.as_str(), p.detail.as_str()), (q.tool.as_str(), q.detail.as_str()));
        assert_eq!(h.permission("Write", &serde_json::json!({ "file_path": "/w/a.js" }), "/w").map(|x| x.detail).as_deref(), Some("a.js"));
    }

    #[test]
    fn signing_in_in_its_own_words() {
        let h = ClaudeHarness::default();
        assert!(AUTH_FAILED.compiles() && LOGGED_IN.compiles());
        assert_eq!(h.signed_in("{\"loggedIn\": false}", Some(1)), Some(false));
        assert!(h.auth_failed("Not logged in · Please run /login"));
        assert_eq!(h.who_is("{\"email\":\"a@b.c\",\"subscriptionType\":\"max\"}"), Some((Some("a@b.c".into()), Some("Max".into()))));
    }

    #[test]
    fn a_run_launches_what_detect_found() {
        let h = ClaudeHarness::default();
        let run = HarnessRun { bin: Some("/opt/claude".into()), prompt: "hi".into(), ..HarnessRun::default() };
        assert_eq!(h.launch(&run).map(|l| l.program).ok().as_deref(), Some("/opt/claude"));
    }

    /// The setup record names no harness: Claude's own skill folders come from it (was a
    /// `harness == "claude"` branch in wisp.runtime's setup.rs).
    #[test]
    fn claude_names_the_skill_folders_it_loads_by_itself() {
        let dirs = ClaudeHarness::default().skill_dirs("/work/app");
        let labels: Vec<&str> = dirs.iter().map(|(_, l)| l.as_str()).collect();
        assert_eq!(labels, ["~/.claude/skills", ".claude/skills"]);
        assert_eq!(dirs[1].0, std::path::Path::new("/work/app/.claude/skills"));
        assert!(dirs[0].0.ends_with("skills"));
    }
}
