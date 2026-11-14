//! wisp.copilot: the GitHub Copilot CLI as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes (v1 adapters/copilot.js): the CLI's description, `detect` (`WISP_COPILOT_BIN`
//! or `copilot` on PATH; its models from `copilot help config`, its efforts from `--help`), the launch
//! (a new session gets its id up front: the turn's id), a driver over `wisp-copilot-core`'s parser
//! with the file tracker on, the resume command and folder trust (`trusted_folders`).

mod driver;

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_copilot_core::{CopilotArgs, CopilotParser, args, model_ids, model_label};
use wisp_harness_kit::RunPaths;
use wisp_harness_kit::detect::{help_efforts, version_in};
use wisp_harness_kit::protocol::{FileNote, attachment_note};
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::harness::{
    ExecReq, HarnessFound, HarnessInfo, HarnessModel, HarnessRun, HarnessSys, Launch, ResumeCommand, ResumeOptions, RunDriver, SetupTip,
    Stdin,
};
use wisp_runtime_api::model::Mode;
use wisp_runtime_api::{HARNESS, Harness};

pub const DEFAULT_BIN: &str = "copilot";

pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "copilot".into(),
        name: "Copilot".into(),
        models: vec![HarnessModel {
            id: String::new(),
            label: "Default".into(),
            hint: Some("Whatever Copilot is set to".into()),
            efforts: Vec::new(),
        }],
        efforts: ["low", "medium", "high", "xhigh"].map(str::to_owned).to_vec(),
        ask_tool: Some("wisp-ask_user".into()),
        session_ids: true,
        ..HarnessInfo::default()
    }
}

fn is_image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp")
}

fn dir_of(p: &str) -> String {
    match p.rfind(['/', '\\']) {
        Some(0) => "/".to_owned(),
        Some(i) => p[..i].to_owned(),
        None => ".".to_owned(),
    }
}

fn mode(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// The session a run continues, or the id a new one gets (the turn's, a uuid).
pub fn session_of(run: &HarnessRun) -> String {
    run.resume_id
        .clone()
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| if run.turn_id.is_empty() { run.session_id.clone() } else { run.turn_id.clone() })
}

/// The launch (the runtime already put wisp's protocol ahead of a new session's prompt).
pub fn launch(run: &HarnessRun, bin: &str) -> Launch {
    let with_path: Vec<_> = run.attachments.iter().filter(|a| a.path.is_some()).collect();
    let images: Vec<String> = with_path.iter().filter(|a| is_image(&a.mime)).filter_map(|a| a.path.clone()).collect();
    let dirs: Vec<String> = run.dirs.iter().cloned().chain(with_path.iter().filter_map(|a| a.path.as_deref().map(dir_of))).collect();
    let session = session_of(run);
    let a = CopilotArgs {
        mode: mode(run.mode),
        model: &run.model,
        effort: &run.effort,
        resume_id: run.resume_id.as_deref(),
        session: &session,
        usage_file: "{tmp}/copilot-usage.json",
        mcp_servers: Some(&run.mcp_servers),
        grants: &run.grants,
        delegating: run.delegating,
        images: &images,
        dirs: &dirs,
    };
    let notes: Vec<FileNote> = with_path
        .iter()
        .filter(|a| !is_image(&a.mime))
        .map(|a| FileNote { path: a.path.clone().unwrap_or_default(), mime: a.mime.clone(), size: a.size })
        .collect();
    let input = format!("{}{}", run.prompt, attachment_note(&notes, Some("Read them with your view tool")));
    Launch {
        program: bin.to_owned(),
        args: args(&a),
        // COPILOT_ALLOW_ALL in the user's shell would lift the mode wisp picked
        env_remove: if run.mode == Mode::Auto { Vec::new() } else { vec!["COPILOT_ALLOW_ALL".into()] },
        cwd: run.cwd.clone(),
        stdin: Stdin::Bytes(input.into_bytes()),
        ..Launch::default()
    }
}

async fn output(sys: &dyn HarnessSys, bin: &str, args: &[&str]) -> Option<String> {
    let req =
        ExecReq { program: bin.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect(), timeout_ms: 15_000, ..ExecReq::default() };
    match sys.exec(req).await {
        Ok(o) if o.code == Some(0) && !o.timed_out => Some(o.stdout),
        _ => None,
    }
}

#[derive(Debug)]
pub struct CopilotHarness {
    info: HarnessInfo,
    bin: Mutex<Option<String>>,
}

impl Default for CopilotHarness {
    fn default() -> Self {
        Self { info: info(), bin: Mutex::new(None) }
    }
}

impl CopilotHarness {
    fn bin(&self) -> String {
        self.bin
            .lock()
            .ok()
            .and_then(|b| b.clone())
            .or_else(|| std::env::var("WISP_COPILOT_BIN").ok().filter(|b| !b.is_empty()))
            .unwrap_or_else(|| DEFAULT_BIN.to_owned())
    }
}

