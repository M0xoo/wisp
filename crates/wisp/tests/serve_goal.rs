//! Goals end to end on a real `wisp serve` with the fake agent (v1 server/goal.js, goal-runs.js, launch.js asGoal):
//! `/goal <condition>` as a whole prompt starts a task whose goal it is (from New task, the CLI, the phone alike);
//! each judge's check is kept as a `goal_run` row on the task's topic, with what wisp asked it and everything it
//! answered, so the checks popover opens it like a task; `goal.set` with `kick` on an idle task judges its last
//! answer at once; `/goal drop` before there's a task says where it works.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

/// Subscribes to `topic` on the sync stream and collects frames until `until` holds (15 s at most).
async fn stream(port: u16, client: &str, topic: &str, until: impl Fn(&str) -> bool) -> String {
    let http = reqwest::Client::new();
    let mut r =
        http.get(format!("http://127.0.0.1:{port}/api/events?proto_min=2&proto_max=2&client_id={client}&build=t")).send().await.unwrap();
    let (mut seen, at, mut subbed) = (String::new(), Instant::now(), false);
    while at.elapsed() < Duration::from_secs(15) {
        let Ok(Ok(Some(c))) = tokio::time::timeout(Duration::from_millis(300), r.chunk()).await else {
            if subbed && until(&seen) {
                break;
            }
            continue;
        };
        seen.push_str(&String::from_utf8_lossy(&c));
        if !subbed && seen.contains("welcome") {
            let ok = http
                .post(format!("http://127.0.0.1:{port}/api/events"))
                .header("content-type", "application/json")
                .header("x-wisp-client", client)
                .body(json!({ "t": "sub", "topic": topic }).to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(ok.status(), 200);
            subbed = true;
        }
        if subbed && until(&seen) {
            break;
        }
    }
    seen
}

/// The `goal_run` rows a sync stream carried (each frame's JSON, wherever the row sits in it).
fn runs_in(frames: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in frames.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim_start_matches("data:").trim()) else { continue };
        collect(&v, &mut out);
    }
    out
}

fn collect(v: &Value, out: &mut Vec<Value>) {
    match v {
        Value::Object(m)
            if m.get("e").and_then(Value::as_str) == Some("goal_run") || m.get("kind").and_then(Value::as_str) == Some("goal_run") =>
        {
            out.push(v.clone());
        }
        Value::Object(m) => m.values().for_each(|x| collect(x, out)),
        Value::Array(a) => a.iter().for_each(|x| collect(x, out)),
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_goal_typed_as_the_prompt_starts_it_and_each_check_is_kept_like_a_task() {
    let dir = temp("serve-goal-typed");
    let (_serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };

    let refused = api.try_cmd("runtime.create", json!({ "prompt": "/goal drop", "cwd": dir.join("proj"), "agent": "claude" })).await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["message"], "No goal to drop yet: /goal drop works in a task’s reply box.");

    let made = api
        .cmd("runtime.create", json!({ "prompt": "/goal a.txt says hello", "cwd": dir.join("proj"), "agent": "claude", "worktree": false }))
        .await;
    let id = made["id"].as_str().unwrap().to_owned();
    let spec = api.cmd("runtime.spec", json!({ "id": id })).await;
    assert_eq!(spec["goal"], "a.txt says hello", "the condition is the goal: {spec}");
    assert_eq!(spec["prompt"], "a.txt says hello", "and the task is to reach it: {spec}");

    // a check ran to its vote (live, as a change on the task's topic)
    let frames = stream(port, "g1", &format!("session:{id}"), |s| runs_in(s).iter().any(|r| r.to_string().contains("\"done\""))).await;
    assert!(runs_in(&frames).iter().any(|r| r.to_string().contains("\"done\"")), "a check ran to its vote: {frames}");
    // opened after it ran (Goal checks…): the whole record is in the topic's first look, beside the task window
    let done =
        |s: &str| runs_in(s).into_iter().find(|r| r.to_string().contains("\"status\":\"done\"") && r.to_string().contains("\"round\":1"));
    let later = stream(port, "g1-later", &format!("session:{id}"), |s| done(s).is_some()).await;
    let text = done(&later).unwrap_or_else(|| panic!("a finished check's record in the snapshot: {later}")).to_string();
    assert!(text.contains("Goal: a.txt says hello"), "what wisp asked it: {text}");
    assert!(text.contains("\"name\":\"claude\""), "which judge: {text}");
    assert!(text.contains("\"verdict\":\"met\"") || text.contains("\"verdict\":\"not_yet\""), "its vote: {text}");
    assert!(text.contains("\"text\":"), "everything it answered: {text}");
    // the band's checks name the record each vote opens
    let at = Instant::now();
    loop {
        let list = api.cmd("runtime.list", json!({})).await.to_string();
        if list.contains("\"votes\"") {
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(30), "the round's votes on the row: {list}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    api.cmd("goal.drop", json!({ "id": id })).await;
    let again = api.try_cmd("goal.drop", json!({ "id": id })).await;
    assert_eq!(again["error"]["message"], "This task has no goal to drop.", "{again}");
}

/// v1 Goals#set: `/goal …` typed after a task landed (kick) has its last answer judged at once.
#[tokio::test(flavor = "multi_thread")]
async fn a_goal_set_on_an_idle_task_is_checked_at_once() {
    let dir = temp("serve-goal-kick");
    let (_serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let made = api
        .cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": dir.join("proj"), "agent": "claude", "worktree": false }))
        .await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    api.cmd("goal.set", json!({ "id": id, "text": "add adds", "kick": true })).await;
    let frames = stream(port, "g2", &format!("session:{id}"), |s| !runs_in(s).is_empty()).await;
    assert!(runs_in(&frames).iter().any(|r| r.to_string().contains("Goal: add adds")), "judged now, not after another turn: {frames}");
}
