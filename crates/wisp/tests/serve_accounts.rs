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
    let id = api.cmd("runtime.create", json!({ "prompt": "fix", "cwd": dir.join("proj"), "agent": "codex", "account": "w1" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    api.until(&id, "the turn ends", |t| t.len() == 1 && ended(&t[0])).await;
    let runs = common::records(&rec.join("codex.jsonl"));
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
    let id = api.cmd("runtime.create", json!({ "prompt": "again", "cwd": dir.join("proj"), "agent": "codex" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let t = api.until(&id, "held", |t| t.len() == 1 && t[0]["status"] == "held").await;
    assert_eq!(t[0]["held"]["kind"], "harness-changed", "{:?}", t[0]);
    assert_eq!(api.cmd("accounts.watch", json!({ "agent": "codex" })).await["changed"]["kind"], "warn");
    // trusting it pins what's there now and the held turn runs
    let w = api.cmd("accounts.watch.trust", json!({ "agent": "codex" })).await;
    assert!(w["changed"].is_null(), "{w}");
    api.until(&id, "the held turn runs", |t| t.last().is_some_and(|x| x["status"] == "done")).await;
    drop(serve);
}

/// opencode signs in with a key pasted into wisp: it goes where opencode keeps it, and only whether one
/// is saved comes back. Codex's usage windows are read from its app-server (nothing spent). The v1
/// routes answer as the commands do.
#[tokio::test(flavor = "multi_thread")]
async fn keys_limits_and_the_v1_routes() {
    let dir = temp("serve-keys");
    let data = dir.join("xdg");
    let (serve, port) = start_with(&dir, &[("XDG_DATA_HOME", data.to_str().unwrap())]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let v = api.cmd("accounts.keys", json!({ "agent": "opencode" })).await;
    assert_eq!(v["providers"].as_array().unwrap().len(), 2, "{v}");
    assert_eq!(v["providers"][0]["set"], false);
    let set = api.cmd("accounts.keys.set", json!({ "agent": "opencode", "provider": "opencode", "key": "sk-zen-1" })).await;
    assert_eq!(set["providers"][0]["set"], true, "{set}");
    assert!(!set.to_string().contains("sk-zen-1"), "never the key itself");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode/auth.json")).unwrap()).unwrap();
    assert_eq!(file["opencode"], json!({ "type": "api", "key": "sk-zen-1" }));
    let bad = api.try_cmd("accounts.keys.set", json!({ "agent": "opencode", "provider": "nope", "key": "k" })).await;
    assert_ne!(bad["ok"], true);
    let after = api.cmd("accounts.keys.remove", json!({ "agent": "opencode", "provider": "opencode" })).await;
    assert_eq!(after["providers"][0]["set"], false, "{after}");
    // Codex's windows, read without a turn
    let l = api.cmd("accounts.limits", json!({ "agent": "codex", "account": "" })).await;
    assert_eq!(l["rateLimits"]["primary"]["usedPercent"], 42, "{l}");
    // every harness detected again
    let all = api.cmd("accounts.recheck", Value::Null).await;
    assert!(all.as_array().is_some_and(|a| a.iter().any(|h| h["id"] == "opencode" && h["available"] == true)), "{all}");
    assert!(api.cmd("accounts.list", json!({ "agent": "codex" })).await["accounts"].is_array());
    drop(serve);
}

/// Re-check in Settings → Agents looks for harnesses again here and on every online computer (v1 POST /agents/recheck:
/// `machines.recheckAgents()` with this one's detect): a harness removed over there reads not found here after it.
#[tokio::test(flavor = "multi_thread")]
async fn recheck_finds_harnesses_again_on_every_online_machine() {
    let (da, db) = (temp("recheck-a"), temp("recheck-b"));
    let (sa, pa) = start(&da);
    let (sb, pb) = start(&db);
    let a = Arc::new(Api { http: reqwest::Client::new(), port: pa, n: 0.into() });
    let added = a.cmd("machines.add", json!({ "transport": "loopback", "address": "127.0.0.1", "port": pb, "name": "studio" })).await;
    let id = added["id"].as_str().unwrap().to_owned();
    let grok =
        |v: &Value| v["remote"]["agents"].as_array().and_then(|l| l.iter().find(|x| x["id"] == "grok")).map(|x| x["available"].clone());
    until("the peer comes online with grok", async || {
        let v = a.cmd("machines.get", json!({ "id": id })).await;
        (v["state"] == "online" && grok(&v) == Some(json!(true))).then_some(v)
    })
    .await;
    // grok goes from b; a's Re-check finds that over there, not only here
    std::fs::remove_file(db.join("bin").join(format!("grok{}", std::env::consts::EXE_SUFFIX))).unwrap();
    let here = a.cmd("accounts.recheck", Value::Null).await;
    assert!(
        here.as_array().is_some_and(|l| l.iter().any(|h| h["id"] == "grok" && h["available"] == true)),
        "a's own grok is still there: {here}"
    );
    // the other computer answers on its own row (Re-check never waits for it)
    until("b's grok is gone after a's Re-check", async || {
        let v = a.cmd("machines.get", json!({ "id": id })).await;
        (grok(&v) == Some(json!(false))).then_some(v)
    })
    .await;
    drop((sa, sb));
}

/// A run you start yourself skips an account at its limit (here the CLI's own login) and runs on the next one; the
/// turn says which, so its end, its usage reports and Plan budget count it there, not on the CLI's own login.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_moved_to_the_second_account_records_that_account_on_its_turn() {
    let dir = temp("serve-accounts-pick");
    std::fs::create_dir_all(dir.join("codex-home")).unwrap();
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    api.cmd("accounts.add", json!({ "agent": "codex", "id": "w1", "label": "Work", "kind": "work" })).await;
    until("w1 signs in", async || {
        let v = api.cmd("accounts.login.status", json!({ "agent": "codex", "account": "w1" })).await;
        (v["signedIn"] == true).then_some(v)
    })
    .await;
    let until_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
    api.cmd(
        "accounts.cool",
        json!({ "agent": "codex", "account": "default", "until": u64::try_from(until_ms).unwrap(), "why": "5-hour limit" }),
    )
    .await;
    let (turn, _) = run_task(&api, &dir, "codex").await;
    assert_eq!(turn["status"], "done", "{turn}");
    assert_eq!(turn["account"], "w1", "the turn ran on w1 and says so: {turn}");
    drop(serve);
}
