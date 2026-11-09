//! Applying a kind changes what wisp does (ADR-0028), end to end on a real `wisp serve` with the fake
//! agent: a project, an agent profile, a skill, a team, a connector, a harness and a `tools` spec shape one
//! run (its setup, system prompt, MCP servers, trust, tools, the harnesses offered); a trigger and a
//! pipeline start tasks after it; an app lands on the shelf; and `wisp run --formula` runs one task
//! under a formula that leaves nothing behind. (capability and plugin: their hosts' tests.)
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines, clippy::assert_is_empty)]

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

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
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
    repo(&proj);
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(
        &api,
        json!([
            { "kind": "agent", "name": "reviewer", "spec": { "harness": "claude", "instructions": "AGENT-RULE-1", "skills": ["tidy"] } },
            { "kind": "skill", "name": "tidy", "spec": { "description": "keeps it tidy", "body": "SKILL-BODY-2" } },
            { "kind": "project", "name": "proj", "spec": { "path": proj, "agent": "reviewer", "worktree": { "enabled": true }, "setup": ["echo ok > setup-ran.txt"], "instructions": "PROJECT-RULE-3", "trust": { "setup": true } } },
            { "kind": "team", "name": "crew", "spec": { "members": { "helper": { "agent": "codex", "count": 2, "why": "runs the tests" } } } },
            { "kind": "connector", "name": "docs", "spec": { "command": "docs-mcp", "args": ["--stdio"], "agents": ["reviewer"] } },
            { "kind": "harness", "name": "codex", "spec": { "enabled": false } },
            { "kind": "tools", "name": "reviewer", "spec": { "deny": ["wisp_save"] } }
        ]),
    )
    .await;

    // no agent named: the project's; a worktree of its own, its setup run there first (only there)
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "team": "crew" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    finished(&api, &id).await;
    let task = api.cmd("runtime.get", json!({ "id": id })).await;
    let tree = task["ext"]["wisp.worktrees"]["path"].as_str().unwrap_or_else(|| panic!("project: its worktree: {task}")).to_owned();
    assert_eq!(task["cwd"].as_str(), Some(tree.as_str()), "the task runs in it");
    assert_eq!(std::fs::read_to_string(Path::new(&tree).join("setup-ran.txt")).unwrap().trim(), "ok", "project: setup in the fresh worktree");
    assert!(!proj.join("setup-ran.txt").exists(), "project: never in the folder itself");
    let plain = api.cmd("runtime.create", json!({ "prompt": "again", "cwd": proj, "worktree": false, "agent": "claude" })).await;
    finished(&api, plain["id"].as_str().unwrap()).await;
    assert!(!proj.join("setup-ran.txt").exists(), "project: no setup for a task in the folder");
    assert_eq!(api.cmd("runtime.spec", json!({ "id": id })).await["agent"], "reviewer", "project: its agent");
    let argv = runs(&rec).into_iter().next().expect("a claude run");
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
async fn a_failing_setup_holds_the_first_turn_with_why() {
    let dir = temp("serve-kinds-setup");
    let proj = dir.join("proj");
    repo(&proj);
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(&api, json!([{ "kind": "project", "name": "proj", "spec": { "path": proj, "worktree": { "enabled": true }, "setup": ["echo nope >&2; exit 3"] } }])).await;
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let t = api.until(&id, "the turn is held", |t| t.last().is_some_and(|t| t["status"] == "held")).await;
    let held = &t.last().unwrap()["held"];
    assert_eq!(held["kind"], "setup", "{held}");
    assert!(held["data"]["why"].as_str().unwrap_or_default().contains("nope"), "the card says why: {held}");
    // Start now runs it anyway
    api.cmd("runtime.release", json!({ "id": id, "turnId": t.last().unwrap()["id"], "action": "start" })).await;
    let t = api.until(&id, "it ran", |t| t.last().is_some_and(|t| t["status"] == "done")).await;
    assert_eq!(t.last().unwrap()["status"], "done");
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
    std::fs::write(dir.join("f.yml"), "wisp: 1\nagents:\n  - name: solo\n    harness: claude\n    instructions: OVERLAY-RULE-${env:RULE_NO}\n    skills: [house]\nskills:\n  - name: house\n    description: the house style\n    body: OVERLAY-SKILL\nconnectors:\n  - name: scratch\n    command: scratch-mcp\n    env: { TOKEN: \"${secret:SCRATCH}\" }\nsettings:\n  settings.timeZone: Europe/Zurich\n").unwrap();
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::write(dir.join("home/secrets.json"), r#"{"wisp":{"SCRATCH":"tok-777"}}"#).unwrap();
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
    assert!(all.contains("tok-777"), "the overlay connector's secret was read for the run: {all}");
    let row = api.cmd("runtime.get", json!({ "id": id })).await;
    assert!(!row.to_string().contains("tok-777") && row.to_string().contains("${secret:SCRATCH}"), "and never stored: {row}");
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

#[tokio::test(flavor = "multi_thread")]
async fn a_goal_keeps_going_until_its_judges_say_met_and_stalls_with_a_question() {
    let dir = temp("serve-kinds-goal");
    let proj = dir.join("proj");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    // the defaults: one judge, two rounds (the fake judge says what TOPIC[…] in its prompt says)
    apply(&api, json!([{ "kind": "goal", "name": "default", "spec": { "judges": ["claude"], "maxRounds": 2 } }])).await;
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "agent": "claude", "goal": { "text": "tests pass TOPIC[NOT MET: the tests still fail]" } })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let at = Instant::now();
    let task = loop {
        let t = api.cmd("runtime.get", json!({ "id": id })).await;
        if t["ext"]["wisp.goal"]["state"] == "stalled" {
            break t;
        }
        assert!(at.elapsed() < Duration::from_secs(60), "the goal stalls: {t}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(task["ext"]["wisp.goal"]["rounds"], 2, "{task}");
    let turns = api.turns(&id).await;
    assert_eq!(turns.len(), 2, "the first turn and one more round");
    assert!(turns[1]["prompt"].as_str().unwrap().contains("the tests still fail"), "the round is told what's missing: {}", turns[1]["prompt"]);
    let at = Instant::now();
    while !api.cmd("runtime.get", json!({ "id": id })).await.to_string().contains("after 2 rounds") {
        assert!(at.elapsed() < Duration::from_secs(30), "it asks you");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let ok = api.cmd("runtime.create", json!({ "prompt": "fix it", "cwd": proj, "agent": "claude", "goal": "tests pass TOPIC[MET]" })).await;
    let oid = ok["id"].as_str().unwrap().to_owned();
    let at = Instant::now();
    while api.cmd("runtime.get", json!({ "id": oid })).await["ext"]["wisp.goal"]["state"] != "met" {
        assert!(at.elapsed() < Duration::from_secs(60), "met");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(api.turns(&oid).await.len(), 1, "met after the first turn: no more rounds");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_webhook_trigger_starts_its_task_only_with_its_secret() {
    let dir = temp("serve-kinds-hook");
    let proj = dir.join("proj");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(&api, json!([{ "kind": "trigger", "name": "deploy", "spec": { "on": "webhook", "secret": "s3cret-hook-value", "prompt": "Deploy what was pushed", "project": proj } }])).await;
    let url = format!("http://127.0.0.1:{port}/api/triggers/deploy");
    let post = |secret: Option<&str>| {
        let mut r = api.http.post(&url).header("content-type", "application/json").body(r#"{"ref":"refs/heads/main"}"#);
        if let Some(s) = secret {
            r = r.header("x-wisp-secret", s);
        }
        r.send()
    };
    assert_eq!(post(None).await.unwrap().status().as_u16(), 404, "no secret: nothing");
    assert_eq!(post(Some("wrong")).await.unwrap().status().as_u16(), 404, "a wrong one: the same");
    assert!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().is_empty());
    let r = post(Some("s3cret-hook-value")).await.unwrap();
    let status = r.status().as_u16();
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap_or_default();
    assert_eq!(status, 202, "{body}");
    let id = body["id"].as_str().unwrap().to_owned();
    let spec = api.cmd("runtime.spec", json!({ "id": id })).await;
    assert_eq!(spec["lineage"]["triggeredBy"], "trigger:deploy");
    assert!(spec["prompt"].as_str().unwrap().contains("refs/heads/main"), "the body is handed over: {spec}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_harness_from_brew_is_installed_when_it_isnt_there() {
    let dir = temp("serve-kinds-brew");
    let brew = dir.join("brew");
    std::fs::write(&brew, format!("#!/bin/sh\necho \"$@\" >> {}\n", dir.join("brew.log").display())).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&brew, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let (serve, port) = start_with(&dir, &[("WISP_GROK_BIN", "/no/such/grok"), ("WISP_BREW", brew.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    // there already: nothing runs
    apply(&api, json!([{ "kind": "harness", "name": "claude", "spec": { "from": "brew", "package": "claude-code" } }])).await;
    assert!(!dir.join("brew.log").exists(), "claude is there: no install");
    // missing: brew installs its formula
    apply(&api, json!([{ "kind": "harness", "name": "grok", "spec": { "from": "brew", "package": "grok-cli" } }])).await;
    assert_eq!(std::fs::read_to_string(dir.join("brew.log")).unwrap().trim(), "install grok-cli");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pipeline_moves_on_at_a_limit_and_picks_the_best_of_n() {
    let dir = temp("serve-kinds-pipe");
    let proj = dir.join("proj");
    let (serve, port) = start_with(&dir, &[("FAKE_LIMIT_ONCE", dir.join("limit-hit").to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(&api, json!([{ "kind": "pipeline", "name": "default", "spec": { "atLimit": "next", "bestOf": 2, "judge": "claude" } }])).await;
    // the harnesses' own detect calls go through the fake too: let them run, then arm the limit
    api.cmd("runtime.agents", json!({})).await;
    let _ = std::fs::remove_file(dir.join("limit-hit"));
    // the first run hits its usage limit: it carries on on another harness
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "title": "Fix add", "cwd": proj, "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let t = api.until(&id, "it carries on elsewhere", |t| t.len() == 2 && ended(&t[1])).await;
    assert_eq!(t[0]["status"], "error", "{:?}", t[0]);
    assert_ne!(t[1]["agent"], "claude", "another harness: {:?}", t[1]);
    assert!(t[1]["prompt"].as_str().unwrap().contains("usage limit"));

    // best of 2: a second run of the same ask, and the judge's pick on the first
    let made = api.cmd("runtime.create", json!({ "prompt": "write the release note", "cwd": proj, "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let at = Instant::now();
    let pick = loop {
        let t = api.cmd("runtime.get", json!({ "id": id })).await;
        if t["ext"]["wisp.router"]["bestOf"].is_object() {
            break t["ext"]["wisp.router"]["bestOf"].clone();
        }
        assert!(at.elapsed() < Duration::from_secs(60), "the judge picks: {t}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let runs = pick["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 2, "{pick}");
    assert!(runs.contains(&pick["winner"]), "{pick}");
    let other = runs.iter().find(|r| **r != json!(id)).unwrap();
    assert_eq!(api.cmd("runtime.spec", json!({ "id": other })).await["prompt"], "write the release note");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_projects_run_scripts_run_in_a_terminal_of_their_own() {
    let dir = temp("serve-kinds-run");
    let proj = dir.join("proj");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(&api, json!([{ "kind": "project", "name": "web", "spec": { "path": proj, "run": ["echo serving > ran.txt"] } }])).await;
    let term = api.cmd("runtime.projectRun", json!({ "cwd": proj.join("src") })).await;
    assert!(term.to_string().contains("run:web"), "{term}");
    let at = Instant::now();
    while !proj.join("ran.txt").exists() {
        assert!(at.elapsed() < Duration::from_secs(20), "the run script ran");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let refused = api.try_cmd("runtime.projectRun", json!({ "cwd": dir })).await;
    assert_eq!(refused["ok"], false, "not in a project: {refused}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_machine_becomes_a_peer_and_goes_with_its_resource() {
    let dir = temp("serve-kinds-machine");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let names = |l: &Value| l.as_array().unwrap().iter().map(|p| (p["name"].as_str().unwrap_or_default().to_owned(), p["port"].clone())).collect::<Vec<_>>();
    apply(&api, json!([{ "kind": "machine", "name": "studio", "spec": { "transport": "loopback", "address": "127.0.0.1", "port": 9 } }, { "kind": "machine", "name": "this", "spec": { "limits": { "maxRuns": 4 } } }])).await;
    assert_eq!(names(&api.cmd("machines.list", json!({})).await), [("studio".to_owned(), json!(9))], "a peer, and this computer isn't one");
    apply(&api, json!([{ "kind": "machine", "name": "studio", "spec": { "transport": "loopback", "address": "127.0.0.1", "port": 10 } }])).await;
    assert_eq!(names(&api.cmd("machines.list", json!({})).await), [("studio".to_owned(), json!(10))], "updated in place");
    let r = api.try_cmd("resources.apply", json!({ "resources": [{ "kind": "machine", "name": "this", "spec": {} }], "prune": true })).await;
    assert_eq!(r["ok"], true, "{r}");
    assert!(api.cmd("machines.list", json!({})).await.as_array().unwrap().is_empty(), "pruned: the peer goes");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_api_key_speaks_with_its_capability_set_at_the_edge() {
    let dir = temp("serve-kinds-key");
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::write(dir.join("home/secrets.json"), r#"{"wisp":{"CI_KEY":"ci-key-0123456789abcdef"}}"#).unwrap();
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    apply(&api, json!([{ "kind": "capability", "name": "ci", "spec": { "allow": ["runtime:list"], "key": "${secret:CI_KEY}" } }])).await;
    let call = |key: &str, cmd: &str, args: Value| {
        let r = api.http.post(format!("http://127.0.0.1:{port}/api/cmd")).header("content-type", "application/json").header("idempotency-key", format!("{cmd}-{key}")).header("x-wisp-key", key).body(json!({ "cmd": cmd, "args": args }).to_string()).send();
        async move {
            let r = r.await.unwrap();
            (r.status().as_u16(), r.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let (st, list) = call("ci-key-0123456789abcdef", "runtime.list", json!({})).await;
    assert_eq!(st, 200, "the key may list: {list}");
    let (st, made) = call("ci-key-0123456789abcdef", "runtime.create", json!({ "prompt": "x", "cwd": dir })).await;
    assert_eq!(st, 403, "and nothing else: {made}");
    let (st, _) = call("not-a-key", "runtime.list", json!({})).await;
    assert_eq!(st, 403, "an unknown key is refused, as a bad token is");
    drop(serve);
}
