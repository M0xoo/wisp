//! wisp.budget in `wisp serve` (v1 test/budget.test.js "Automations stop at"): unattended work on an
//! account past its stop line is held, the user's own run is not, and the held turn starts once a
//! reading says the window reset early.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::json;

fn git(dir: &std::path::Path, args: &[&str]) {
    let o = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

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

/// F-auto-12, a banked Codex reset lands early (v1 live-limits.js + app.resetEarly): with Check Codex while work waits
/// on, a crew job held past the stop line makes wisp read Codex's usage (the fake app-server); the read shows the
/// five-hour window reset hours before its time, so the held job and a task waiting at its limit (Wait for the reset)
/// both go now, not at the old reset, and the window says *Reset early*.
#[tokio::test(flavor = "multi_thread")]
async fn a_banked_codex_reset_that_lands_early_starts_the_waiting_work_at_once() {
    let dir = temp("serve-budget-early");
    let usage = dir.join("codex-usage.json");
    let (serve, port) = start_with(&dir, &[("FAKE_CODEX_USAGE", usage.to_str().unwrap()), ("WISP_BUDGET_TICK_MS", "300")]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let old = (now_ms() / 1000 + 3 * 3600) * 1000;
    api.cmd("settings.set", json!({ "key": "budget.liveLimits", "value": true })).await;
    api.cmd("budget.setStop", json!({ "key": "autoStopCodex", "value": "75" })).await;
    // a run reported 80% of the five-hour window, resetting in three hours: past the 75% line
    let report = json!({ "agent": "codex", "account": "default", "report": { "windows": [{ "id": "five_hour", "used": 0.8, "resetsAt": old, "ms": 18_000_000 }], "complete": true } });
    api.cmd("budget.record", report).await;
    assert_eq!(api.cmd("budget.hold", json!({ "agent": "codex", "account": "" })).await["window"], "five_hour");
    // a task of yours hit its limit and waits for that reset (Wait for the reset: later.waitAtLimit, as runtime asks)
    let (mine, task) = run_task(&api, &dir, "codex").await;
    assert_eq!(mine["status"], "done", "{mine}");
    let id = task["id"].as_str().unwrap().to_owned();
    let wait = api.cmd("later.waitAtLimit", json!({ "sessionId": id, "at": old, "agent": "codex" })).await;
    assert_eq!(wait["at"], old, "{wait}");
    // OpenAI banked a reset: Codex now says 2% used, the next reset five hours away
    let fresh = now_ms() / 1000 + 5 * 3600;
    std::fs::write(&usage, json!({ "primary": { "usedPercent": 2, "windowDurationMins": 300, "resetsAt": fresh } }).to_string()).unwrap();
    // a crew job is held on the plan; wisp reads Codex while it waits, sees the early reset, and both go
    let crew =
        api.cmd("runtime.create", json!({ "prompt": "nightly tidy", "cwd": dir.join("proj"), "agent": "codex", "by": "crew" })).await["id"]
            .as_str()
            .unwrap()
            .to_owned();
    let job = api.until(&crew, "the held job runs", |t| t.last().is_some_and(|x| x["status"] == "done")).await;
    let t = api.until(&id, "the waiting task carries on", |t| t.len() == 2 && ended(&t[1])).await;
    assert!(t[1]["prompt"].as_str().unwrap_or_default().contains("Carry on from where the last run stopped"), "{:?}", t[1]);
    assert_eq!(t[1]["status"], "done", "{:?}", t[1]);
    // the read happened (only waiting work makes it), saw the early reset, and the held job started after it
    let v = api.cmd("budget.view", json!({ "agent": "codex" })).await;
    let w = &v[0]["windows"][0];
    assert!((w["used"].as_f64().unwrap() - 0.02).abs() < 1e-9, "the read's numbers: {v}");
    let early = w["earlyAt"].as_i64().unwrap_or_else(|| panic!("Reset early: {v}"));
    assert!(job[0]["startedAt"].as_i64().unwrap() >= early, "held until the reset was seen: {:?} {v}", job[0]);
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

/// Plan budget past the bars, from real runs (v1 budget.js `where`, `compareAccounts`; F-acct-11, F-acct-14): the
/// task that ran between two readings is where the window went, by its title; and once two accounts each have five
/// finished turns on a model, their median turns are compared.
#[tokio::test(flavor = "multi_thread")]
async fn where_the_plan_went_and_tokens_per_turn_by_account_come_from_real_runs() {
    let dir = temp("serve-budget-where");
    std::fs::create_dir_all(dir.join("codex-home")).unwrap();
    // the CLI's own login is signed in (the fake reads auth.json), so runs named `default` stay there
    std::fs::write(dir.join("codex-home").join("auth.json"), "{}").unwrap();
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let resets = now_ms() + 3 * 24 * 3_600_000;
    let at = |used: f64| json!({ "agent": "codex", "account": "default", "report": { "windows": [{ "id": "seven_day", "used": used, "resetsAt": resets, "ms": 604_800_000 }], "complete": true } });
    api.cmd("budget.record", at(0.1)).await;
    let (turn, task) = run_task(&api, &dir, "codex").await;
    assert_eq!(turn["status"], "done", "{turn}");
    api.cmd("budget.record", at(0.3)).await;
    // the picker's cheap view has no Where it went; Settings → Usage asks for it named
    assert!(api.cmd("budget.view", json!({ "agent": "codex" })).await[0]["where"].is_null());
    let v = api.cmd("budget.view", json!({ "agent": "codex", "named": true })).await;
    let w = &v[0]["where"];
    assert_eq!(w["window"], "seven_day", "{v}");
    assert_eq!(w["tasks"][0]["id"], task["id"], "{w}");
    assert_eq!(w["tasks"][0]["title"], task["title"], "{w}");
    assert!((w["tasks"][0]["used"].as_f64().unwrap() - 0.2).abs() < 1e-6 && (w["used"].as_f64().unwrap() - 0.3).abs() < 1e-6, "{w}");
    // a second account, signed in with the CLI's own login; five runs on each
    api.cmd("accounts.add", json!({ "agent": "codex", "id": "w1", "label": "Work", "kind": "work" })).await;
    for _ in 0..100 {
        if api.cmd("accounts.login.status", json!({ "agent": "codex", "account": "w1" })).await["signedIn"] == true {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // each run names its account: one you start yourself without one may go to either (wisp.accounts' pick)
    for (i, account) in ["default", "default", "default", "default", "w1", "w1", "w1", "w1", "w1"].into_iter().enumerate() {
        let id = api
            .cmd("runtime.create", json!({ "prompt": format!("work {i}"), "cwd": dir.join("proj"), "agent": "codex", "account": account }))
            .await["id"]
            .as_str()
            .unwrap()
            .to_owned();
        api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    }
    let c = api.cmd("budget.compare", json!({ "agent": "codex" })).await;
    let accounts: Vec<&str> =
        c[0]["accounts"].as_array().unwrap_or_else(|| panic!("{c}")).iter().map(|x| x["account"].as_str().unwrap()).collect();
    assert_eq!(accounts.len(), 2, "{c}");
    assert!(accounts.contains(&"default") && accounts.contains(&"w1"), "{c}");
    assert!(c[0]["accounts"].as_array().unwrap().iter().all(|x| x["turns"].as_u64() >= Some(5) && x["output"].as_u64() > Some(0)), "{c}");
    drop(serve);
}

/// Ask near the limit for Try it two ways (v1 guard.js `together`, F-comp-31): the two runs go at once on one
/// account, so they are asked about as one. Three runs teach that a run takes ~10% of the five-hour window; at 75%
/// one run (→ 85%) goes without asking, but the pair (→ 95%) is past the 90% line: the trial is refused as a whole
/// (409, nothing ran, run A archived, never run B alone), and the same trial with `confirmLimit` runs both.
#[tokio::test(flavor = "multi_thread")]
async fn a_trial_asks_near_the_limit_for_both_runs_where_one_run_alone_would_go_v1_together() {
    let dir = temp("serve-budget-trial");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let rec = dir.join("rec");
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let resets = now_ms() + 3 * 3_600_000;
    let at = |used: f64| json!({ "agent": "claude", "account": "default", "report": { "windows": [{ "id": "five_hour", "used": used, "resetsAt": resets, "ms": 18_000_000 }], "complete": true } });
    api.cmd("budget.record", at(0.4)).await;
    for used in [0.5, 0.6, 0.7] {
        let (turn, _) = run_task(&api, &dir, "claude").await;
        assert_eq!(turn["status"], "done", "{turn}");
        api.cmd("budget.record", at(used)).await;
    }
    api.cmd("budget.record", at(0.75)).await;
    // one run alone: ~85%, under the line, no ask
    let (turn, _) = run_task(&api, &dir, "claude").await;
    assert_eq!(turn["status"], "done", "one run goes: {turn}");
    api.cmd("budget.record", at(0.75)).await;
    let ran = records(&rec.join("claude.jsonl")).len();
    let open = |v: serde_json::Value| v.as_array().map_or(0, Vec::len);
    let (shown, all) = (open(api.cmd("runtime.list", json!({ "archived": false })).await), open(api.cmd("runtime.list", json!({})).await));
    let task = json!({ "prompt": "fix it", "cwd": repo, "agent": "claude", "mode": "auto" });
    let no = api.try_cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "off" } })).await;
    let said = no["error"]["message"].as_str().map_or_else(|| no.to_string(), str::to_owned);
    assert!(said.contains("past your 90% line") && said.contains("confirmLimit"), "{no}");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(records(&rec.join("claude.jsonl")).len(), ran, "neither run ran");
    assert_eq!(open(api.cmd("runtime.list", json!({ "archived": false })).await), shown, "run A is archived");
    assert_eq!(open(api.cmd("runtime.list", json!({})).await), all + 1, "run A was made, run B never was");
    // you said yes: both go
    let mut yes = task.clone();
    yes["confirmLimit"] = json!(true);
    let made = api.cmd("runtime.trial", json!({ "task": yes, "vary": { "skills": "off" } })).await;
    let runs: Vec<String> = made["runs"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(runs.len(), 2, "{made}");
    for id in &runs {
        let t = api.until(id, "its run ends", |t| t.last().is_some_and(ended)).await;
        assert_eq!(t.last().unwrap()["status"], "done", "{t:?}");
    }
    drop(serve);
}
