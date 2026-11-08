//! wisp.opencode: opencode as a module of wisp.runtime (`runtime.harness@1`).
//!
//! What it contributes (v1 adapters/opencode.js): the CLI's description, `detect` (`WISP_OPENCODE_BIN`,
//! else `opencode` on PATH, else the install script's `~/.opencode/bin`; 1.x or 2.x; the models with
//! their variants from `opencode models --verbose`; whether a provider is signed in), the launch
//! (argv plus `OPENCODE_CONFIG_CONTENT` with wisp's MCP server and the user's grants), a driver over
//! `wisp-opencode-core`'s parser with the file tracker on, and the resume command.

mod driver;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use wisp_harness_kit::protocol::{FileNote, attachment_note};
use wisp_harness_kit::{Re, RunPaths};
use wisp_kernel::{BoxFuture, Manifest, Plugin, Result, Setup};
use wisp_opencode_core::{OpencodeArgs, OpencodeOptions, OpencodeParser, RATE_LIMIT_GRACE_MS, args, config, has_key, major_version};
use wisp_runtime_api::harness::{ExecReq, HarnessFound, HarnessInfo, HarnessModel, HarnessRun, HarnessSys, Launch, ResumeCommand, ResumeOptions, RunDriver, SetupTip, Stdin};
use wisp_runtime_api::model::Mode;
use wisp_runtime_api::{HARNESS, Harness};

pub const DEFAULT_BIN: &str = "opencode";

static VERBOSE_MODEL: Re = Re::new(r"(?m)^([\w.-]+/\S+)\n(\{[\s\S]*?\n\})$");
static PLAIN_MODEL: Re = Re::new(r"^[\w.-]+/\S+$");

pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: "opencode".into(),
        name: "opencode".into(),
        models: vec![HarnessModel { id: String::new(), label: "Default".into(), hint: Some("Whatever opencode is set to".into()), efforts: Vec::new() }],
        ask_tool: Some("wisp_ask_user".into()),
        fork: true,
        ..HarnessInfo::default()
    }
}

#[derive(Debug, Clone, Default)]
struct Found {
    bin: Option<String>,
    v2: bool,
}

#[derive(Debug)]
pub struct OpencodeHarness {
    info: HarnessInfo,
    found: Mutex<Found>,
}

impl Default for OpencodeHarness {
    fn default() -> Self {
        Self { info: info(), found: Mutex::new(Found::default()) }
    }
}

async fn output(sys: &dyn HarnessSys, bin: &str, args: &[&str]) -> Option<String> {
    let req = ExecReq { program: bin.to_owned(), args: args.iter().map(|a| (*a).to_owned()).collect(), timeout_ms: 15_000, ..ExecReq::default() };
    match sys.exec(req).await {
        Ok(o) if o.code == Some(0) && !o.timed_out => Some(o.stdout),
        _ => None,
    }
}

fn model(id: &str, efforts: Vec<String>) -> HarnessModel {
    let (provider, name) = id.split_once('/').unwrap_or(("", id));
    HarnessModel { id: id.to_owned(), label: name.to_owned(), hint: Some(provider.to_owned()), efforts }
}

/// `opencode models --verbose`: each id then its JSON, whose `variants` are the efforts it takes.
fn verbose_models(out: &str) -> Vec<HarnessModel> {
    let Some(re) = VERBOSE_MODEL.get() else { return Vec::new() };
    re.captures_iter(out)
        .filter_map(|c| {
            let id = c.get(1)?.as_str();
            let efforts = c.get(2).and_then(|j| serde_json::from_str::<Value>(j.as_str()).ok()).and_then(|v| v["variants"].as_object().map(|o| o.keys().cloned().collect())).unwrap_or_default();
            Some(model(id, efforts))
        })
        .collect()
}

fn plain_models(out: &str) -> Vec<HarnessModel> {
    out.lines().map(str::trim).filter(|l| PLAIN_MODEL.is_match(l)).map(|l| model(l, Vec::new())).collect()
}

fn mode(m: Mode) -> &'static str {
    match m {
        Mode::Plan => "plan",
        Mode::Edits => "edits",
        Mode::Auto => "auto",
    }
}

/// The launch for `run` (the runtime already put wisp's protocol ahead of a new session's prompt).
pub fn launch(run: &HarnessRun, bin: &str, v2: bool, user_config: Option<&str>) -> Launch {
    let files: Vec<String> = run.attachments.iter().filter_map(|a| a.path.clone()).collect();
    let a = OpencodeArgs { mode: mode(run.mode), model: &run.model, effort: &run.effort, resume_id: run.resume_id.as_deref(), fork: run.fork, attachments: &files, v2 };
    let mut env = BTreeMap::new();
    if let Some(c) = config(user_config, &run.mcp_servers, &run.grants, mode(run.mode), run.delegating, run.capped) {
        env.insert("OPENCODE_CONFIG_CONTENT".to_owned(), c);
    }
    let notes: Vec<FileNote> = run.attachments.iter().filter_map(|a| a.path.clone().map(|path| FileNote { path, mime: a.mime.clone(), size: a.size })).collect();
    let input = format!("{}{}", run.prompt, attachment_note(&notes, Some("They are also attached to this message")));
    Launch { program: bin.to_owned(), args: args(&a), env, cwd: run.cwd.clone(), stdin: Stdin::Bytes(input.into_bytes()), ..Launch::default() }
}

impl OpencodeHarness {
    fn found(&self) -> Found {
        self.found.lock().map(|f| f.clone()).unwrap_or_default()
    }
}

