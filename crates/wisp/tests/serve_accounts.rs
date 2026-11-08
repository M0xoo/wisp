//! wisp.accounts in `wisp serve` (v1 test/accounts.test.js, harness-watch.test.js, agent-login.test.js):
//! a second Codex account signs in with the CLI's own device login and its runs get its folder; a
//! harness whose program changed holds its turn until trusted.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

async fn until(what: &str, mut f: impl AsyncFnMut() -> Option<Value>) -> Value {
    let at = Instant::now();
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(at.elapsed() < Duration::from_secs(30), "{what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_codex_account_signs_in_and_its_runs_use_its_folder() {
    let dir = temp("serve-accounts");
    let rec = dir.join("rec");
    std::fs::create_dir_all(dir.join("codex-home")).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let added = api.cmd("accounts.add", json!({ "agent": "codex", "id": "w1", "label": "Work", "kind": "work" })).await;
    assert_eq!(added["accounts"].as_array().unwrap().len(), 2, "{added}");
    assert_eq!(added["account"]["label"], "Work");
    // the CLI's own login: its link and code, then done (it signed in)
    let login = until("the sign-in finishes", async || {
        let v = api.cmd("accounts.login", json!({ "agent": "codex", "account": "w1" })).await;
        (v["state"] == "done").then_some(v)
    })
    .await;
    assert_eq!(login["url"], "https://auth.example.dev/codex/device", "{login}");
    assert_eq!(login["code"], "ABCD-12345");
    let st = api.cmd("accounts.login.status", json!({ "agent": "codex", "account": "w1" })).await;
    assert_eq!(st["signedIn"], true, "{st}");
    // a task on that account runs with its folder as CODEX_HOME
    let id = api.cmd("runtime.create", json!({ "prompt": "fix", "cwd": dir.join("proj"), "agent": "codex", "account": "w1" })).await["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.len() == 1 && ended(&t[0])).await;
    let runs: Vec<Value> = std::fs::read_to_string(rec.join("codex.jsonl")).unwrap().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let home = runs.iter().rev().find(|r| r["argv"][0] == "exec").map(|r| r["codexHome"].clone()).unwrap();
    assert!(home.as_str().unwrap().ends_with("accounts/codex/w1"), "{home}");
    // reorder and remove
    let up = api.cmd("accounts.update", json!({ "agent": "codex", "account": "w1", "move": "up" })).await;
    assert_eq!(up["accounts"][0]["id"], "w1");
    let gone = api.cmd("accounts.remove", json!({ "agent": "codex", "account": "w1" })).await;
    assert_eq!(gone["accounts"].as_array().unwrap().len(), 1, "only the CLI's own is left: {gone}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_harness_holds_its_turn_until_trusted() {
    let dir = temp("serve-watch");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    api.cmd("accounts.watch.ask", json!({ "on": true })).await;
    // the first run pins the program
    let (turn, _) = run_task(&api, &dir, "codex").await;
    assert_eq!(turn["status"], "done", "{turn}");
    assert!(api.cmd("accounts.watch", json!({ "agent": "codex" })).await["pinnedAt"].is_number());
    // another program where codex was: other bytes
    let bin = dir.join("bin").join(format!("codex{}", std::env::consts::EXE_SUFFIX));
    let mut bytes = std::fs::read(&bin).unwrap();
    std::fs::remove_file(&bin).unwrap();
    bytes.extend_from_slice(b"\0changed");
    std::fs::write(&bin, bytes).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let id = api.cmd("runtime.create", json!({ "prompt": "again", "cwd": dir.join("proj"), "agent": "codex" })).await["id"].as_str().unwrap().to_owned();
    let t = api.until(&id, "held", |t| t.len() == 1 && t[0]["status"] == "held").await;
    assert_eq!(t[0]["held"]["kind"], "harness-changed", "{:?}", t[0]);
    assert_eq!(api.cmd("accounts.watch", json!({ "agent": "codex" })).await["changed"]["kind"], "warn");
    // trusting it pins what's there now and the held turn runs
    let w = api.cmd("accounts.watch.trust", json!({ "agent": "codex" })).await;
    assert!(w["changed"].is_null(), "{w}");
    api.until(&id, "the held turn runs", |t| t.last().is_some_and(|x| x["status"] == "done")).await;
    drop(serve);
}
