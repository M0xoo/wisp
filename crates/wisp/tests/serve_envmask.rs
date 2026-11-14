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

/// A run that reads .env, thinks with its value and gets a tool error that prints it (no answer block about .env).
fn quoting_replay(dir: &std::path::Path) -> std::path::PathBuf {
    let s = "sess-quote";
    let answer = format!("Checked.\n```wisp\n{}\n```", json!({ "blocks": [{ "type": "hero", "title": "Key checked", "status": "done" }] }));
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "thinking", "thinking": "So the key is sk-live-one; I'll try it against the API." }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c2", "name": "Bash", "input": { "command": "curl -H \"x-key: $API_KEY\" https://api.test" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c2", "is_error": true, "content": [{ "type": "text", "text": "401 Unauthorized: key sk-live-one revoked" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    let f = dir.join("quote-run.jsonl");
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    f
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turns_thinking_and_a_tool_error_quoting_a_env_value_reach_no_topic_read_or_share() {
    let dir = temp("envquote");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = quoting_replay(&dir);
    let (_serve, port) = start_with(&dir, &[("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "1500")]);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id = api.cmd("runtime.create", json!({ "prompt": "check the key", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "Key checked", 60).await }
    });
    let turns = api.until(&id, "the turn to end", |t| t.last().is_some_and(ended)).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("Key checked"), "the stream saw the turn");
    no_value("the live sync stream", &seen);
    no_value("the sync snapshot", &stream(&http, port, &topic, "Key checked", 10).await);

    let tid = turns.last().unwrap()["id"].as_str().unwrap().to_owned();
    let steps = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    no_value("runtime.activity", &steps.to_string());
    let items = steps["items"].as_array().unwrap();
    let think = items.iter().find(|s| s["kind"] == "thinking").unwrap_or_else(|| panic!("a thinking step: {steps}"));
    assert_eq!(think["text"], format!("So the key is {DOTS}; I'll try it against the API."), "masked, not dropped");
    assert!(think.get("hide").is_none(), "where it was masked stays on the server");
    let err = items.iter().find(|s| s["kind"] == "tool_error").unwrap_or_else(|| panic!("a tool error: {steps}"));
    assert_eq!(err["text"], format!("401 Unauthorized: key {DOTS} revoked"));
    // a page that starts after the read: the rows' own ranges still mask them
    let since = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid, "sinceSeq": think["seq"].as_u64().unwrap() - 1 })).await;
    no_value("an activity page after the read", &since.to_string());
    no_value("runtime.turns", &api.turns(&id).await.last().unwrap().to_string());
    no_value("wisp_session", &api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await.to_string());
    no_value("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
    // Hide .env values off: as it is (the store kept it), but never in a share
    api.cmd("settings.set", json!({ "key": "git.maskEnvFiles", "value": false })).await;
    let shown = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    assert!(shown.to_string().contains("sk-live-one"), "off shows them");
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

/// A run's stream as a replay file: each item a content block of one assistant or user message, then its answer.
fn write_replay(f: &std::path::Path, s: &str, msgs: &[serde_json::Value], title: &str) {
    let answer = format!("Done.\n```wisp\n{}\n```", json!({ "blocks": [{ "type": "hero", "title": title, "status": "done" }] }));
    let mut lines = vec![json!({ "type": "system", "subtype": "init", "session_id": s })];
    lines.extend(msgs.iter().cloned());
    lines.push(json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }));
    lines.push(json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }));
    std::fs::write(f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
}