impl Harness for OpencodeHarness {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }

    fn detect<'a>(&'a self, sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            let mut tries: Vec<String> = match sys.env("WISP_OPENCODE_BIN").filter(|b| !b.is_empty()) {
                Some(b) => vec![b],
                None => sys.which(DEFAULT_BIN).await.into_iter().chain([format!("{}/.opencode/bin/opencode", sys.home())]).collect(),
            };
            let mut hit = None;
            for b in tries.drain(..) {
                if let Some(v) = output(sys, &b, &["--version"]).await {
                    hit = Some((b, v.trim().to_owned()));
                    break;
                }
            }
            let Some((bin, version)) = hit else {
                return HarnessFound { available: false, error: Some("opencode isn't installed".into()), ..HarnessFound::default() };
            };
            let v2 = major_version(&version) >= 2;
            if let Ok(mut f) = self.found.lock() {
                *f = Found { bin: Some(bin.clone()), v2 };
            }
            let mut models = verbose_models(&output(sys, &bin, &["models", "--verbose"]).await.unwrap_or_default());
            if models.is_empty() {
                models = plain_models(&output(sys, &bin, &["models"]).await.unwrap_or_default());
            }
            let mut all = vec![self.info.models[0].clone()];
            all.extend(models);
            let key = has_key(&output(sys, &bin, &["auth", "list"]).await.unwrap_or_default());
            HarnessFound { available: true, version: Some(version).filter(|v| !v.is_empty()), bin: Some(bin), models: Some(all), has_key: key, ..HarnessFound::default() }
        })
    }

    fn program(&self) -> Option<String> {
        Some(self.found().bin.or_else(|| std::env::var("WISP_OPENCODE_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned()))
    }

    fn launch(&self, run: &HarnessRun) -> Result<Launch> {
        let f = self.found();
        let bin = run.bin.clone().or(f.bin).or_else(|| std::env::var("WISP_OPENCODE_BIN").ok().filter(|b| !b.is_empty())).unwrap_or_else(|| DEFAULT_BIN.to_owned());
        let user = run.env.get("OPENCODE_CONFIG_CONTENT").cloned().or_else(|| std::env::var("OPENCODE_CONFIG_CONTENT").ok());
        Ok(launch(run, &bin, f.v2, user.as_deref()))
    }

    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        let paths = RunPaths::same(run.cwd.clone());
        let grace = std::env::var("WISP_RATE_LIMIT_GRACE_MS").ok().and_then(|v| v.parse().ok()).filter(|g| *g > 0).unwrap_or(RATE_LIMIT_GRACE_MS);
        let parser = OpencodeParser::new(OpencodeOptions { paths: paths.clone(), model: run.model.clone(), rate_limit_grace_ms: grace });
        driver::KitDriver::boxed(parser, paths, true)
    }

    fn setup(&self, _platform: &str) -> Option<SetupTip> {
        Some(SetupTip { tip: "wisp can install it here: free models, no account needed".into(), command: Some("npm i -g opencode-ai".into()), url: Some("https://opencode.ai".into()) })
    }

    fn resume_command(&self, o: &ResumeOptions) -> Option<ResumeCommand> {
        // the TUI has no --variant: the effort only applies to `run`
        let mut argv = vec![self.found().bin.unwrap_or_else(|| DEFAULT_BIN.to_owned())];
        if let Some(r) = o.resume_id.as_ref().filter(|r| !r.is_empty()) {
            argv.extend(["--session".to_owned(), r.clone()]);
        }
        if !o.model.is_empty() {
            argv.extend(["--model".to_owned(), o.model.clone()]);
        }
        if let Some(p) = o.prompt.as_ref().filter(|p| !p.is_empty()) {
            argv.extend(["--prompt".to_owned(), p.clone()]);
        }
        Some(ResumeCommand { argv, types_prompt: false })
    }
}

#[derive(Debug, Default)]
pub struct OpencodePlugin;

impl Plugin for OpencodePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let h: Arc<dyn Harness> = Arc::new(OpencodeHarness::default());
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
        assert_eq!(OpencodePlugin.manifest().id, "wisp.opencode");
        assert!(VERBOSE_MODEL.compiles() && PLAIN_MODEL.compiles());
    }

    #[test]
    fn models_with_their_variants() {
        // v1 adapters.test.js "opencode: detect reads each model's variants"
        let out = "fake/model-a\n{\n  \"id\": \"model-a\",\n  \"variants\": { \"low\": {}, \"high\": {} }\n}\nfake/model-b\n{\n  \"id\": \"model-b\"\n}\n";
        let m = verbose_models(out);
        assert_eq!(m.iter().map(|x| (x.id.as_str(), x.label.as_str(), x.efforts.len())).collect::<Vec<_>>(), [("fake/model-a", "model-a", 2), ("fake/model-b", "model-b", 0)]);
        assert_eq!(plain_models("fake/a\nnot a model\nx/y-1\n").len(), 2);
    }

    #[test]
    fn the_launch_carries_wisps_server_and_the_prompt_on_stdin() {
        let mut run = HarnessRun { prompt: "fix it".into(), cwd: "/w".into(), mode: Mode::Plan, ..HarnessRun::default() };
        run.mcp_servers.insert("wisp".into(), json!({ "type": "http", "url": "http://x/api/mcp", "headers": {} }));
        let l = launch(&run, "opencode", false, None);
        assert!(l.args.windows(2).any(|w| w == ["--agent", "plan"]));
        let cfg: Value = serde_json::from_str(&l.env["OPENCODE_CONFIG_CONTENT"]).unwrap_or_default();
        assert_eq!(cfg["mcp"]["wisp"]["url"], "http://x/api/mcp");
        assert_eq!(l.stdin, Stdin::Bytes(b"fix it".to_vec()));
    }
}
