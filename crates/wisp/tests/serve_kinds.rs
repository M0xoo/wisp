//! Applying a kind changes what wisp does (ADR-0028), end to end on a real `wisp serve` with the fake
//! agent: a project, an agent profile, a skill, a team, a connector, a harness and a `tools` spec shape one
//! run (its setup, system prompt, MCP servers, trust, tools, the harnesses offered); a trigger and a
//! pipeline start tasks after it; an app lands on the shelf; and `wisp run --formula` runs one task
//! under a formula that leaves nothing behind. (capability and plugin: their hosts' tests.)
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, cwd: &Path, port: u16, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

/// Every claude run's argv so far.
fn runs(rec: &Path) -> Vec<Vec<String>> {
    std::fs::read_to_string(rec.join("claude.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|v| v["argv"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default())
        .collect()
}

async fn apply(api: &Api, resources: Value) -> Value {
    let r = api.try_cmd("resources.apply", json!({ "resources": resources })).await;
    assert_eq!(r["ok"], true, "{r}");
    r
}

async fn finished(api: &Api, id: &str) {
    api.until(id, "the turn ends", |t| t.last().is_some_and(ended)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_profile_skill_team_connector_harness_and_tools_shape_the_run() {
    let dir = temp("serve-kinds");
    let proj = dir.join("proj");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(
        &api,
        json!([
            { "kind": "agent", "name": "reviewer", "spec": { "harness": "claude", "instructions": "AGENT-RULE-1", "skills": ["tidy"] } },
            { "kind": "skill", "name": "tidy", "spec": { "description": "keeps it tidy", "body": "SKILL-BODY-2" } },
            { "kind": "project", "name": "proj", "spec": { "path": proj, "agent": "reviewer", "setup": ["echo ok > setup-ran.txt"], "instructions": "PROJECT-RULE-3", "trust": { "setup": true } } },
            { "kind": "team", "name": "crew", "spec": { "members": { "helper": { "agent": "codex", "count": 2, "why": "runs the tests" } } } },
            { "kind": "connector", "name": "docs", "spec": { "command": "docs-mcp", "args": ["--stdio"], "agents": ["reviewer"] } },
            { "kind": "harness", "name": "codex", "spec": { "enabled": false } },
            { "kind": "tools", "name": "reviewer", "spec": { "deny": ["wisp_save"] } }
        ]),
    )
    .await;

    // no agent named: the project's; its setup ran first, in its folder
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "team": "crew" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    finished(&api, &id).await;
    assert_eq!(std::fs::read_to_string(proj.join("setup-ran.txt")).unwrap().trim(), "ok", "project: setup");
    assert_eq!(api.cmd("runtime.spec", json!({ "id": id })).await["agent"], "reviewer", "project: its agent");
    let argv = runs(&rec).pop().expect("a claude run");
    let all = argv.join("\n");
    for (what, needle) in [("project: instructions", "PROJECT-RULE-3"), ("agent: instructions", "AGENT-RULE-1"), ("skill: given to the run", "SKILL-BODY-2"), ("team: given to the run", "helper (codex, up to 2 at once): runs the tests")] {
        assert!(all.contains(needle), "{what}: {all}");
    }
    assert!(argv.iter().any(|a| a == "--setting-sources"), "project: trust without hooks or MCP skips the repo's own: {argv:?}");
    let cfg: Value = serde_json::from_str(&argv[argv.iter().position(|a| a == "--mcp-config").expect("--mcp-config") + 1]).unwrap();
    assert_eq!(cfg["mcpServers"]["docs"], json!({ "type": "stdio", "command": "docs-mcp", "args": ["--stdio"], "env": {} }), "connector: its MCP server");

    // tools: the reviewer isn't offered wisp_save, and can't call it
    let wisp = &cfg["mcpServers"]["wisp"];
    let mcp = |body: Value| {
        let (http, token, sid) = (api.http.clone(), wisp["headers"]["x-wisp-token"].as_str().unwrap().to_owned(), id.clone());
        async move {
            let r = http.post(format!("http://127.0.0.1:{port}/api/mcp")).header("content-type", "application/json").header("x-wisp-token", token).header("x-wisp-session", sid).body(body.to_string()).send().await.unwrap();
            serde_json::from_slice::<Value>(&r.bytes().await.unwrap()).unwrap_or(Value::Null)
        }
    };
    let list = mcp(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"ask_user") && !names.contains(&"wisp_save"), "tools: {names:?}");
    let called = mcp(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "wisp_save", "arguments": { "title": "x", "text": "y" } } })).await;
    assert!(called.to_string().contains("isn't one of this agent's tools"), "tools: {called}");

    // harness: off refuses a task, and isn't offered
    let refused = api.try_cmd("runtime.create", json!({ "prompt": "x", "cwd": dir, "agent": "codex" })).await;
    assert!(refused["ok"] == false && refused.to_string().contains("codex is off"), "harness: {refused}");
    let agents = api.cmd("runtime.agents", json!({})).await;
    let codex = agents.as_array().unwrap().iter().find(|a| a["id"] == "codex").unwrap();
    assert_eq!(codex["available"], false, "harness: {codex}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trigger_and_a_pipeline_start_tasks_and_an_app_lands_on_the_shelf() {
    let dir = temp("serve-kinds-auto");
    let proj = dir.join("proj");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(
        &api,
        json!([
            { "kind": "trigger", "name": "after", "spec": { "on": "finished", "project": proj, "prompt": "Write the changelog TOPIC[Changelog]" } },
            { "kind": "pipeline", "name": "default", "spec": { "review": "claude" } },
            { "kind": "app", "name": "notes", "spec": { "inline": "<!doctype html><title>notes</title><p>hi</p>" } }
        ]),
    )
    .await;
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug TOPIC[Fix add]", "cwd": proj, "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    finished(&api, &id).await;
    // the trigger's task and the pipeline's review, each once: neither sets the other off
    let at = Instant::now();
    let by = loop {
        let mut by = Vec::new();
        for t in api.cmd("runtime.list", json!({})).await.as_array().unwrap() {
            let spec = api.cmd("runtime.spec", json!({ "id": t["id"] })).await;
            by.push(spec.pointer("/lineage/triggeredBy").and_then(Value::as_str).unwrap_or("you").to_owned());
        }
        by.sort();
        if by.len() >= 3 || at.elapsed() > Duration::from_secs(60) {
            break by;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(by, ["pipeline:default", "trigger:after", "you"], "trigger and pipeline");
    for t in api.cmd("runtime.list", json!({})).await.as_array().unwrap() {
        finished(&api, t["id"].as_str().unwrap()).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), 3, "and nothing after them");

    // app: on the shelf once, however often it's applied; off takes it away
    let notes = |list: &Value| list.as_array().unwrap().iter().filter(|x| x["title"] == "notes").count();
    assert_eq!(notes(&api.cmd("stuff.list", json!({})).await), 1, "app");
    apply(&api, json!([{ "kind": "app", "name": "notes", "spec": { "inline": "<!doctype html><title>notes</title><p>hi again</p>" } }])).await;
    assert_eq!(notes(&api.cmd("stuff.list", json!({})).await), 1, "app: the same item, updated");
    apply(&api, json!([{ "kind": "app", "name": "notes", "spec": { "inline": "<p>hi</p>", "enabled": false } }])).await;
    assert_eq!(notes(&api.cmd("stuff.list", json!({})).await), 0, "app: off");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_run_formula_is_an_overlay_for_one_task_that_leaves_nothing() {
    let dir = temp("serve-overlay");
    let proj = dir.join("proj");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    std::fs::write(dir.join("f.yml"), "wisp: 1\nagents:\n  - name: solo\n    harness: claude\n    instructions: OVERLAY-RULE-${env:RULE_NO}\n    skills: [house]\nskills:\n  - name: house\n    description: the house style\n    body: OVERLAY-SKILL\nconnectors:\n  - name: scratch\n    command: scratch-mcp\nsettings:\n  settings.timeZone: Europe/Zurich\n").unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let before = api.cmd("resources.export", json!({})).await;

    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(["run", "--formula", dir.join("f.yml").to_str().unwrap(), "fix the add bug"])
        .env("WISP_HOME", dir.join("home"))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .env("RULE_NO", "5")
        .current_dir(&proj)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(o.status.success(), "{out}{}", String::from_utf8_lossy(&o.stderr));
    assert!(out.contains("not for one task") && out.contains("setting/settings.timeZone"), "what an overlay doesn't do is said: {out}");
    let id = out.split_whitespace().skip_while(|w| *w != "started").nth(1).unwrap().to_owned();
    finished(&api, &id).await;

    // the task ran with the overlay's agent, skill and connector
    let argv = runs(&rec).pop().expect("a claude run");
    let all = argv.join("\n");
    assert!(all.contains("OVERLAY-RULE-5") && all.contains("OVERLAY-SKILL") && all.contains("scratch-mcp"), "{all}");
    assert_eq!(api.cmd("runtime.spec", json!({ "id": id })).await["agent"], "solo");
    let snap = api.cmd("runtime.snapshot", json!({ "of": id })).await;
    assert!(snap.to_string().contains("OVERLAY-RULE-5"), "its snapshot says what it ran with: {snap}");

    // and nothing is left: what's set up is what it was, and the next task doesn't get it
    assert_eq!(api.cmd("resources.export", json!({})).await, before, "nothing applied");
    let (_, export, _) = wisp(&dir, &proj, port, &["export"]);
    assert!(!export.contains("solo") && !export.contains("scratch"), "{export}");
    let next = api.cmd("runtime.create", json!({ "prompt": "again", "cwd": proj, "agent": "claude" })).await;
    finished(&api, next["id"].as_str().unwrap()).await;
    let all = runs(&rec).pop().unwrap().join("\n");
    assert!(!all.contains("OVERLAY") && !all.contains("scratch-mcp"), "the overlay was that task's alone: {all}");
    drop(serve);
}
