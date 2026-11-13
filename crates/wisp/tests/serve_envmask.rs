//! .env values never leave the server (ADR-0050, v1 test/env-mask.test.js "through a server"): the real binary,
//! a replayed Claude run that `cat`s a .env file, edits it and answers with a code and a diff block about it. The
//! sync stream (live and from a snapshot), `runtime.turns` / `runtime.activity`, `wisp_session` and a share
//! bundle carry `KEY=••••`, never a value; Reveal (`runtime.unmasked`) answers the one item as it is; Settings →
//! Privacy off shows them, and a share masks even then.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::json;

const DOTS: &str = "••••";

fn replay(dir: &std::path::Path, proj: &std::path::Path) -> std::path::PathBuf {
    let env = proj.join(".env").display().to_string();
    let answer = format!(
        "Rotated the key.\n```wisp\n{}\n```",
        json!({ "blocks": [
            { "type": "hero", "title": "Key rotated", "summary": "New key in .env.", "status": "done" },
            { "type": "code", "file": ".env", "code": "API_KEY=sk-live-two\nPORT=3000" },
            { "type": "diff", "file": ".env", "before": "API_KEY=sk-live-one", "after": "API_KEY=sk-live-two" }
        ] })
    );
    let s = "sess-env";
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env", "description": "Show the env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c2", "name": "Edit", "input": { "file_path": env, "old_string": "API_KEY=sk-live-one", "new_string": "API_KEY=sk-live-two" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c2", "content": [{ "type": "text", "text": "ok" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    let f = dir.join("env-run.jsonl");
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    f
}

/// Reads the sync stream until `want` shows or the time runs out; everything it carried.
async fn stream(http: &reqwest::Client, port: u16, topics: &str, want: &str, secs: u64) -> String {
    let url = format!(
        "http://127.0.0.1:{port}/api/events?proto_min=2&proto_max=2&client_id=envmask-{}&build=t&topics={topics}",
        std::process::id()
    );
    let mut r = http.get(url).send().await.unwrap();
    let mut seen = String::new();
    let at = Instant::now();
    while at.elapsed() < Duration::from_secs(secs) && !seen.contains(want) {
        match tokio::time::timeout(Duration::from_millis(500), r.chunk()).await {
            Ok(Ok(Some(b))) => seen.push_str(&String::from_utf8_lossy(&b)),
            Ok(_) => break,
            Err(_) => {}
        }
    }
    seen
}

fn no_value(what: &str, text: &str) {
    if let Some(i) = text.find("sk-live") {
        panic!("{what} carried a .env value: …{}…", &text[i.saturating_sub(200)..(i + 40).min(text.len())]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sync_topic_a_share_and_every_read_never_carry_a_env_value_and_reveal_shows_one() {
    let dir = temp("envmask");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = replay(&dir, &proj);
    // the run waits 1.5 s, so the live stream is open before its first event
    let (_serve, port) = start_with(&dir, &[("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "1500")]);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };

    let id = api.cmd("runtime.create", json!({ "prompt": "rotate the key", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let topic = format!("session:{id}");
    // the live stream, open before the run: every commit it carries
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "Key rotated", 60).await }
    });
    let turns = api.until(&id, "the turn to end", |t| t.last().is_some_and(ended)).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("Key rotated"), "the stream saw the turn: {}", &seen[seen.len().saturating_sub(600)..]);
    no_value("the live sync stream", &seen);
    assert!(seen.contains(&format!("API_KEY={DOTS}")), "masked, not dropped");

    // a fresh client: the topic's snapshot
    let snap = stream(&http, port, &topic, "Key rotated", 10).await;
    no_value("the sync snapshot", &snap);

    // the reads: turns, activity, an agent's wisp_session
    let t = turns.last().unwrap().clone();
    no_value("runtime.turns", &t.to_string());
    let tid = t["id"].as_str().unwrap().to_owned();
    let steps = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    no_value("runtime.activity", &steps.to_string());
    let agent = api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await;
    no_value("wisp_session", &agent.to_string());

    // a share bundle (the share page's content)
    let share = api.cmd("share.preview", json!({ "id": id, "level": "full" })).await;
    no_value("a share", &share.to_string());

    // Reveal: the one item as it is
    let blocks = t["presentation"]["blocks"].as_array().unwrap();
    let code = blocks.iter().position(|b| b["type"] == "code").unwrap();
    assert_eq!(blocks[code]["masked"], true);
    let raw = api.cmd("runtime.unmasked", json!({ "id": id, "turnId": tid, "block": code })).await;
    assert!(raw["code"].as_str().unwrap().contains("sk-live-two"), "{raw}");
    // the event that carries the output (the page asks by it): the call's own `tool_output`
    let read = steps["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["kind"] == "tool_output" && s["text"].as_str().is_some_and(|t| t.contains(DOTS)))
        .cloned()
        .unwrap_or_else(|| panic!("a masked output: {steps}"));
    assert_eq!(read["env"], true, "flagged by the turn machine");
    let raw = api.cmd("runtime.unmasked", json!({ "id": id, "turnId": tid, "step": read["seq"] })).await;
    assert!(raw.to_string().contains("sk-live-one"), "{raw}");
    let hero = api.try_cmd("runtime.unmasked", json!({ "id": id, "turnId": tid, "block": 0 })).await;
    assert_eq!(hero["ok"], false, "nothing hidden there: {hero}");

    // Hide .env values off: as it is everywhere but a share
    api.cmd("settings.set", json!({ "key": "git.maskEnvFiles", "value": false })).await;
    let shown = api.turns(&id).await;
    assert!(shown.last().unwrap().to_string().contains("sk-live-two"), "off shows them");
    no_value("a share with masking off", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
}

#[test]
fn reveal_is_refused_to_a_capped_agent_and_a_share_page() {
    use wisp_kernel::Caller;
    use wisp_kernel::caps::allowed;
    assert!(!allowed(&Caller::agent("s1", true), "runtime:unmasked"), "a capped agent");
    assert!(!allowed(&Caller::set("preview"), "runtime:unmasked"), "a share page's viewer");
    assert!(allowed(&Caller::user(), "runtime:unmasked"), "the user");
    assert!(allowed(&Caller::agent("s1", true), "runtime:turns"), "a capped agent still reads turns, masked");
}
