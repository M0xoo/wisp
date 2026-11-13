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
    // v1's numbers (test/budget.test.js "Automations stop at"): past the 75% stop line, under the 90% ask line, so the
    // user's own run meets neither the stop (it's theirs) nor Ask near the limit (v1 asks at 90%: that's its own test)
    api.cmd("budget.setStop", json!({ "key": "autoStopCodex", "value": "75" })).await;
    let window = |used: f64| json!({ "agent": "codex", "account": "default", "report": { "windows": [{ "id": "five_hour", "used": used, "resetsAt": now_ms() + 3_600_000, "ms": 18_000_000 }], "complete": true } });
    api.cmd("budget.record", window(0.8)).await;
    let hold = api.cmd("budget.hold", json!({ "agent": "codex", "account": "" })).await;
    assert_eq!(hold["window"], "five_hour", "{hold}");
    // a crew job waits for the plan
    let crew =
        api.cmd("runtime.create", json!({ "prompt": "nightly tidy", "cwd": dir.join("proj"), "agent": "codex", "by": "crew" })).await["id"]
            .as_str()
            .unwrap()
            .to_owned();
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

/// Ask near the limit end to end (v1 test/limit-hold.test.js): three claude runs teach what a run takes of the
/// five-hour window (each reported $0.01 while the window rose 10%); at 85% the next run would take it to ~95%, past
/// the 90% line. Your own run is refused with wisp's words, the same run with `confirmLimit` (the CLI's --yes) goes,
/// and a crew job is held as `ask` until the window resets.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_would_take_the_window_past_your_line_is_asked_about_and_a_yes_goes() {
    let dir = temp("serve-budget-ask");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let resets = now_ms() + 3 * 3_600_000;
    let at = |used: f64| json!({ "agent": "claude", "account": "default", "report": { "windows": [{ "id": "five_hour", "used": used, "resetsAt": resets, "ms": 18_000_000 }], "complete": true } });
    api.cmd("budget.record", at(0.5)).await;
    for used in [0.6, 0.7, 0.8] {
        let (turn, _) = run_task(&api, &dir, "claude").await;
        assert_eq!(turn["status"], "done", "{turn}");
        api.cmd("budget.record", at(used)).await;
    }
    api.cmd("budget.record", at(0.85)).await;
    let ask = json!({ "prompt": "one more TOPIC[More]", "cwd": dir.join("proj"), "agent": "claude" });
    // the task is made; its turn is refused with how to go ahead, and nothing ran
    let no = api.cmd("runtime.create", ask.clone()).await["id"].as_str().unwrap().to_owned();
    let t = api.until(&no, "the ask", |t| t.last().is_some_and(ended)).await;
    let said = t[0].to_string();
    assert!(said.contains("5-hour usage window is at 85%") && said.contains("past your 90% line"), "{said}");
    assert_ne!(t[0]["status"], "done", "{said}");
    // a yes: it goes, and the same window doesn't ask again below the next step
    let mut yes = ask.clone();
    yes["confirmLimit"] = json!(true);
    let id = api.cmd("runtime.create", yes).await["id"].as_str().unwrap().to_owned();
    let t = api.until(&id, "the yes runs", |t| t.last().is_some_and(ended)).await;
    assert_eq!(t.last().unwrap()["status"], "done", "{t:?}");
    // nobody's there to say yes to an automation: it waits for the reset
    api.cmd("budget.record", at(0.92)).await;
    let crew = api
        .cmd("runtime.create", json!({ "prompt": "nightly tidy", "cwd": dir.join("proj"), "agent": "claude", "by": "crew" }))
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let t = api.until(&crew, "held", |t| t.len() == 1 && t[0]["status"] == "held").await;
    assert_eq!((t[0]["held"]["by"].as_str(), t[0]["held"]["kind"].as_str()), (Some("wisp.budget"), Some("ask")), "{:?}", t[0]);
    drop(serve);
}
