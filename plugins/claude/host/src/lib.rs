//! wisp.claude: Claude Code as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes: the CLI's description (models, efforts, flags), `detect` (`WISP_CLAUDE_BIN`,
//! else `claude` on PATH, then `--version`), the launch (`launch.rs`, v1 adapters/claude.js `run()`)
//! and a driver over `wisp-claude-core`'s stream-json parser. Everything that touches the system goes
//! through the runtime's `HarnessSys`.

mod driver;
mod launch;

use std::sync::{Arc, Mutex};

use wisp_claude_core::{ClaudeOptions, ClaudeParser};
use wisp_harness_kit::RunPaths;
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::harness::{ExecReq, HarnessFound, HarnessInfo, HarnessModel, HarnessRun, HarnessSys, Launch, RunDriver, SetupTip};
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

/// The harness. `bin`: what the last detect found, used when a run names none.
#[derive(Debug)]
pub struct ClaudeHarness {
    info: HarnessInfo,
    bin: Mutex<Option<String>>,
}

impl Default for ClaudeHarness {
    fn default() -> Self {
        Self { info: info(), bin: Mutex::new(None) }
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

    fn launch(&self, run: &HarnessRun) -> Result<Launch> {
        let bin = run.bin.clone().or_else(|| self.found_bin()).or_else(|| std::env::var("WISP_CLAUDE_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned());
        Ok(launch(run, &bin))
    }

    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        let paths = RunPaths::same(run.cwd.clone());
        let parser = ClaudeParser::new(ClaudeOptions { paths: paths.clone(), prior: run.prior.clone(), unknown_prior: run.unknown_prior });
        driver::KitDriver::boxed(parser, paths, false)
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
    fn info_is_v1s() {
        let i = info();
        assert_eq!((i.id.as_str(), i.models.len(), i.efforts.len()), ("claude", 4, 5));
        assert!(i.fork && i.reports_cli && i.system_prompt_flag);
    }

    #[test]
    fn a_run_launches_what_detect_found() {
        let h = ClaudeHarness::default();
        let run = HarnessRun { bin: Some("/opt/claude".into()), prompt: "hi".into(), ..HarnessRun::default() };
        assert_eq!(h.launch(&run).map(|l| l.program).ok().as_deref(), Some("/opt/claude"));
    }
}
