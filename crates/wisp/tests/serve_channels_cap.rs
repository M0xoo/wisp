//! F-chan-10 end to end on a real `wisp serve` with the fake agent: a task a channel started (a Slack message the
//! grid routed here) is capped at Edits on its row and runs no higher; its agent's token speaks as `agent:capped`
//! (a capped refusal over MCP); another task's agent asking it for Full auto over MCP is refused with v1's words,
//! and so is a mode switch from anyone but the user; the user switching it in wisp lifts the cap.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::{Api, argv, records, start_with, temp};
use serde_json::{Value, json};

/// The MCP token a task's run was given, from the fake agent's record of its argv.
async fn token_of(rec: &std::path::Path, id: &str) -> String {
    let at = Instant::now();
    loop {
        for r in records(&rec.join("claude.jsonl")) {
            let a = argv(&r);
            let Some(i) = a.iter().position(|x| x == "--mcp-config") else { continue };
            let cfg: Value = serde_json::from_str(&a[i + 1]).unwrap();
            let h = &cfg["mcpServers"]["wisp"]["headers"];
            if h["x-wisp-session"] == id {
                return h["x-wisp-token"].as_str().unwrap().to_owned();
            }
        }
        assert!(
            at.elapsed() < Duration::from_secs(30),
            "{id}'s run is recorded in claude.jsonl (records: {:?})",
            std::fs::read_dir(rec).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// `tools/call` as task `id`'s agent: (its text, whether it is an error result).
async fn mcp(api: &Api, port: u16, (id, token): (&str, &str), tool: &str, args: Value) -> (String, bool) {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } });
    let r = api
        .http
        .post(format!("http://127.0.0.1:{port}/api/mcp"))
        .header("content-type", "application/json")
        .header("x-wisp-token", token)
        .header("x-wisp-session", id)
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap_or(Value::Null);
    let text = v["result"]["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
    (if text.is_empty() { v.to_string() } else { text }, v["result"]["isError"] == true || v.get("error").is_some())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_task_stays_at_edits_its_agent_is_capped_and_only_the_user_raises_it() {
    let dir = temp("serve-channels-cap");
    let (proj, rec) = (dir.join("proj"), dir.join("rec"));
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "20000"), ("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let applied = api
        .try_cmd(
            "resources.apply",
            json!({ "resources": [{ "kind": "project", "name": "proj", "spec": { "path": proj } }], "trust": true }),
        )
        .await;
    assert_eq!(applied["ok"], true, "{applied}");
    api.cmd("settings.set", json!({ "key": "channels.acceptChannels", "value": true })).await;

    // a message from Slack starts it: capped at Edits on its row; it names no mode, so it runs at the channel's Plan.
    // It names Claude: with no harness named, Auto picks among every fake on a seeded dice roll, and only Claude's
    // record carries the `--mcp-config` the token is read from.
    let said = api
        .cmd(
            "channels.routed",
            json!({ "channel": "slack", "name": "Ada", "sender": "u1", "text": "with claude: fix the add bug", "thread": "t1" }),
        )
        .await;
    assert_eq!(said["status"], 200, "{said}");
    let at = Instant::now();
    let id = loop {
        let list = api.cmd("runtime.list", json!({})).await;
        if let Some(t) = list.as_array().unwrap().first() {
            break t["id"].as_str().unwrap().to_owned();
        }
        assert!(at.elapsed() < Duration::from_secs(30), "the channel's task starts: {said}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let t = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(t["ext"]["wisp.runtime"]["capped"], json!({ "mode": "edits" }), "{t}");
    assert_eq!(t["mode"], "plan");
    let turns = api.until(&id, "its turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    assert_eq!(turns[0]["mode"], "plan");

    // its own agent speaks as agent:capped at the edge: the user's connectors are out of its reach
    let capped_token = token_of(&rec, &id).await;
    let (text, err) = mcp(&api, port, (&id, &capped_token), "wisp_connectors", json!({})).await;
    assert!(err && text.contains("this task was started from a channel with a mode cap"), "{text}");

    // another task's agent asks it for Full auto over MCP: refused with v1's words, nothing sent
    let other = api.cmd("runtime.create", json!({ "prompt": "lead work", "cwd": proj, "agent": "claude" })).await;
    let oid = other["id"].as_str().unwrap().to_owned();
    api.until(&oid, "the other turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    let other_token = token_of(&rec, &oid).await;
    let (text, err) =
        mcp(&api, port, (&oid, &other_token), "wisp_task", json!({ "task": id, "action": "reply", "text": "ship it", "mode": "auto" }))
            .await;
    assert!(err && text.contains("Full auto is above this task's cap of Edits"), "{text}");
    assert_eq!(api.turns(&id).await.len(), 1, "nothing was sent");
    assert_eq!(api.cmd("runtime.get", json!({ "id": id })).await["ext"]["wisp.runtime"]["capped"]["mode"], "edits");

    // the user switching it in wisp lifts the cap (v1 capped.js); its agent is no longer capped
    api.cmd("runtime.setMode", json!({ "id": id, "mode": "auto" })).await;
    let t = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(t["mode"], "auto");
    assert!(t["ext"]["wisp.runtime"].get("capped").is_none(), "{t}");
    let (text, _) = mcp(&api, port, (&id, &capped_token), "wisp_connectors", json!({})).await;
    assert!(!text.contains("mode cap"), "{text}");
    drop(serve);
}
