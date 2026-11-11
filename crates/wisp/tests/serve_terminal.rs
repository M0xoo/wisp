//! wisp.terminal in `wisp serve` (v1 test/pty.test.js, the shell panel): a task's shell starts on a PTY,
//! a page watches its event stream (hello, the screen so far, output as it comes), typed keys go in
//! (numbered ones in order) and come back as output, and closing it ends the stream.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

async fn post(api: &Api, path: &str, body: Value) -> (u16, Value) {
    let r = api.http.post(format!("http://127.0.0.1:{}/api{path}", api.port)).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
    let st = r.status().as_u16();
    (st, serde_json::from_slice(&r.bytes().await.unwrap()).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tasks_shell_streams_what_it_is_typed() {
    if cfg!(windows) {
        return;
    }
    let dir = temp("serve-terminal");
    let (serve, port) = start_with(&dir, &[("SHELL", "/bin/sh")]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let (_, task) = run_task(&api, &dir, "claude").await;
    let id = task["id"].as_str().unwrap().to_owned();
    let (st, started) = post(&api, &format!("/sessions/{id}/shell"), json!({ "cols": 80, "rows": 24 })).await;
    assert_eq!((st, started["started"].as_bool()), (200, Some(true)), "{started}");
    assert!(started["dir"].as_str().unwrap().ends_with("proj"), "{started}");
    let (_, again) = post(&api, &format!("/sessions/{id}/shell"), json!({})).await;
    assert_eq!(again["started"], false, "one shell per task");
    // a page watches it
    let mut stream = api.http.get(format!("http://127.0.0.1:{port}/api/sessions/{id}/shell")).send().await.unwrap();
    assert_eq!(stream.headers()["content-type"], "text/event-stream");
    // numbered keys, sent out of order, go in in order
    post(&api, &format!("/sessions/{id}/shell"), json!({ "data": "40+2))\n", "seq": 1, "from": "page-a" })).await;
    post(&api, &format!("/sessions/{id}/shell"), json!({ "data": "echo wisp-$((", "seq": 0, "from": "page-a" })).await;
    let mut seen = String::new();
    let at = Instant::now();
    while !seen.contains("wisp-42") && at.elapsed() < Duration::from_secs(10) {
        match tokio::time::timeout(Duration::from_secs(5), stream.chunk()).await {
            Ok(Ok(Some(c))) => seen.push_str(&String::from_utf8_lossy(&c)),
            _ => break,
        }
    }
    assert!(seen.starts_with("event: hello\n"), "{seen}");
    assert!(seen.contains("wisp-42"), "the shell answered: {seen}");
    let info = api.cmd("terminal.get", json!({ "kind": "shell", "id": id })).await;
    assert_eq!((info["state"].as_str(), info["clients"].as_u64()), (Some("running"), Some(1)), "{info}");
    // hung up: the page hears the end
    let r = api.http.delete(format!("http://127.0.0.1:{port}/api/sessions/{id}/shell")).header("content-type", "application/json").body("{}").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let mut rest = String::new();
    while let Ok(Ok(Some(c))) = tokio::time::timeout(Duration::from_secs(5), stream.chunk()).await {
        rest.push_str(&String::from_utf8_lossy(&c));
    }
    assert!(rest.contains("event: exit"), "{rest}");
    assert!(api.cmd("terminal.get", json!({ "kind": "shell", "id": id })).await.is_null());
    drop(serve);
}

/// v1 services/tui.js: `/terminal …` (or Settings → General → Terminal sessions) starts the task in the harness's
/// own CLI in a terminal in wisp, on the prompt, with no headless run; the CLI's conversation is named by wisp
/// (`--session-id`, so it can be resumed); a follow-up opens it again resumed once it ended; and when it ends the
/// task is for review.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_task_runs_in_the_harnesss_own_cli_and_a_follow_up_resumes_it() {
    if cfg!(windows) {
        return;
    }
    let dir = temp("serve-terminal-task");
    let (serve, port) = start_with(&dir, &[]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let made = api.cmd("runtime.create", json!({ "prompt": "/terminal fix the add bug", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    assert!(made["turnId"].is_null(), "no headless turn: {made}");
    let info = api.cmd("terminal.get", json!({ "kind": "takeover", "id": id })).await;
    assert_eq!(info["tui"], true, "{info}");
    let task = api.cmd("runtime.get", json!({ "id": id })).await;
    let named = task["resumeId"].as_str().unwrap_or_default().to_owned();
    assert_eq!(named.len(), 36, "the conversation named by wisp: {task}");
    assert_eq!(task["ext"]["wisp.runtime"]["terminal"]["prompt"], "fix the add bug", "{task}");
    // the CLI ends (here: its terminal closed; the fake reads its prompt to the end): the task is for review
    api.cmd("terminal.close", json!({ "kind": "takeover", "id": id })).await;
    let at = Instant::now();
    loop {
        let t = api.cmd("runtime.get", json!({ "id": id })).await;
        if t["state"] == "review" {
            break;
        }
        if at.elapsed() > Duration::from_secs(20) {
            let term = api.cmd("terminal.get", json!({ "kind": "takeover", "id": id })).await;
            panic!("it never ended: {t}\n{term}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // a follow-up opens it again, resumed
    let f = api.cmd("runtime.followUp", json!({ "id": id, "text": "and add a test" })).await;
    assert!(f.get("turnId").is_none_or(Value::is_null), "{f}");
    let again = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(again["resumeId"].as_str(), Some(named.as_str()), "the same conversation");
    assert!(api.cmd("terminal.get", json!({ "kind": "takeover", "id": id })).await.is_object());
    drop(serve);
}
