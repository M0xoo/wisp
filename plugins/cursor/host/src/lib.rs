//! wisp.cursor: the Cursor CLI as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes (v1 adapters/cursor.js): the CLI's description (no ask tool: cursor-agent
//! takes no MCP server by flag), `detect` (`WISP_CURSOR_BIN` or `cursor-agent` on PATH, its version,
//! `--list-models`), the launch, a driver over `wisp-cursor-core`'s parser with the file tracker on,
//! and the resume command.

mod driver;

use std::sync::{Arc, Mutex};

use wisp_cursor_core::{CursorParser, args, list_models};
use wisp_harness_kit::RunPaths;
use wisp_harness_kit::detect::version_in;
use wisp_harness_kit::protocol::{FileNote, attachment_note};
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::harness::{ExecReq, HarnessFound, HarnessInfo, HarnessModel, HarnessRun, HarnessSys, Launch, ResumeCommand, ResumeOptions, RunDriver, SetupTip, Stdin};
use wisp_runtime_api::model::Mode;
use wisp_runtime_api::{HARNESS, Harness};

pub const DEFAULT_BIN: &str = "cursor-agent";

pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "cursor".into(),
        name: "Cursor".into(),
        models: vec![HarnessModel { id: String::new(), label: "Default".into(), hint: Some("Whatever Cursor is set to".into()), efforts: Vec::new() }],
        ..HarnessInfo::default()
    }
}

async fn output(sys: &dyn HarnessSys, bin: &str, args: &[&str]) -> Option<String> {
    let req = ExecReq { program: bin.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect(), timeout_ms: 15_000, ..ExecReq::default() };
    match sys.exec(req).await {
        Ok(o) if o.code == Some(0) && !o.timed_out => Some(o.stdout),
        _ => None,
    }
}

fn mode(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// The launch (the runtime already put wisp's protocol ahead of a new chat's prompt).
pub fn launch(run: &HarnessRun, bin: &str) -> Launch {
    let notes: Vec<FileNote> = run.attachments.iter().filter_map(|a| a.path.clone().map(|path| FileNote { path, mime: a.mime.clone(), size: a.size })).collect();
    let input = format!("{}{}", run.prompt, attachment_note(&notes, None));
    Launch { program: bin.to_owned(), args: args(mode(run.mode), &run.model, run.resume_id.as_deref()), cwd: run.cwd.clone(), stdin: Stdin::Bytes(input.into_bytes()), ..Launch::default() }
}

#[derive(Debug)]
pub struct CursorHarness {
    info: HarnessInfo,
    bin: Mutex<Option<String>>,
}

impl Default for CursorHarness {
    fn default() -> Self {
        Self { info: info(), bin: Mutex::new(None) }
    }
}

impl CursorHarness {
    fn bin(&self) -> String {
        self.bin.lock().ok().and_then(|b| b.clone()).or_else(|| std::env::var("WISP_CURSOR_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned())
    }
}

impl Harness for CursorHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let bin = match sys.env("WISP_CURSOR_BIN").filter(|b| !b.is_empty()) {
                Some(b) => Some(b),
                None => sys.which(DEFAULT_BIN).await,
            };
            let Some(bin) = bin else {
                return HarnessFound { available: false, error: Some("Cursor isn't installed".into()), ..HarnessFound::default() };
            };
            let Some(line) = output(sys, &bin, &["--version"]).await else {
                return HarnessFound { available: false, error: Some("cursor-agent --version failed".into()), ..HarnessFound::default() };
            };
            if let Ok(mut b) = self.bin.lock() {
                *b = Some(bin.clone());
            }
            let mut models = vec![self.info.models[0].clone()];
            models.extend(list_models(&output(sys, &bin, &["--list-models"]).await.unwrap_or_default()).into_iter().map(|(id, label)| HarnessModel { hint: Some(id.clone()), id, label, efforts: Vec::new() }));
            let v = version_in(&line);
            HarnessFound { available: true, version: Some(if v.is_empty() { line.trim().to_owned() } else { v }), bin: Some(bin), models: Some(models), ..HarnessFound::default() }
        })
    }

    fn program(&self) -> Option<String> {
        Some(self.bin())
    }

    fn launch(&self, run: &HarnessRun) -> Result<Launch> {
        Ok(launch(run, &run.bin.clone().unwrap_or_else(|| self.bin())))
    }

    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        let paths = RunPaths::same(run.cwd.clone());
        driver::KitDriver::boxed(CursorParser::new(paths.clone()), paths, true)
    }

    fn setup(&self, platform: &str) -> Option<SetupTip> {
        Some(SetupTip {
            tip: "Install the Cursor CLI, then run cursor-agent login. The Cursor editor doesn’t include it".into(),
            command: (platform != "win32").then(|| "curl https://cursor.com/install -fsS | bash".into()),
            url: Some("https://cursor.com/cli".into()),
        })
    }

    fn resume_command(&self, o: &ResumeOptions) -> Option<ResumeCommand> {
        let mut argv = vec![self.bin()];
        if let Some(r) = o.resume_id.as_ref().filter(|r| !r.is_empty()) {
            argv.extend(["--resume".to_owned(), r.clone()]);
        }
        if !o.model.is_empty() {
            argv.extend(["--model".to_owned(), o.model.clone()]);
        }
        // a folder wisp made, which it would otherwise stop to ask about
        if o.trusted {
            argv.push("--trust".into());
        }
        if let Some(p) = o.prompt.as_ref().filter(|p| !p.is_empty()) {
            argv.push(p.clone());
        }
        Some(ResumeCommand { argv, types_prompt: false })
    }
}

#[derive(Debug, Default)]
pub struct CursorPlugin;

impl Plugin for CursorPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(CursorHarness::default());
        s.contribute(&HARNESS, h);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(CursorPlugin.manifest().id, "wisp.cursor");
        assert!(info().ask_tool.is_none(), "no MCP by flag: a question block instead");
    }

    #[test]
    fn launch_and_resume() {
        let run = HarnessRun { prompt: "p".into(), cwd: "/w".into(), mode: Mode::Auto, model: "m-1".into(), ..HarnessRun::default() };
        assert_eq!(launch(&run, "cursor-agent").args, ["-p", "--output-format", "stream-json", "--trust", "--force", "--model", "m-1"]);
        let h = CursorHarness::default();
        let o = ResumeOptions { resume_id: Some("c1".into()), trusted: true, prompt: Some("go".into()), ..ResumeOptions::default() };
        assert_eq!(h.resume_command(&o).map(|c| c.argv[1..].to_vec()).unwrap_or_default(), ["--resume", "c1", "--trust", "go"]);
    }
}
