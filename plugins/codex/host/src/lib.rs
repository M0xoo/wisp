//! wisp.codex: Codex as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes (v1 adapters/codex.js): the CLI's description, `detect` (`WISP_CODEX_BIN`, else
//! `codex` on `PATH`, else the standalone installer's or the `ChatGPT` app's copy; its version; its model
//! catalog from `codex debug models` or `$CODEX_HOME/models_cache.json`), the launch (`launch.rs`), a
//! driver over `wisp-codex-core`'s parser with the file tracker on, the resume command and folder
//! trust. Everything that touches the system goes through the runtime's `HarnessSys`.

mod driver;
mod launch;

use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_codex_core::{CodexOptions, CodexParser, toml};
use wisp_harness_kit::detect::{version_in, version_triple};
use wisp_harness_kit::{RunPaths, clip};
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_harness_kit::Re;
use wisp_runtime_api::harness::{ExecReq, HarnessAccounts, HarnessFound, HarnessInfo, HarnessLogin, HarnessModel, HarnessRun, HarnessSys, Launch, ResumeCommand, ResumeOptions, RunDriver, SetupTip};
use wisp_runtime_api::{HARNESS, Harness};

pub use launch::{DEFAULT_BIN, launch};

pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "codex".into(),
        name: "Codex".into(),
        models: vec![HarnessModel { id: String::new(), label: "Default".into(), hint: Some("Whatever Codex is set to".into()), efforts: Vec::new() }],
        efforts: ["minimal", "low", "medium", "high", "xhigh"].map(str::to_owned).to_vec(),
        ask_tool: Some("mcp__wisp__ask_user".into()),
        fork: true,
        reports_cli: true,
        // the launch puts the protocol in itself: as developer instructions, or ahead of the prompt
        system_prompt_flag: true,
        ..HarnessInfo::default()
    }
}

/// What the last detect found.
#[derive(Debug, Clone, Default)]
struct Found {
    bin: Option<String>,
    /// ≥ 0.53, not Windows, and config.toml sets no `developer_instructions` of its own
    developer: bool,
}

/// What a run says when it is signed out (v1 agent-login.js LOGINS.codex.authFailed).
static AUTH_FAILED: Re = Re::new(r"(?i)could not be refreshed|please (?:log out and )?sign in again|no codex credentials|run `?codex login|\b401 Unauthorized\b|refresh_token_invalidated");
static NOT_IN: Re = Re::new(r"(?i)not (logged|signed) in");
static IN: Re = Re::new(r"(?i)(logged|signed) in");

/// Signing in from wisp (v1 agent-login.js LOGINS.codex): the device-code login.
pub fn login() -> HarnessLogin {
    let v = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    HarnessLogin { bin: DEFAULT_BIN.into(), bin_env: "WISP_CODEX_BIN".into(), args: v(&["login", "--device-auth"]), logout: v(&["logout"]), status: v(&["login", "status"]), keys: v(&["OPENAI_API_KEY", "CODEX_API_KEY"]), ..HarnessLogin::default() }
}

/// Several accounts: each is a `CODEX_HOME` (v1 accounts.js `HOMES.codex`). A conversation doesn't move
/// between them (its reasoning may be tied to the login's organisation).
pub fn accounts() -> HarnessAccounts {
    HarnessAccounts {
        env: "CODEX_HOME".into(),
        home_dir: ".codex".into(),
        own: ["auth.json", "installation_id", "app-server-control", "app-server-daemon", "mcp-oauth-locks"].map(str::to_owned).to_vec(),
        resumes: false,
        extra: "https://developers.openai.com/codex/pricing".into(),
        label: "Codex".into(),
    }
}

#[derive(Debug)]
pub struct CodexHarness {
    info: HarnessInfo,
    found: Mutex<Found>,
    login: HarnessLogin,
    accounts: HarnessAccounts,
}

impl Default for CodexHarness {
    fn default() -> Self {
        Self { info: info(), found: Mutex::new(Found::default()), login: login(), accounts: accounts() }
    }
}

fn codex_home(sys: &dyn HarnessSys) -> String {
    sys.env("CODEX_HOME").filter(|h| !h.is_empty()).unwrap_or_else(|| format!("{}/.codex", sys.home()))
}

