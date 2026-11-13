//! What a task had and what it used (ADR-0029), end to end: the skills wisp gave it and the ones Claude Code
//! finds by itself (by hash), its MCP servers probed for their version and tools (one that doesn't answer
//! recorded with why), what it used from its activity, `wisp task setup`, and an adopted task's unknown setup.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines, clippy::many_single_char_names)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, cwd: &Path, port: u16, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp")).args(args).env("WISP_HOME", dir.join("home")).env("WISP_PORT", port.to_string()).env("NO_COLOR", "1").env("CLAUDE_CONFIG_DIR", dir.join("claude-cfg")).current_dir(cwd).stdin(Stdio::null()).output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tasks_setup_is_what_it_had_and_what_it_used() {
    let dir = temp("serve-setup");
    let proj = dir.join("proj");
    let cfg = dir.join("claude-cfg");
    std::fs::create_dir_all(cfg.join("skills/house-style")).unwrap();
    std::fs::write(cfg.join("skills/house-style/SKILL.md"), "---\nname: house-style\n---\nShort sentences.\n").unwrap();
    // an MCP server that answers initialize and tools/list
    let server = dir.join("mcp-probe");
    std::fs::write(&server, "#!/bin/sh\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"probe\",\"version\":\"1.4.0\"}}}'\necho '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"do_x\"},{\"name\":\"do_y\"}]}}'\n").unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&server, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    // and one that never answers
    let slow = dir.join("mcp-slow");
    std::fs::write(&slow, "#!/bin/sh\nexec sleep 30\n").unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&slow, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let (serve, port) = start_with(&dir, &[("CLAUDE_CONFIG_DIR", cfg.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let r = api
        .try_cmd(
            "resources.apply",
            json!({ "resources": [
                { "kind": "agent", "name": "writer", "spec": { "harness": "claude", "skills": ["tidy"] } },
                { "kind": "skill", "name": "tidy", "spec": { "description": "keeps it tidy", "body": "Tidy up." } },
                { "kind": "connector", "name": "probe", "spec": { "command": server.display().to_string() } },
                { "kind": "connector", "name": "dead", "spec": { "command": "/usr/bin/false" } },
                { "kind": "connector", "name": "slow", "spec": { "command": slow.display().to_string() } }
            ] }),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "agent": "writer", "worktree": false })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let at = Instant::now();
    let setup = loop {
        let v = api.cmd("runtime.setup", json!({ "id": id })).await;
        let servers = v["available"]["mcpServers"].as_array().cloned().unwrap_or_default();
        if !servers.is_empty() && servers.iter().all(|s| s["probe"] != "pending") {
            break v;
        }
        assert!(at.elapsed() < Duration::from_secs(20), "probed: {v}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let a = &setup["available"];
    let server = |n: &str| a["mcpServers"].as_array().unwrap().iter().find(|s| s["name"] == n).cloned().unwrap();

    // setup_lists_what_wisp_gave_the_run
    assert_eq!((a["harness"].clone(), a["mode"].clone()), (json!("claude"), json!("auto")), "{a}");
    let tidy = a["skills"].as_array().unwrap().iter().find(|k| k["name"] == "tidy").unwrap();
    assert_eq!((tidy["source"].clone(), tidy["outside"].clone()), (json!("wisp"), json!(false)));
    assert_eq!(tidy["hash"].as_str().unwrap().len(), 16);
    // outside_skills_are_recorded_by_hash
    let outside = a["skills"].as_array().unwrap().iter().find(|k| k["name"] == "house-style").unwrap_or_else(|| panic!("{a}"));
    assert_eq!(outside["outside"], true);
    // a_stdio_server_is_probed_for_its_version_and_tools
    let p = server("probe");
    assert_eq!((p["probe"].clone(), p["version"].clone(), p["tools"].clone()), (json!("ok"), json!("1.4.0"), json!(["do_x", "do_y"])), "{p}");
    // a_server_that_doesnt_answer_is_recorded_unprobed
    let d = server("dead");
    assert_eq!(d["probe"], "failed", "{d}");
    assert!(d["why"].as_str().is_some_and(|w| !w.is_empty()), "{d}");
    // a_probe_that_times_out_says_so
    let w = server("slow");
    assert_eq!((w["probe"].clone(), w["why"].clone()), (json!("failed"), json!("timed out after 5 s")), "{w}");
    assert_eq!(api.turns(&id).await[0]["status"], "done", "the run went on");
    // used_is_read_from_the_transcript (the fake claude edits math.js)
    assert!(setup["used"]["builtin"].as_object().is_some_and(|m| !m.is_empty()), "{}", setup["used"]);
    let (code, out, err) = wisp(&dir, &proj, port, &["task", "setup", &id]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("house-style  outside wisp") && out.contains("probe") && out.contains("v1.4.0 · 2 tools") && out.contains("not probed"), "{out}");

    // an_adopted_task_says_its_setup_is_unknown
    let cwd = std::fs::canonicalize(&proj).unwrap().display().to_string();
    let store = cfg.join("projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>());
    std::fs::create_dir_all(&store).unwrap();
    let sid = "7b3e4a3c-0000-4000-8000-00000000cafe";
    std::fs::write(store.join(format!("{sid}.jsonl")), format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": "hi" }, "cwd": cwd, "timestamp": "2026-11-09T10:00:00.000Z" }))).unwrap();
    let adopted = api.cmd("runtime.adoptSession", json!({ "harness": "claude", "id": sid })).await;
    let v = api.cmd("runtime.setup", json!({ "id": adopted["id"] })).await;
    assert!(v["available"].is_null() && v["note"].as_str().unwrap().contains("ran outside wisp"), "{v}");
    let _: Value = v;
    drop(serve);
}

async fn mcp(http: &reqwest::Client, port: u16, headers: &[(&str, &str)], body: Value) -> Value {
    let mut r = http.post(format!("http://127.0.0.1:{port}/api/mcp")).header("content-type", "application/json");
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    serde_json::from_slice(&r.body(body.to_string()).send().await.unwrap().bytes().await.unwrap()).unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_catalogue_is_wisps_mcp_tools() {
    let dir = temp("serve-mcp-gen");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap()), ("FAKE_DELAY", "3000")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let names = |list: &Value| list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect::<Vec<_>>();

    // every_command_is_an_mcp_tool: you (no token) get one per catalogue command, ui-only ones aside
    let catalogue = api.cmd("cli.catalogue", json!({})).await;
    let mine = names(&mcp(&api.http, port, &[], json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await);
    let cmds: Vec<&Value> = catalogue.as_array().or_else(|| catalogue["commands"].as_array()).unwrap().iter().collect();
    assert!(cmds.len() > 50, "{}", cmds.len());
    for c in &cmds {
        if c["uiOnly"].is_null() {
            let n = c["id"].as_str().unwrap().replace('.', "_");
            assert!(mine.contains(&n), "{n} isn't a tool");
        }
    }
    // the_input_schema_follows_the_args_type, for a real command
    let list = mcp(&api.http, port, &[], json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let track = list["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "history_track").unwrap();
    assert_eq!(track["inputSchema"]["required"], json!(["id"]), "{track}");

    // a_caller_sees_only_what_its_set_allows: an agent's token
    let made = api.cmd("runtime.create", json!({ "prompt": "hi", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    let runs = common::until_records(&rec.join("claude.jsonl"), "the run's record", |r| !r.is_empty()).await;
    let argv = common::argv(&runs[0]);
    let cfg: Value = serde_json::from_str(&argv[argv.iter().position(|a| a == "--mcp-config").unwrap() + 1]).unwrap();
    let token = cfg["mcpServers"]["wisp"]["headers"]["x-wisp-token"].as_str().unwrap().to_owned();
    let agent = [("x-wisp-token", token.as_str()), ("x-wisp-session", id.as_str())];
    let theirs = names(&mcp(&api.http, port, &agent, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).await);
    assert!(theirs.contains(&"history_resumeRequest".to_owned()) && theirs.contains(&"runtime_get".to_owned()), "{theirs:?}");
    assert!(!theirs.contains(&"history_resumeAnswer".to_owned()) && !theirs.contains(&"resources_apply".to_owned()), "only what agent:session allows");
    // a_hand_made_tool_keeps_its_name: ask_user is wisp's own, once
    assert_eq!(theirs.iter().filter(|n| *n == "ask_user").count(), 1);
    // a_tool_call_runs_the_command_as_the_caller
    let got = mcp(&api.http, port, &agent, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "runtime_get", "arguments": { "id": id } } })).await;
    assert!(got.to_string().contains(&id), "{got}");
    let refused = mcp(&api.http, port, &agent, json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "resources_apply", "arguments": { "resources": [] } } })).await;
    assert!(refused.to_string().contains("isError") || refused.get("error").is_some(), "{refused}");
    drop(serve);
}