/// A later turn that quotes what an earlier one read: in its thinking (a PEM key's inner line too), a command line
/// and its description, and the command's output.
fn quoting_later(s: &str) -> Vec<serde_json::Value> {
    let a = |c: serde_json::Value| json!({ "type": "assistant", "session_id": s, "message": { "content": [c] } });
    let u = |c: serde_json::Value| json!({ "type": "user", "session_id": s, "message": { "content": [c] } });
    vec![
        a(
            json!({ "type": "thinking", "thinking": "Earlier the key was sk-live-one and the PEM's body line PEMLINExyz0123456789 looked odd." }),
        ),
        a(
            json!({ "type": "tool_use", "id": "q1", "name": "Bash", "input": { "command": "curl -H \"Authorization: Bearer sk-live-one\" https://api.test", "description": "Call the API with sk-live-one" } }),
        ),
        u(json!({ "type": "tool_result", "tool_use_id": "q1", "content": [{ "type": "text", "text": "accepted token sk-live-one" }] })),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_value_read_in_one_turn_and_quoted_in_a_later_one_or_after_a_restart_reaches_no_topic_or_read() {
    let dir = temp("envlater");
    let proj = dir.join("proj");
    let file = "API_KEY=sk-live-one\nPRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----\nPEMLINExyz0123456789\n-----END PRIVATE KEY-----\"\n";
    std::fs::write(proj.join(".env"), file).unwrap();
    let f = dir.join("later-run.jsonl");
    let s = "sess-later";
    let read = vec![
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": file }] }] } }),
    ];
    write_replay(&f, s, &read, "Read it");
    let env = [("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "1500")];
    let (serve, port) = start_with(&dir, &env);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id = api.cmd("runtime.create", json!({ "prompt": "read the env", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    api.until(&id, "turn 1 to end", |t| t.len() == 1 && ended(&t[0])).await;

    // turn 2, same server: the values the task read are in memory
    write_replay(&f, s, &quoting_later(s), "Quoted two");
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "Quoted two", 60).await }
    });
    api.cmd("runtime.followUp", json!({ "id": id, "text": "use it" })).await;
    let turns = api.until(&id, "turn 2 to end", |t| t.len() == 2 && ended(&t[1])).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("Quoted two"), "the stream saw turn 2");
    let check = |what: &str, text: &str| {
        no_value(what, text);
        assert!(!text.contains("PEMLINE"), "{what} carried a line of a multi-line .env value");
    };
    check("the live sync stream", &seen);
    check("the sync snapshot", &stream(&http, port, &topic, "Quoted two", 10).await);
    let tid = turns[1]["id"].as_str().unwrap().to_owned();
    let steps = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    check("runtime.activity", &steps.to_string());
    let call = steps["items"].as_array().unwrap().iter().find(|x| x["kind"] == "tool").cloned().unwrap_or_else(|| panic!("{steps}"));
    assert!(call.to_string().contains(&format!("Bearer {DOTS}")), "masked, not dropped: {call}");
    check("runtime.turns", &json!(api.turns(&id).await).to_string());
    check("runtime.get", &api.cmd("runtime.get", json!({ "id": id })).await.to_string());
    check("wisp_session", &api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await.to_string());
    check("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());

    // turn 3 after a restart: nothing in memory, the task's stored reads seed it
    serve.stop();
    let (_serve, port) = start_with(&dir, &env);
    let api = Api { http: http.clone(), port, n: 0.into() };
    write_replay(&f, s, &quoting_later(s), "Quoted three");
    api.cmd("runtime.followUp", json!({ "id": id, "text": "again" })).await;
    let turns = api.until(&id, "turn 3 to end", |t| t.len() == 3 && ended(&t[2])).await;
    let tid = turns[2]["id"].as_str().unwrap().to_owned();
    let mut steps = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    check("runtime.activity after a restart", &steps.to_string());
    // and as the store has it with the setting off: turn 3's rows carry the ranges, so masking is all that's needed
    api.cmd("settings.set", json!({ "key": "git.maskEnvFiles", "value": false })).await;
    steps = api.cmd("runtime.activity", json!({ "id": id, "turnId": tid })).await;
    let think = steps["items"].as_array().unwrap().iter().find(|x| x["kind"] == "thinking").cloned().unwrap_or_else(|| panic!("{steps}"));
    assert!(think["hide"].as_array().is_some_and(|h| h.len() == 2), "both quotes flagged by the seeded turn: {think}");
    check("a share with masking off", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_command_quoting_a_value_an_earlier_turn_read_reaches_no_topic_read_share_or_retry_prompt() {
    let dir = temp("envblocked");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = dir.join("blocked-run.jsonl");
    let s = "sess-blocked";
    let read = vec![
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
    ];
    write_replay(&f, s, &read, "Read it");
    let (_serve, port) = start_with(&dir, &[("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "1500")]);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    // not Full auto: what its permissions refuse is kept for Allow & retry
    let id = api.cmd("runtime.create", json!({ "prompt": "read the env", "cwd": proj, "agent": "claude", "mode": "edits" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    api.until(&id, "turn 1 to end", |t| t.len() == 1 && ended(&t[0])).await;

    // turn 2 (another batch): its refused call quotes the key turn 1 read
    let cmd = "curl -H \"Authorization: Bearer sk-live-one\" https://api.test";
    let answer =
        format!("Refused.\n```wisp\n{}\n```", json!({ "blocks": [{ "type": "hero", "title": "Call refused", "status": "blocked" }] }));
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01,
                "permission_denials": [{ "tool_name": "Bash", "tool_use_id": "d1", "tool_input": { "command": cmd } }] }),
    ];
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "Call refused", 60).await }
    });
    api.cmd("runtime.followUp", json!({ "id": id, "text": "call the API" })).await;
    let turns = api.until(&id, "turn 2 to end", |t| t.len() == 2 && ended(&t[1])).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("Call refused"), "the stream saw turn 2");
    no_value("the live sync stream", &seen);
    no_value("the sync snapshot", &stream(&http, port, &topic, "Call refused", 10).await);
    let blocked = &turns[1]["ext"]["wisp.runtime"]["blocked"][0];
    assert_eq!(
        blocked["detail"],
        format!("curl -H \"Authorization: Bearer {DOTS}\" https://api.test"),
        "masked, not dropped: {}",
        turns[1]
    );
    assert!(blocked.get("hide").is_none(), "where it was masked stays on the server");
    no_value("runtime.turns", &json!(turns).to_string());
    no_value("wisp_session", &api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await.to_string());
    no_value("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());

    // Allow & retry: the follow-up's prompt (a stored row) names the command masked
    write_replay(&f, s, &[], "Retried");
    api.cmd("runtime.approveBlocked", json!({ "id": id, "allow": true })).await;
    let turns = api.until(&id, "the retry to end", |t| t.len() == 3 && ended(&t[2])).await;
    let prompt = turns[2]["prompt"].as_str().unwrap();
    assert!(prompt.contains(&format!("Bearer {DOTS}")) && !prompt.contains("sk-live"), "{prompt}");
}

/// The task's /btw entries, once the one asked has landed.
async fn btw_landed(api: &Api, id: &str) -> serde_json::Value {
    let at = Instant::now();
    loop {
        let s = api.cmd("runtime.get", json!({ "id": id })).await;
        let b = &s["ext"]["wisp.runtime"]["btw"][0];
        if b.is_object() && b["pending"] != true {
            return s;
        }
        assert!(at.elapsed() < Duration::from_secs(30), "the /btw to land: {s}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_forked_btw_answer_quoting_a_value_the_task_read_reaches_no_topic_read_or_share_before_or_after_a_restart() {
    let dir = temp("envbtw");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = dir.join("btw-run.jsonl");
    let s = "sess-btw";
    let read = vec![
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
    ];
    write_replay(&f, s, &read, "Read it");
    let env = [("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "300")];
    let (serve, port) = start_with(&dir, &env);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id = api.cmd("runtime.create", json!({ "prompt": "read the env", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    api.until(&id, "turn 1 to end", |t| t.len() == 1 && ended(&t[0])).await;

    // the /btw runs on a fork of the conversation; its answer quotes the key in prose and as a .env line
    let answer = "Marker btw-landed: the key is sk-live-one.\nAPI_KEY=sk-live-one";
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "btw-landed", 30).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await; // the stream is open before it lands
    let asked = api.cmd("runtime.btw", json!({ "id": id, "question": "why that key?" })).await;
    assert_eq!(asked["pending"], true, "{asked}");
    let got = btw_landed(&api, &id).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("btw-landed"), "the task's stream saw the /btw");
    no_value("the task's live sync stream", &seen);
    let b = &got["ext"]["wisp.runtime"]["btw"][0];
    assert!(b["error"].is_null(), "the /btw answered: {b}");
    assert_eq!(b["answer"], format!("Marker btw-landed: the key is {DOTS}.\nAPI_KEY={DOTS}"), "masked, not dropped");
    assert!(b.get("hide").is_none(), "where it was masked stays on the server: {b}");
    no_value("runtime.get", &got.to_string());
    no_value("the task's snapshot", &stream(&http, port, &topic, "btw-landed", 10).await);
    let list = stream(&http, port, "list", "btw-landed", 10).await;
    assert!(list.contains(&id), "the list's snapshot has the task");
    no_value("the list's snapshot", &list);
    no_value("runtime.list", &api.cmd("runtime.list", json!({})).await.to_string());
    no_value("wisp_session", &api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await.to_string());
    no_value("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());

    // after a restart: nothing in memory, the row's own flags still mask it
    serve.stop();
    let (_serve, port) = start_with(&dir, &env);
    let api = Api { http: http.clone(), port, n: 0.into() };
    let list = stream(&http, port, "list", "btw-landed", 10).await;
    assert!(list.contains("btw-landed"), "the list's snapshot after a restart has the /btw, masked");
    no_value("the list's snapshot after a restart", &list);
    no_value("the task's snapshot after a restart", &stream(&http, port, &topic, "btw-landed", 10).await);
    no_value("runtime.get after a restart", &api.cmd("runtime.get", json!({ "id": id })).await.to_string());
    no_value("a share after a restart", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
    // Hide .env values off: as the store has it
    api.cmd("settings.set", json!({ "key": "git.maskEnvFiles", "value": false })).await;
    let shown = api.cmd("runtime.get", json!({ "id": id })).await;
    assert!(shown["ext"]["wisp.runtime"]["btw"][0]["answer"].as_str().unwrap().contains("sk-live-one"), "off shows it: {shown}");
    no_value("a share with masking off", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_title_and_list_preview_from_an_answer_quoting_a_value_reach_no_list_row_or_task_read_before_or_after_a_restart() {
    let dir = temp("envtitle");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = dir.join("title-run.jsonl");
    let s = "sess-title";
    let answer = format!(
        "Read.\n```wisp\n{}\n```",
        json!({ "blocks": [{ "type": "hero", "topic": "Key sk-live-one", "title": "Read", "summary": "Marker title-landed: sk-live-one is live", "status": "done" }] })
    );
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    let env = [("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "300")];
    let (serve, port) = start_with(&dir, &env);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id = api.cmd("runtime.create", json!({ "prompt": "read the env", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    api.until(&id, "turn 1 to end", |t| t.len() == 1 && ended(&t[0])).await;
    let reads = |api: &Api| {
        let (api, id) = (Api { http: api.http.clone(), port: api.port, n: 0.into() }, id.clone());
        async move {
            let got = api.cmd("runtime.get", json!({ "id": id })).await;
            assert_eq!(got["title"], format!("Key {DOTS}"), "masked, not dropped: {got}");
            no_value("runtime.get", &got.to_string());
            let list = api.cmd("runtime.list", json!({})).await;
            let row = list.as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).cloned().unwrap();
            assert_eq!(row["preview"], format!("Marker title-landed: {DOTS} is live"), "{row}");
            assert!(row.get("envHide").is_none(), "the ranges stay on the server: {row}");
            no_value("runtime.list", &list.to_string());
            let list = stream(&api.http, api.port, "list", "title-landed", 10).await;
            assert!(list.contains("title-landed"), "the list's snapshot has the task");
            no_value("the list's snapshot", &list);
        }
    };
    reads(&api).await;
    // after a restart: the rows' kept ranges, nothing in memory
    serve.stop();
    let (_serve, port) = start_with(&dir, &env);
    let api = Api { http: http.clone(), port, n: 0.into() };
    reads(&api).await;
}

/// A run that reads .env and answers in prose that quotes the value: the hero's title and summary, a markdown and a
/// callout block, the text ahead of its wisp block, and a `KEY=value` line of a value it never read.
fn prose_replay(f: &std::path::Path, s: &str) {
    let answer = format!(
        "Marker prose-landed: the key sk-live-one works.\nSECRET_TOKEN=tok-unread-123456\n```wisp\n{}\n```",
        json!({ "blocks": [
            { "type": "hero", "title": "Key sk-live-one is live", "summary": "Checked sk-live-one against the API.", "status": "done" },
            { "type": "markdown", "text": "The `.env` has `API_KEY=sk-live-one`, and sk-live-one is accepted.\nOTHER_TOKEN=tok-unread-654321" },
            { "type": "callout", "tone": "warn", "title": "Rotate sk-live-one", "text": "It was printed: sk-live-one." }
        ] })
    );
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    std::fs::write(f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turns_own_prose_quoting_a_env_value_reaches_no_topic_read_share_or_agent_before_or_after_a_restart() {
    let dir = temp("envprose");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = dir.join("prose-run.jsonl");
    prose_replay(&f, "sess-prose");
    let env = [("FAKE_REPLAY", f.to_str().unwrap()), ("FAKE_DELAY", "1500")];
    let (serve, port) = start_with(&dir, &env);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id = api.cmd("runtime.create", json!({ "prompt": "check the key", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "prose-landed", 60).await }
    });
    let turns = api.until(&id, "the turn to end", |t| t.last().is_some_and(ended)).await;
    let seen = live.await.unwrap();
    let check = |what: &str, text: &str| {
        no_value(what, text);
        if let Some(i) = text.find("tok-unread") {
            panic!("{what} carried a KEY=value line's value: …{}…", &text[i.saturating_sub(300)..(i + 40).min(text.len())]);
        }
    };
    assert!(seen.contains("prose-landed"), "the stream saw the answer");
    check("the live sync stream", &seen);
    check("the sync snapshot", &stream(&http, port, &topic, "prose-landed", 10).await);
    let t = turns.last().unwrap();
    check("runtime.turns", &t.to_string());
    let blocks = t["presentation"]["blocks"].as_array().unwrap_or_else(|| panic!("{t}"));
    assert_eq!(blocks[0]["title"], format!("Key {DOTS} is live"), "masked, not dropped: {t}");
    assert_eq!(blocks[0]["type"], "hero", "structure stays");
    assert!(t.get("envHide").is_none(), "where it was masked stays on the server: {t}");
    check("runtime.presentation", &api.cmd("runtime.presentation", json!({ "id": id })).await.to_string());
    check("wisp_session", &api.cmd("runtime.agent.session", json!({ "session": id, "of": id })).await.to_string());
    check("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());

    // after a restart: nothing in memory, the turn row's own ranges mask it
    serve.stop();
    let (_serve, port) = start_with(&dir, &env);
    let api = Api { http: http.clone(), port, n: 0.into() };
    let snap = stream(&http, port, &topic, "prose-landed", 10).await;
    assert!(snap.contains("prose-landed"), "the snapshot after a restart has the answer, masked: {}", &snap[..snap.len().min(600)]);
    check("the sync snapshot after a restart", &snap);
    check("runtime.turns after a restart", &json!(api.turns(&id).await).to_string());
    check("a share after a restart", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
    // Hide .env values off: as the store has it, never in a share
    api.cmd("settings.set", json!({ "key": "git.maskEnvFiles", "value": false })).await;
    assert!(json!(api.turns(&id).await).to_string().contains("sk-live-one"), "off shows it");
    check("a share with masking off", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
}

/// Another plugin's data about a task (ADR-0054): a goal's judge reads the task's .env and votes `NOT MET`, quoting a
/// value the task read. Its check record (`goal_run`: why, everything it answered and did) on the task's topic, live
/// and from a snapshot, and the task's goal slot never carry the value, and neither does a share or `runtime.get`.
#[tokio::test(flavor = "multi_thread")]
async fn a_goal_judges_verdict_quoting_a_value_the_task_read_reaches_no_topic_read_or_share() {
    let dir = temp("envgoal");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = dir.join("goal-run.jsonl");
    let s = "sess-goal";
    // the task and its judge run the same replay: both read .env; the answer is the judge's vote, quoting the value
    let answer = "NOT MET: the key sk-live-one is still the live one";
    let lines = [
        json!({ "type": "system", "subtype": "init", "session_id": s }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "cat .env" } }] } }),
        json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": [{ "type": "text", "text": "API_KEY=sk-live-one\nPORT=3000" }] }] } }),
        json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "text", "text": answer }] } }),
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": answer, "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01 }),
    ];
    std::fs::write(&f, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    let (_serve, port) = start_with(&dir, &[("FAKE_REPLAY", f.to_str().unwrap())]);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id =
        api.cmd("runtime.create", json!({ "prompt": "rotate the key", "cwd": proj, "agent": "claude", "worktree": false })).await["id"]
            .as_str()
            .unwrap()
            .to_owned();
    api.until(&id, "the turn to end", |t| t.last().is_some_and(ended)).await;
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "\"verdict\":\"not_yet\"", 60).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    api.cmd("goal.set", json!({ "id": id, "text": "a new key is live", "kick": true })).await;
    let seen = live.await.unwrap();
    assert!(seen.contains("\"verdict\":\"not_yet\""), "the judge voted: {}", &seen[seen.len().saturating_sub(800)..]);
    no_value("the live sync stream (goal_run)", &seen);
    let snap = stream(&http, port, &topic, "\"verdict\":\"not_yet\"", 10).await;
    assert!(snap.contains("\"verdict\":\"not_yet\""), "the check is in the snapshot");
    no_value("the sync snapshot (goal_run)", &snap);
    assert!(snap.contains(&format!("the key {DOTS} is still")), "masked, not dropped: {}", &snap[..snap.len().min(1200)]);
    no_value("runtime.get", &api.cmd("runtime.get", json!({ "id": id })).await.to_string());
    no_value("runtime.turns", &json!(api.turns(&id).await).to_string());
    no_value("a share", &api.cmd("share.preview", json!({ "id": id, "level": "full" })).await.to_string());
}

/// A task's watch (ADR-0054): the agent puts up a page beside its task quoting a value the task read (in its title,
/// its state and its HTML). The `watch` and `watch_page` rows on the task's topic, live, from a snapshot and from the
/// first snapshot after a restart (nothing in memory: by the ranges kept with them), carry `••••`, never the value,
/// and the page still draws.
#[tokio::test(flavor = "multi_thread")]
async fn a_watch_page_quoting_a_value_the_task_read_reaches_no_topic_live_or_after_a_restart() {
    let dir = temp("envwatch");
    let proj = dir.join("proj");
    std::fs::write(proj.join(".env"), "API_KEY=sk-live-one\nPORT=3000\n").unwrap();
    let f = replay(&dir, &proj);
    let env = [("FAKE_REPLAY", f.to_str().unwrap())];
    let (serve, port) = start_with(&dir, &env);
    let http = reqwest::Client::new();
    let api = Api { http: http.clone(), port, n: 0.into() };
    let id =
        api.cmd("runtime.create", json!({ "prompt": "rotate the key", "cwd": proj, "agent": "claude", "worktree": false })).await["id"]
            .as_str()
            .unwrap()
            .to_owned();
    api.until(&id, "the turn to end", |t| t.last().is_some_and(ended)).await;
    let topic = format!("session:{id}");
    let live = tokio::spawn({
        let (http, topic) = (http.clone(), topic.clone());
        async move { stream(&http, port, &topic, "old key", 60).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let said = api
        .cmd(
            "runtime.agent.watch",
            json!({ "session": id, "action": "open", "title": "Key sk-live-one", "caption": "rotating sk-live-one",
                    "html": "<p data-k=\"sk-live-one\">old key</p>", "state": { "key": "sk-live-one", "done": 1 } }),
        )
        .await;
    assert!(said["text"].is_string(), "the watch opened: {said}");
    let seen = live.await.unwrap();
    assert!(seen.contains("old key"), "the stream saw the page: {}", &seen[seen.len().saturating_sub(800)..]);
    no_value("the live sync stream (watch)", &seen);
    let snap = stream(&http, port, &topic, "old key", 10).await;
    assert!(snap.contains("old key"), "the page is in the snapshot");
    no_value("the sync snapshot (watch)", &snap);
    assert!(snap.contains(&format!("Key {DOTS}")), "masked, not dropped: {}", &snap[..snap.len().min(1200)]);
    no_value("runtime.get", &api.cmd("runtime.get", json!({ "id": id })).await.to_string());

    // after a restart: nothing in memory yet, the ranges kept with the rows mask them (not •••• whole)
    serve.stop();
    let (_serve, port) = start_with(&dir, &env);
    let snap = stream(&http, port, &topic, "old key", 20).await;
    assert!(snap.contains("old key"), "the page still draws after a restart: {}", &snap[..snap.len().min(1200)]);
    no_value("the first snapshot after a restart (watch)", &snap);
    assert!(snap.contains(&format!("Key {DOTS}")), "masked by its ranges: {}", &snap[..snap.len().min(1200)]);
}
