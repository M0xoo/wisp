//! A runtime over an in-memory store, a simulated proc service and a fake harness whose CLI prints v1
//! event JSON lines (what the recorded transcripts hold), so turns run end to end without any CLI.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_kernel::BoxFuture;
use wisp_proc::Exit;
use wisp_proc::sim::{SimIo, SimProc};
use wisp_runtime::{Recorder, Runtime, repo::Repo, schema};
use wisp_runtime_api::harness::{
    HarnessFound, HarnessInfo, HarnessModel, HarnessParser, HarnessRun, HarnessSys, Launch, ParserInput, ParserOutput, RunDriver, pure,
};
use wisp_runtime_api::{Harness, HarnessEvent};
use wisp_store::{Location, Store, SystemClock};

/// A CLI whose output is v1 event JSON, one per line; the prompt is its first argument.
pub struct Fake {
    info: HarnessInfo,
}

impl Fake {
    pub fn harness() -> Arc<dyn Harness> {
        Arc::new(Self {
            info: HarnessInfo {
                id: "fake".into(),
                name: "Fake CLI".into(),
                models: vec![HarnessModel { id: "m1".into(), label: "M1".into(), hint: None, efforts: vec![] }],
                system_prompt_flag: true,
                ..HarnessInfo::default()
            },
        })
    }
}

struct Lines {
    done: bool,
}

impl HarnessParser for Lines {
    fn on(&mut self, input: ParserInput<'_>, _now: i64, out: &mut ParserOutput) {
        match input {
            ParserInput::Stdout(line) => {
                if let Ok(e) = serde_json::from_str::<Value>(line).map_err(|_| ()).and_then(|v| HarnessEvent::from_v1(v).map_err(|_| ())) {
                    self.done |= e.is_result();
                    out.emit(e);
                }
            }
            ParserInput::Exit(x) if !self.done && x.stop_requested => {
                self.done = true;
                out.emit(HarnessEvent::Result {
                    text: String::new(),
                    is_error: false,
                    stopped: true,
                    stats: None,
                    auth_failed: false,
                    stop_reason: None,
                    background: None,
                    background_agents: None,
                });
            }
            _ => {}
        }
    }
}

impl Harness for Fake {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }
    fn detect<'a>(&'a self, _sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async { HarnessFound { available: true, ..HarnessFound::default() } })
    }
    fn launch(&self, run: &HarnessRun) -> wisp_kernel::Result<Launch> {
        let mut args = vec![run.prompt.clone()];
        if let Some(r) = &run.resume_id {
            args.push(format!("--resume={r}"));
        }
        if run.quiet {
            args.push("--quiet".into());
        }
        // what the run was told, as flags a test can read
        if run.system_prompt.contains("\"type\":\"app\"") {
            args.push("--app".into());
        }
        if run.system_prompt.contains("no `wisp` block") {
            args.push("--plain".into());
        }
        if run.env.contains_key("WISP_WATCH") {
            args.push("--watch".into());
        }
        if !run.subagent_model.is_empty() {
            args.push(format!("--sub={}", run.subagent_model));
        }
        Ok(Launch { program: "fake".into(), args, ..Launch::default() })
    }
    fn driver(&self, _run: &HarnessRun) -> Box<dyn RunDriver> {
        pure(Lines { done: false })
    }
}

/// The answer a turn prints, by its prompt: `slow…` waits to be killed, `fail…` errors, `refuse…` turns it down,
/// else a hero.
pub fn script(prompt: &str) -> Vec<Value> {
    // `shot <path>`: the answer shows that picture too
    let shot = prompt.strip_prefix("shot ").map(|p| format!(",{{\"type\":\"image\",\"path\":\"{p}\"}}")).unwrap_or_default();
    let hero = format!(
        "```wisp\n{{\"blocks\":[{{\"type\":\"hero\",\"title\":\"Did it\",\"topic\":\"Topic of {prompt}\",\"summary\":\"done: {prompt}\",\"status\":\"done\"}}{shot}]}}\n```"
    );
    if prompt.starts_with("fail") {
        return vec![json!({"type":"session","id":"conv-1"}), json!({"type":"result","text":"Error: boom\nmore","isError":true})];
    }
    if prompt.starts_with("limit") {
        return vec![
            json!({"type":"session","id":"conv-1"}),
            json!({"type":"result","text":"Claude AI usage limit reached|1767225600","isError":true}),
        ];
    }
    if prompt.starts_with("refuse") {
        return vec![
            json!({"type":"session","id":"conv-1"}),
            json!({"type":"result","text":"I can't help with that.","isError":false,"stopReason":"refusal"}),
        ];
    }
    let cli = prompt.strip_prefix("cli ").map(|v| json!({"type":"cli","version":v}));
    let mut lines = vec![json!({"type":"session","id":"conv-1"})];
    lines.extend(cli);
    lines.extend([
        json!({"type":"tool","kind":"run","label":"Run tests","id":"c1"}),
        json!({"type":"tool_output","id":"c1","text":"ok"}),
        json!({"type":"change","file":"a.ts","op":"edit","edits":[{"before":"a","after":"b"}]}),
        json!({"type":"text","text":hero}),
        json!({"type":"result","text":hero,"isError":false,"stats":{"costUsd":0.01,"durationMs":5}}),
    ]);
    lines
}

async fn fake_cli(io: SimIo) -> Exit {
    let prompt = io.args.first().cloned().unwrap_or_default();
    let slow = prompt.starts_with("slow");
    let lines = script(&prompt);
    let (head, tail) = if slow { lines.split_at(2) } else { lines.split_at(lines.len()) };
    for l in head {
        io.print(format!("{l}\n").as_bytes()).await;
    }
    if slow {
        io.killed.cancelled().await;
        return Exit { code: None, signal: Some("SIGTERM".into()) };
    }
    for l in tail {
        io.print(format!("{l}\n").as_bytes()).await;
    }
    Exit { code: Some(0), signal: None }
}

pub struct Rig {
    pub rt: Arc<Runtime>,
    pub host: Arc<Recorder>,
    pub store: Store,
    pub sim: SimProc,
}

pub async fn rig_with(host: Recorder) -> Rig {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    schema::install(&store).unwrap();
    let sim = SimProc::new().program("fake", fake_cli);
    let host = Arc::new(Recorder { harnesses: vec![Fake::harness()], ..host });
    let rt = Runtime::new(Repo::new(store.clone()), host.clone(), Arc::new(sim.clone()), Arc::new(SystemClock));
    rt.start().await.unwrap();
    Rig { rt, host, store, sim }
}

pub async fn rig() -> Rig {
    rig_with(Recorder::default()).await
}

/// Waits (up to 5 s) until `f` holds.
pub async fn until<F, Fut>(what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..1000 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}
