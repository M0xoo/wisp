//! wisp.telemetry and wisp.posthog in `wisp serve` (ADR-0021): a task's run reaches a (fake) PostHog as
//! v1 sent it (`POST /batch/` with `{api_key, batch}`, `turn_started` and `turn_ended` with v1's keys),
//! and opting out sends nothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::doc_markdown, clippy::type_complexity)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

/// A PostHog stand-in: every request's path and JSON body.
fn fake_posthog() -> (u16, Arc<Mutex<Vec<(String, Value)>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap_or(0);
            let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
            let mut len = 0;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap_or(());
            g.lock().unwrap().push((path, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}");
        }
    });
    (port, got)
}

fn events(got: &Mutex<Vec<(String, Value)>>) -> Vec<Value> {
    got.lock().unwrap().iter().flat_map(|(_, b)| b["batch"].as_array().cloned().unwrap_or_default()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_reaches_posthog_and_opting_out_sends_nothing() {
    let (ph, got) = fake_posthog();
    let dir = temp("serve-telemetry");
    let host = format!("http://127.0.0.1:{ph}");
    let (serve, port) = start_with(
        &dir,
        &[
            ("WISP_POSTHOG_HOST", host.as_str()),
            ("WISP_POSTHOG_KEY", "phc_test"),
            ("CI", ""),
            ("DO_NOT_TRACK", ""),
            ("WISP_TELEMETRY", "1"),
        ],
    );
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    run_task(&api, &dir, "claude").await;
    let at = Instant::now();
    let names = loop {
        api.cmd("telemetry.flush", Value::Null).await;
        let names: Vec<String> = events(&got).iter().filter_map(|e| e["event"].as_str().map(str::to_owned)).collect();
        if names.iter().any(|n| n == "turn_ended") || at.elapsed() > Duration::from_secs(10) {
            break names;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        names.contains(&"turn_started".to_owned()) && names.contains(&"turn_ended".to_owned()),
        "{names:?} {}",
        std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default()
    );
    let (path, body) = got.lock().unwrap()[0].clone();
    assert_eq!((path.as_str(), body["api_key"].as_str()), ("/batch/", Some("phc_test")));
    let ended = events(&got).into_iter().find(|e| e["event"] == "turn_ended").unwrap();
    let p = &ended["properties"];
    for k in [
        "agent",
        "model",
        "mode",
        "effort",
        "followUp",
        "status",
        "blockCount",
        "blockTypes",
        "changedFiles",
        "distinct_id",
        "$lib",
        "version",
    ] {
        assert!(p.get(k).is_some(), "turn_ended carries {k}: {p}");
    }
    assert_eq!((p["agent"].as_str(), p["status"].as_str()), (Some("claude"), Some("done")));
    // opted out: a run sends nothing more
    api.cmd("telemetry.set", json!({ "on": false })).await;
    let before = events(&got).len();
    run_task(&api, &dir, "claude").await;
    api.cmd("telemetry.flush", Value::Null).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(events(&got).len(), before, "nothing after opting out");
    drop(serve);
}

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

/// v1's `try_two_ways` count (services/launch.js, test/try-two-ways.test.js "telemetry"): one event with no
/// properties of its own per trial that started (no prompt, path or agent leaves), none for a refused trial, and
/// nothing once stats are off.
#[tokio::test(flavor = "multi_thread")]
async fn a_trial_counts_one_try_two_ways_with_nothing_in_it_never_on_a_refusal_or_with_stats_off() {
    let (ph, got) = fake_posthog();
    let dir = temp("serve-telemetry-trial");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let host = format!("http://127.0.0.1:{ph}");
    let (serve, port) = start_with(
        &dir,
        &[
            ("WISP_POSTHOG_HOST", host.as_str()),
            ("WISP_POSTHOG_KEY", "phc_test"),
            ("CI", ""),
            ("DO_NOT_TRACK", ""),
            ("WISP_TELEMETRY", "1"),
        ],
    );
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let counts = |got: &Mutex<Vec<(String, Value)>>| events(got).into_iter().filter(|e| e["event"] == "try_two_ways").collect::<Vec<_>>();
    let flushed = || async {
        api.cmd("telemetry.flush", Value::Null).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    let task = json!({ "prompt": "fix the secret thing", "cwd": repo, "agent": "claude", "mode": "auto" });
    // refused before anything runs: no count
    let no = api.try_cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "on" } })).await;
    assert!(no["error"].is_object(), "{no}");
    let made = api.cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "off" } })).await;
    assert_eq!(made["runs"].as_array().map(Vec::len), Some(2), "{made}");
    let at = Instant::now();
    while counts(&got).is_empty() && at.elapsed() < Duration::from_secs(10) {
        flushed().await;
    }
    let seen = counts(&got);
    assert_eq!(seen.len(), 1, "one count per trial: {seen:?}");
    let text = seen[0].to_string();
    assert!(!text.contains("secret") && !text.contains(repo.to_str().unwrap()) && seen[0]["properties"].get("agent").is_none(), "{text}");
    // stats off: a trial sends nothing more
    api.cmd("telemetry.set", json!({ "on": false })).await;
    let again = api.cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "off" } })).await;
    assert_eq!(again["runs"].as_array().map(Vec::len), Some(2), "{again}");
    flushed().await;
    assert_eq!(counts(&got).len(), 1, "nothing after opting out");
    drop(serve);
}
