//! wisp.budget in `wisp serve` (v1 test/budget.test.js "Automations stop at"): unattended work on an
//! account past its stop line is held, the user's own run is not, and the held turn starts once a
//! reading says the window reset early.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::json;

fn now_ms() -> i64 {
    i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn unattended_work_past_the_stop_line_is_held_until_the_window_resets() {
    let dir = temp("serve-budget");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    api.cmd("budget.setStop", json!({ "key": "autoStopCodex", "value": "50" })).await;
    let window = |used: f64| json!({ "agent": "codex", "account": "default", "report": { "windows": [{ "id": "five_hour", "used": used, "resetsAt": now_ms() + 3_600_000, "ms": 18_000_000 }], "complete": true } });
    api.cmd("budget.record", window(0.9)).await;
    let hold = api.cmd("budget.hold", json!({ "agent": "codex", "account": "" })).await;
    assert_eq!(hold["window"], "five_hour", "{hold}");
    // a crew job waits for the plan
    let crew = api.cmd("runtime.create", json!({ "prompt": "nightly tidy", "cwd": dir.join("proj"), "agent": "codex", "by": "crew" })).await["id"].as_str().unwrap().to_owned();
    let t = api.until(&crew, "held", |t| t.len() == 1 && t[0]["status"] == "held").await;
    assert_eq!(t[0]["held"]["kind"], "plan", "{:?}", t[0]);
    assert_eq!(t[0]["held"]["by"], "wisp.budget");
    // the user's own run is never held
    let (mine, _) = run_task(&api, &dir, "codex").await;
    assert_eq!(mine["status"], "done", "{mine}");
    // the window reset early: the held job starts
    api.cmd("budget.record", window(0.05)).await;
    let t = api.until(&crew, "the held job runs", |t| t.last().is_some_and(|x| x["status"] == "done")).await;
    assert_eq!(t.last().unwrap()["status"], "done");
    drop(serve);
}
