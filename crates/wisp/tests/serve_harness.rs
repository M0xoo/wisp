//! Every harness runs a task end to end in `wisp serve`: the real binary, wisp-testkit's fake CLI
//! speaking that harness's own stream format, `math.js` fixed for real, the answer's wisp block shown
//! (v1 test/adapters.test.js "a turn yields session, tools, real diffs and the final presentation").
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;

async fn turn_on(agent: &str, session: &str, changed: u64) {
    let dir = temp(&format!("serve-{agent}"));
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let (turn, task) = run_task(&api, &dir, agent).await;
    let log = std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default();
    assert_eq!(turn["status"], "done", "{turn}\n{log}");
    assert_eq!(turn["agent"], agent);
    assert_eq!(turn["changedFiles"], changed, "{turn}");
    assert!(turn["presentation"]["blocks"][0]["title"].as_str().is_some_and(|t| t.starts_with("Fake ")), "{turn}");
    assert_eq!(std::fs::read_to_string(dir.join("proj/math.js")).unwrap(), "export const add = (a, b) => a + b;\n");
    assert_eq!(task["resumeId"], session, "{task}");
    assert_eq!(task["title"], "Fix add");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_runs_a_task_to_finished() {
    turn_on("codex", "codex-session-1", 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_runs_a_task_to_finished() {
    turn_on("opencode", "opencode-session-1", 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_runs_a_task_to_finished() {
    turn_on("cursor", "cursor-agent-session-1", 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn copilot_runs_a_task_to_finished() {
    // a new session is named up front: the turn's id
    let dir = temp("serve-copilot");
    let (serve, port) = start(&dir);
    let api = std::sync::Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let (turn, task) = run_task(&api, &dir, "copilot").await;
    assert_eq!(turn["status"], "done", "{turn}");
    assert_eq!(turn["changedFiles"], 2, "{turn}");
    assert_eq!(task["resumeId"], "11111111-2222-4333-8444-555555555555", "the recorded result names its session: {task}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn grok_runs_a_task_to_finished() {
    turn_on("grok", "grok-session-1", 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn antigravity_runs_a_task_to_finished() {
    turn_on("antigravity", "agy-session-1", 1).await;
}

const ALL: [&str; 6] = ["codex", "opencode", "cursor", "copilot", "grok", "antigravity"];

/// v1 adapters.test.js "CLI failure: stderr is the result" for every harness.
#[tokio::test(flavor = "multi_thread")]
async fn a_cli_that_fails_shows_what_it_said() {
    let dir = temp("serve-fail");
    let (serve, port) = start_with(&dir, &[("FAKE_FAIL", "1")]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    for agent in ALL {
        let (turn, _) = run_task(&api, &dir, agent).await;
        assert_eq!(turn["status"], "error", "{agent}: {turn}");
        assert!(turn.to_string().contains("failed on purpose"), "{agent}: the CLI's stderr is the answer: {turn}");
    }
    drop(serve);
}

/// v1 adapters.test.js "stop kills the run" for every harness.
#[tokio::test(flavor = "multi_thread")]
async fn stop_ends_a_hanging_run_on_every_harness() {
    let dir = temp("serve-stop");
    let (serve, port) = start_with(&dir, &[("FAKE_HANG", "1")]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    for agent in ALL {
        let made = api.cmd("runtime.create", serde_json::json!({ "prompt": "hang", "cwd": dir.join("proj"), "agent": agent })).await;
        let id = made["id"].as_str().unwrap().to_owned();
        api.until(&id, "running", |t| t.len() == 1 && t[0]["status"] == "running").await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        api.cmd("runtime.stop", serde_json::json!({ "id": id })).await;
        let t = api.until(&id, "stopped", |t| t.len() == 1 && ended(&t[0])).await;
        assert_eq!(t[0]["status"], "stopped", "{agent}: {:?}", t[0]);
    }
    drop(serve);
}