/// Where codex lives when it isn't on PATH (v1 `fallbackBins`).
fn fallback_bins(home: &str, platform: &str) -> Vec<String> {
    if platform == "win32" {
        return vec![format!("{home}\\.codex\\packages\\standalone\\current\\bin\\codex.exe"), format!("{home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe")];
    }
    let mut out = vec![format!("{home}/.codex/packages/standalone/current/bin/codex")];
    if platform == "darwin" {
        for d in ["/Applications".to_owned(), format!("{home}/Applications")] {
            out.push(format!("{d}/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"));
            out.push(format!("{d}/Codex.app/Contents/Resources/codex"));
        }
    }
    if platform == "linux" {
        out.push("/usr/lib/chatgpt/resources/codex".into());
    }
    out
}

async fn output(sys: &dyn HarnessSys, bin: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    let req = ExecReq { program: bin.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect(), timeout_ms, ..ExecReq::default() };
    match sys.exec(req).await {
        Ok(o) if o.code == Some(0) && !o.timed_out => Some(o.stdout),
        _ => None,
    }
}

fn models_in(v: &Value) -> Option<Vec<Value>> {
    v.get("models").and_then(Value::as_array).filter(|m| !m.is_empty()).cloned()
}

/// The top-level `model = "…"` in config.toml (before any [table]).
fn configured_model(config: &str) -> Option<String> {
    let top = config.split("\n[").next().unwrap_or("");
    top.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        (k.trim() == "model").then(|| v.trim().trim_matches(['"', '\'']).to_owned())
    })
}

