//! wisp.grok: Grok Build as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes (v1 adapters/grok.js): the CLI's description, `detect` (`WISP_GROK_BIN` or
//! `grok` on PATH; `grok models` with each model's levels from `$GROK_HOME/models_cache.json`), the
//! launch (the prompt as a launch file, the protocol with `--rules`, wisp's MCP server through a
//! throwaway agent definition), a driver over `wisp-grok-core`'s parser with the file tracker on, and
//! the resume command (its TUI takes no first prompt: wisp types it in).

mod driver;
pub mod sessions;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_grok_core::{GrokArgs, GrokParser, agent_definition, args, efforts_of, model_ids};
use wisp_harness_kit::detect::version_in;
use wisp_harness_kit::protocol::{FileNote, attachment_note};
use wisp_harness_kit::{RunPaths, clip};
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::harness::{
    ExecReq, HarnessFound, HarnessInfo, HarnessModel, HarnessRun, HarnessSys, Launch, LaunchFile, ResumeCommand, ResumeOptions, RunDriver,
    SetupTip,
};
use wisp_runtime_api::model::Mode;
use wisp_runtime_api::{HARNESS, Harness};

pub const DEFAULT_BIN: &str = "grok";

pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "grok".into(),
        name: "Grok".into(),
        models: vec![HarnessModel {
            id: String::new(),
            label: "Default".into(),
            hint: Some("Whatever Grok is set to".into()),
            efforts: Vec::new(),
        }],
        efforts: ["low", "medium", "high", "xhigh"].map(str::to_owned).to_vec(),
        ask_tool: Some("wisp__ask_user".into()),
        system_prompt_flag: true,
        ..HarnessInfo::default()
    }
}

