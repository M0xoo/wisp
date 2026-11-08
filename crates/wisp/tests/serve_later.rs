//! wisp.later in `wisp serve` (v1 test/later.test.js): a follow-up scheduled on a task shows on it,
//! Send now runs it as the task's next turn with the note the agent reads, and an agent's own
//! `resume_later` is answered as v1 did.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_follow_up_is_scheduled_sent_and_mirrored_on_its_task() {
    let dir = temp("serve-later");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let (_, task) = run_task(&api, &dir, "claude").await;
    let id = task["id"].as_str().unwrap().to_owned();
    let l = api.cmd("later.add", json!({ "sessionId": id, "text": "check the deploy", "in": 30 })).await;
    let item = l["id"].as_str().unwrap().to_owned();
    assert_eq!(l["by"], "user");
    let shown = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(shown["ext"]["wisp.later"]["later"][0]["text"], "check the deploy", "{shown}");
    // too soon, and an agent's wake-up with no offset, are refused as v1 did
    assert_ne!(api.try_cmd("later.add", json!({ "sessionId": id, "text": "x", "in": 0 })).await["ok"], true);
    let bad = api.cmd("later.agent.schedule", json!({ "session": id, "at": "2026-11-08T17:00:00", "message": "x" })).await;
    assert!(bad["error"].is_string(), "{bad}");
    let ok = api.cmd("later.agent.schedule", json!({ "session": id, "minutes": 10, "message": "see if CI passed" })).await;
    assert!(ok["text"].as_str().unwrap().starts_with("Scheduled (id "), "{ok}");
    assert_eq!(api.cmd("later.list", json!({ "sessionId": id })).await.as_array().unwrap().len(), 2);
    // Send now: it runs as the task's next turn, with the note the agent reads ahead of it
    api.cmd("later.edit", json!({ "sessionId": id, "item": item, "now": true })).await;
    let t = api.until(&id, "the follow-up runs", |t| t.len() == 2 && ended(&t[1])).await;
    assert!(t[1]["prompt"].as_str().unwrap().contains("check the deploy"), "{:?}", t[1]);
    assert!(t[1]["prompt"].as_str().unwrap().contains("(wisp: this is the follow-up the user scheduled"), "{:?}", t[1]);
    assert_eq!(t[1]["by"], "later");
    assert_eq!(api.cmd("later.list", json!({ "sessionId": id })).await.as_array().unwrap().len(), 1, "the sent one is gone");
    let next = api.cmd("later.nextAt", json!({})).await;
    assert!(next["at"].is_number(), "{next}");
    drop(serve);
}