impl Harness for CopilotHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let bin = match sys.env("WISP_COPILOT_BIN").filter(|b| !b.is_empty()) {
                Some(b) => Some(b),
                None => sys.which(DEFAULT_BIN).await,
            };
            let Some(bin) = bin else {
                return HarnessFound { available: false, error: Some("Copilot isn't installed".into()), ..HarnessFound::default() };
            };
            let Some(line) = output(sys, &bin, &["--version"]).await else {
                return HarnessFound { available: false, error: Some("copilot --version failed".into()), ..HarnessFound::default() };
            };
            if let Ok(mut b) = self.bin.lock() {
                *b = Some(bin.clone());
            }
            let ids = model_ids(&output(sys, &bin, &["help", "config"]).await.unwrap_or_default());
            let efforts = help_efforts(&output(sys, &bin, &["--help"]).await.unwrap_or_default());
            let v = version_in(&line);
            let mut found = HarnessFound {
                available: true,
                version: Some(if v.is_empty() { line.trim().to_owned() } else { v }),
                bin: Some(bin),
                ..HarnessFound::default()
            };
            if !efforts.is_empty() {
                found.efforts = Some(efforts);
            }
            if !ids.is_empty() {
                let mut all = vec![self.info.models[0].clone()];
                all.extend(ids.into_iter().map(|id| HarnessModel {
                    label: model_label(&id),
                    hint: Some(id.clone()),
                    id,
                    efforts: Vec::new(),
                }));
                found.models = Some(all);
            }
            found
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
        driver::KitDriver::boxed(CopilotParser::new(paths.clone(), session_of(run)), paths, true)
    }

    fn setup(&self, _platform: &str) -> Option<SetupTip> {
        Some(SetupTip {
            tip: "Install the GitHub Copilot CLI, then run copilot login. It needs a GitHub Copilot plan".into(),
            command: Some("npm i -g @github/copilot".into()),
            url: Some("https://github.com/features/copilot/cli".into()),
        })
    }

    fn resume_command(&self, o: &ResumeOptions) -> Option<ResumeCommand> {
        let mut argv = vec![self.bin()];
        if let Some(r) = o.resume_id.as_ref().filter(|r| !r.is_empty()) {
            argv.push(format!("--resume={r}"));
        }
        if !o.model.is_empty() {
            argv.extend(["--model".to_owned(), o.model.clone()]);
        }
        if !o.effort.is_empty() {
            argv.extend(["--reasoning-effort".to_owned(), o.effort.clone()]);
        }
        if let Some(p) = o.prompt.as_ref().filter(|p| !p.is_empty()) {
            argv.extend(["-i".to_owned(), p.clone()]);
        }
        Some(ResumeCommand { argv, types_prompt: false })
    }

    /// Interactive copilot asks to trust a folder: add it to `trusted_folders` in its config.json.
    fn trust<'a>(&'a self, sys: &'a dyn HarnessSys, dir: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let home = sys.env("COPILOT_HOME").filter(|h| !h.is_empty()).unwrap_or_else(|| format!("{}/.copilot", sys.home()));
            let file = format!("{home}/config.json");
            let text = sys.read_file(&file).await;
            let Ok(mut cfg) = text.as_deref().map_or(Ok(json!({})), serde_json::from_str::<Value>) else {
                return Ok(()); // unreadable config: copilot asks, as before
            };
            let mut folders = cfg["trusted_folders"].as_array().cloned().unwrap_or_default();
            if folders.iter().any(|f| f == dir) {
                return Ok(());
            }
            folders.push(json!(dir));
            if let Some(o) = cfg.as_object_mut() {
                o.insert("trusted_folders".into(), Value::Array(folders));
            }
            let _ = sys.write_file(&file, format!("{}\n", serde_json::to_string_pretty(&cfg).unwrap_or_default())).await;
            Ok(())
        })
    }
}

#[derive(Debug, Default)]
pub struct CopilotPlugin;

impl Plugin for CopilotPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(CopilotHarness::default());
        s.contribute(&HARNESS, h);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_runtime_api::model::Attachment;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(CopilotPlugin.manifest().id, "wisp.copilot");
    }

    #[test]
    fn a_new_session_is_named_up_front_and_images_attach() {
        // v1 adapters.test.js "copilot is handed a fresh session id rather than making one up"
        let run = HarnessRun {
            prompt: "p".into(),
            cwd: "/w".into(),
            mode: Mode::Edits,
            turn_id: "0190-turn".into(),
            attachments: vec![Attachment { path: Some("/up/a.png".into()), mime: "image/png".into(), size: 1, ..Attachment::default() }],
            ..HarnessRun::default()
        };
        let l = launch(&run, "copilot");
        assert!(l.args.windows(2).any(|w| w == ["--session-id", "0190-turn"]));
        assert!(l.args.windows(2).any(|w| w == ["--attachment", "/up/a.png"]) && l.args.windows(2).any(|w| w == ["--add-dir", "/up"]));
        assert_eq!(l.env_remove, ["COPILOT_ALLOW_ALL"]);
        let resumed = HarnessRun { resume_id: Some("prev-1".into()), ..run };
        assert_eq!(session_of(&resumed), "prev-1");
    }
}