fn mode(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// grok -p doesn't read stdin, and a prompt in argv is capped on Windows: it goes as a file.
pub fn launch(run: &HarnessRun, bin: &str) -> Launch {
    let notes: Vec<FileNote> =
        run.attachments.iter().filter_map(|a| a.path.clone().map(|path| FileNote { path, mime: a.mime.clone(), size: a.size })).collect();
    let mut files =
        vec![LaunchFile { path: "grok-prompt.md".into(), contents: format!("{}{}", run.prompt, attachment_note(&notes, None)) }];
    let agent = (!run.mcp_servers.is_empty()).then_some("{tmp}/grok-wisp.md");
    if agent.is_some() {
        files.push(LaunchFile { path: "grok-wisp.md".into(), contents: agent_definition(&run.mcp_servers) });
    }
    let a = GrokArgs {
        prompt_file: "{tmp}/grok-prompt.md",
        mode: mode(run.mode),
        rules: &run.system_prompt,
        model: &run.model,
        effort: &run.effort,
        resume_id: run.resume_id.as_deref(),
        agent_file: agent,
    };
    Launch {
        program: bin.to_owned(),
        args: args(&a),
        env: BTreeMap::from([("GROK_DISABLE_AUTOUPDATER".to_owned(), "1".to_owned())]),
        cwd: run.cwd.clone(),
        files,
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

/// `grok models` with each id's name, hint and levels from grok's cached catalog.
fn models_of(out: &str, cache: &Value) -> (Vec<HarnessModel>, Option<Vec<String>>) {
    let (ids, def) = model_ids(out);
    let models: Vec<HarnessModel> = ids
        .into_iter()
        .map(|id| {
            let info = &cache["models"][&id]["info"];
            let efforts =
                if info["supports_reasoning_effort"] == false { Some(Vec::new()) } else { efforts_of(&info["reasoning_efforts"]) };
            HarnessModel {
                label: info["name"].as_str().unwrap_or(&id).to_owned(),
                hint: Some(clip(info["description"].as_str().unwrap_or(&id), 60)),
                efforts: efforts.unwrap_or_default(),
                id,
            }
        })
        .collect();
    // Default runs grok's own default, so it takes that model's levels
    let levels = def.and_then(|d| models.iter().find(|m| m.id == d)).map(|m| m.efforts.clone()).filter(|e| !e.is_empty());
    (models, levels)
}

#[derive(Debug)]
pub struct GrokHarness {
    info: HarnessInfo,
    bin: Mutex<Option<String>>,
}

impl Default for GrokHarness {
    fn default() -> Self {
        Self { info: info(), bin: Mutex::new(None) }
    }
}

impl GrokHarness {
    fn bin(&self) -> String {
        self.bin
            .lock()
            .ok()
            .and_then(|b| b.clone())
            .or_else(|| std::env::var("WISP_GROK_BIN").ok().filter(|b| !b.is_empty()))
            .unwrap_or_else(|| DEFAULT_BIN.to_owned())
    }
}

impl Harness for GrokHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }
    fn vendor(&self) -> Option<&str> {
        Some("xai")
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let bin = match sys.env("WISP_GROK_BIN").filter(|b| !b.is_empty()) {
                Some(b) => Some(b),
                None => sys.which(DEFAULT_BIN).await,
            };
            let Some(bin) = bin else {
                return HarnessFound { available: false, error: Some("Grok isn't installed".into()), ..HarnessFound::default() };
            };
            let Some(line) = output(sys, &bin, &["--version"]).await else {
                return HarnessFound { available: false, error: Some("grok --version failed".into()), ..HarnessFound::default() };
            };
            if let Ok(mut b) = self.bin.lock() {
                *b = Some(bin.clone());
            }
            let v = version_in(&line);
            let mut found = HarnessFound {
                available: true,
                version: Some(if v.is_empty() { line.trim().to_owned() } else { v }),
                bin: Some(bin.clone()),
                ..HarnessFound::default()
            };
            let home = sys.env("GROK_HOME").filter(|h| !h.is_empty()).unwrap_or_else(|| format!("{}/.grok", sys.home()));
            let cache = sys
                .read_file(&format!("{home}/models_cache.json"))
                .await
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(Value::Null);
            let (models, levels) = models_of(&output(sys, &bin, &["models"]).await.unwrap_or_default(), &cache);
            if !models.is_empty() {
                found.efforts = levels;
                let mut all = vec![self.info.models[0].clone()];
                all.extend(models);
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
        driver::KitDriver::boxed(GrokParser::new(paths.clone()), paths, true)
    }

    fn setup(&self, _platform: &str) -> Option<SetupTip> {
        Some(SetupTip { tip: "Install Grok Build (grok) and sign in".into(), command: None, url: Some("https://x.ai/cli".into()) })
    }

    fn resume_command(&self, o: &ResumeOptions) -> Option<ResumeCommand> {
        let mut argv = vec![self.bin()];
        if let Some(r) = o.resume_id.as_ref().filter(|r| !r.is_empty()) {
            argv.extend(["--resume".to_owned(), r.clone()]);
        }
        if !o.model.is_empty() {
            argv.extend(["--model".to_owned(), o.model.clone()]);
        }
        if !o.effort.is_empty() {
            argv.extend(["--reasoning-effort".to_owned(), o.effort.clone()]);
        }
        if o.trusted {
            argv.push("--trust".into());
        }
        Some(ResumeCommand { argv, types_prompt: true })
    }
}

#[derive(Debug, Default)]
pub struct GrokPlugin;

impl Plugin for GrokPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(GrokHarness::default());
        s.contribute(&HARNESS, h);
        let sessions: Arc<dyn wisp_runtime_api::harness::sessions::HarnessSessions> = Arc::new(crate::sessions::GrokSessions::from_env());
        s.contribute(&wisp_runtime_api::harness::sessions::SESSIONS, sessions);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(GrokPlugin.manifest().id, "wisp.grok");
    }

    #[test]
    fn detect_reads_each_models_levels_from_the_cache() {
        // v1 adapters.test.js: GROK_HOME's models_cache.json gives grok-9 its levels
        let cache = json!({ "models": { "grok-9": { "info": { "name": "Grok 9", "description": "Big", "supports_reasoning_effort": true, "reasoning_efforts": [{ "id": "xhigh" }, { "id": "high" }, { "id": "low" }] } } } });
        let (m, levels) = models_of("  * grok-9 (default)\n  - grok-8\n", &cache);
        assert_eq!((m[0].label.as_str(), m[0].efforts.len(), m[1].label.as_str()), ("Grok 9", 3, "grok-8"));
        assert_eq!(levels, Some(vec!["low".to_owned(), "high".to_owned(), "xhigh".to_owned()]));
    }

    #[test]
    fn the_prompt_and_agent_go_as_files() {
        let mut run =
            HarnessRun { prompt: "fix".into(), cwd: "/w".into(), system_prompt: "SYS".into(), mode: Mode::Plan, ..HarnessRun::default() };
        run.mcp_servers.insert("wisp".into(), json!({ "type": "http", "url": "http://x/api/mcp" }));
        let l = launch(&run, "grok");
        assert_eq!(&l.args[..2], ["--prompt-file", "{tmp}/grok-prompt.md"]);
        assert!(l.args.windows(2).any(|w| w == ["--rules", "SYS"]) && l.args.windows(2).any(|w| w == ["--agent", "{tmp}/grok-wisp.md"]));
        assert_eq!((l.files.len(), l.files[0].contents.as_str()), (2, "fix"));
    }
}