/// v1 detect's catalog: what codex's own /model picker lists, best first, with each model's levels.
fn catalog_models(list: &[Value]) -> Vec<HarnessModel> {
    let mut list: Vec<&Value> = list.iter().filter(|m| m["slug"].is_string() && m["visibility"] == "list").collect();
    list.sort_by(|a, b| a["priority"].as_f64().unwrap_or(1e9).total_cmp(&b["priority"].as_f64().unwrap_or(1e9)));
    list.iter()
        .map(|m| {
            let slug = m["slug"].as_str().unwrap_or_default().to_owned();
            let efforts = m["supported_reasoning_levels"].as_array().map(|l| l.iter().filter_map(|x| x["effort"].as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let hint = m["description"].as_str().filter(|d| !d.is_empty()).unwrap_or(&slug).to_owned();
            HarnessModel { id: slug.clone(), label: m["display_name"].as_str().filter(|d| !d.is_empty()).unwrap_or(&slug).to_owned(), hint: Some(clip(&hint, 60)), efforts }
        })
        .collect()
}

impl CodexHarness {
    fn found(&self) -> Found {
        self.found.lock().map(|f| f.clone()).unwrap_or_default()
    }

    async fn find_bin(sys: &dyn HarnessSys) -> Option<(String, String)> {
        if let Some(b) = sys.env("WISP_CODEX_BIN").filter(|b| !b.is_empty()) {
            let v = output(sys, &b, &["--version"], 10_000).await.unwrap_or_default();
            return Some((b, v));
        }
        let mut tries: Vec<String> = sys.which(DEFAULT_BIN).await.into_iter().collect();
        tries.extend(fallback_bins(&sys.home(), &sys.platform()));
        for b in tries {
            if let Some(v) = output(sys, &b, &["--version"], 10_000).await {
                return Some((b, v));
            }
        }
        None
    }
}

impl Harness for CodexHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let Some((bin, line)) = Self::find_bin(sys).await else {
                return HarnessFound { available: false, error: Some("Codex isn't installed".into()), ..HarnessFound::default() };
            };
            let version = Some(version_in(&line)).filter(|v| !v.is_empty());
            let home = codex_home(sys);
            let config = sys.read_file(&format!("{home}/config.toml")).await.unwrap_or_default();
            let v = version_triple(version.as_deref().unwrap_or(""));
            let at_least = v.len() == 3 && (v[0], v[1], v[2]) >= (0, 53, 0);
            let own = config.lines().any(|l| l.trim_start().starts_with("developer_instructions") && l.contains('='));
            if let Ok(mut f) = self.found.lock() {
                *f = Found { bin: Some(bin.clone()), developer: at_least && sys.platform() != "win32" && !own };
            }
            let mut list = None;
            if let Some(out) = output(sys, &bin, &["debug", "models"], 10_000).await {
                list = serde_json::from_str::<Value>(&out).ok().as_ref().and_then(models_in);
            }
            if list.is_none() {
                list = sys.read_file(&format!("{home}/models_cache.json")).await.and_then(|t| serde_json::from_str::<Value>(&t).ok()).as_ref().and_then(models_in);
            }
            let models = catalog_models(&list.unwrap_or_default());
            let mut found = HarnessFound { available: true, version, bin: Some(bin), ..HarnessFound::default() };
            if !models.is_empty() {
                // Default runs the model config.toml names, else codex's first choice: it takes those levels
                let want = configured_model(&config);
                let def = models.iter().find(|m| Some(&m.id) == want.as_ref()).unwrap_or(&models[0]);
                if !def.efforts.is_empty() {
                    found.efforts = Some(def.efforts.clone());
                }
                let mut all = vec![self.info.models[0].clone()];
                all.extend(models);
                found.models = Some(all);
            }
            found
        })
    }

    fn program(&self) -> Option<String> {
        Some(self.found().bin.or_else(|| std::env::var("WISP_CODEX_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned()))
    }

    fn launch(&self, run: &HarnessRun) -> Result<Launch> {
        let f = self.found();
        let bin = run.bin.clone().or(f.bin).or_else(|| std::env::var("WISP_CODEX_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned());
        Ok(launch(run, &bin, f.developer))
    }

    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        let paths = RunPaths::same(run.cwd.clone());
        let parser = CodexParser::new(CodexOptions { paths: paths.clone(), resume_id: run.resume_id.clone(), fork: run.fork, prior: run.prior.clone() });
        driver::KitDriver::boxed(parser, paths, true)
    }

    /// A read of the account's windows that spends nothing (v1 live-limits.js `readCodex`): one
    /// `account/rateLimits/read` over `codex app-server`'s stdio, as Codex's own status line does.
    fn live_limits<'a>(&'a self, sys: &'a dyn HarnessSys, env: &'a std::collections::BTreeMap<String, String>) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move {
            let bin = self.program().unwrap_or_else(|| DEFAULT_BIN.to_owned());
            let msgs = [
                serde_json::json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "wisp", "version": "1" } } }),
                serde_json::json!({ "method": "initialized" }),
                serde_json::json!({ "id": 2, "method": "account/rateLimits/read" }),
            ];
            let stdin = msgs.iter().flat_map(|m| format!("{m}\n").into_bytes()).collect::<Vec<u8>>();
            let req = ExecReq { program: bin, args: vec!["app-server".into()], env: env.clone(), stdin: Some(stdin), timeout_ms: 15_000, ..ExecReq::default() };
            let out = sys.exec(req).await.ok()?;
            out.stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|m| m["id"] == 2).and_then(|m| m.get("result").cloned())
        })
    }

    fn login(&self) -> Option<&HarnessLogin> {
        Some(&self.login)
    }

    fn signed_in(&self, out: &str, _code: Option<i32>) -> Option<bool> {
        if NOT_IN.is_match(out) {
            Some(false)
        } else if IN.is_match(out) {
            Some(true)
        } else {
            None
        }
    }

    fn auth_failed(&self, text: &str) -> bool {
        text.len() <= 1200 && AUTH_FAILED.is_match(text)
    }

    fn accounts(&self) -> Option<&HarnessAccounts> {
        Some(&self.accounts)
    }

    fn setup(&self, platform: &str) -> Option<SetupTip> {
        Some(SetupTip {
            tip: if platform == "win32" {
                "Install the Codex CLI and run codex once to sign in. On Windows the ChatGPT app’s built-in Codex can’t be run from outside the app"
            } else {
                "Install the Codex CLI and run codex once to sign in. Or install the ChatGPT desktop app and sign in there: wisp uses the Codex inside it"
            }
            .into(),
            command: Some("npm i -g @openai/codex".into()),
            url: Some("https://github.com/openai/codex".into()),
        })
    }

    fn resume_command(&self, o: &ResumeOptions) -> Option<ResumeCommand> {
        let mut argv = vec![self.found().bin.unwrap_or_else(|| DEFAULT_BIN.to_owned())];
        if let Some(r) = o.resume_id.as_ref().filter(|r| !r.is_empty()) {
            argv.extend(["resume".to_owned(), r.clone()]);
        }
        if !o.model.is_empty() {
            argv.extend(["--model".to_owned(), o.model.clone()]);
        }
        if !o.effort.is_empty() {
            argv.extend(["-c".to_owned(), format!("model_reasoning_effort={}", toml(&Value::String(o.effort.clone())))]);
        }
        if let Some(p) = o.prompt.as_ref().filter(|p| !p.is_empty()) {
            argv.push(p.clone());
        }
        Some(ResumeCommand { argv, types_prompt: false })
    }

    /// Interactive codex asks to trust a folder `exec` never asked about: record the yes as codex does,
    /// a `[projects."<dir>"]` table with `trust_level = "trusted"`. A table already there stays.
    fn trust<'a>(&'a self, sys: &'a dyn HarnessSys, dir: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let file = format!("{}/config.toml", codex_home(sys));
            let text = sys.read_file(&file).await.unwrap_or_default();
            let quoted = Value::String(dir.to_owned()).to_string();
            if text.contains(&format!("[projects.{quoted}]")) || text.contains(&format!("[projects.'{dir}']")) {
                return Ok(());
            }
            let sep = if !text.is_empty() && !text.ends_with('\n') { "\n" } else { "" };
            // a read-only home: codex asks, as before
            let _ = sys.write_file(&file, format!("{text}{sep}\n[projects.{quoted}]\ntrust_level = \"trusted\"\n")).await;
            Ok(())
        })
    }
}

#[derive(Debug, Default)]
pub struct CodexPlugin;

impl Plugin for CodexPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(CodexHarness::default());
        s.contribute(&HARNESS, h);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(CodexPlugin.manifest().id, "wisp.codex");
    }

    #[test]
    fn the_catalog_is_what_the_picker_lists_best_first() {
        // v1 adapters.test.js "codex: detect lists the catalog"
        let list = json!([
            { "slug": "gpt-9-mini", "display_name": "GPT-9-Mini", "description": "Small", "visibility": "list", "priority": 9, "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }] },
            { "slug": "codex-auto-review", "display_name": "Codex Auto Review", "visibility": "hide", "priority": 1 },
            { "slug": "gpt-9", "display_name": "GPT-9", "description": "Big", "visibility": "list", "priority": 2, "supported_reasoning_levels": [{ "effort": "medium" }, { "effort": "max" }] }
        ]);
        let m = catalog_models(list.as_array().map_or(&[][..], Vec::as_slice));
        assert_eq!(m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["gpt-9", "gpt-9-mini"]);
        assert_eq!(m[1].efforts, ["low", "high"]);
        assert_eq!(configured_model("model = \"gpt-9-mini\"\n\n[profiles.x]\nmodel = \"gpt-9\"\n").as_deref(), Some("gpt-9-mini"));
    }

    #[test]
    fn resume_command_is_v1s() {
        let h = CodexHarness::default();
        let o = ResumeOptions { resume_id: Some("prev-1".into()), model: "gpt-9".into(), effort: "high".into(), ..ResumeOptions::default() };
        assert_eq!(h.resume_command(&o).map(|c| c.argv).unwrap_or_default(), ["codex", "resume", "prev-1", "--model", "gpt-9", "-c", "model_reasoning_effort=\"high\""]);
    }

    #[test]
    fn signing_in_in_its_own_words() {
        let h = CodexHarness::default();
        assert!(AUTH_FAILED.compiles() && NOT_IN.compiles() && IN.compiles());
        assert_eq!((h.signed_in("Not logged in", Some(1)), h.signed_in("Logged in using ChatGPT", Some(0)), h.signed_in("?", None)), (Some(false), Some(true), None));
        assert!(h.auth_failed("Your access token could not be refreshed"));
        assert_eq!(h.accounts().map(|a| a.env.as_str()), Some("CODEX_HOME"));
    }

    #[test]
    fn fallbacks_per_os() {
        assert!(fallback_bins("/Users/me", "darwin").iter().any(|b| b.contains("ChatGPT.app")));
        assert!(fallback_bins("/home/me", "linux").iter().any(|b| b == "/usr/lib/chatgpt/resources/codex"));
    }
}
