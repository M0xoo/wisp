//! The durable event log from outside the process (ADR-0044), end to end on `wisp serve`: lifecycle events
//! kept and listed, `wisp events tail|why|ls`, MCP `wisp_events` scoped to a capped agent's own task, a
//! signed webhook sink retried and paused, and the `events:*` topic resuming from a client's cursor.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines, clippy::many_single_char_names)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("NO_COLOR", "1")
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

async fn task(api: &Api, dir: &Path, prompt: &str) -> String {
    let made = api.cmd("runtime.create", json!({ "prompt": prompt, "cwd": dir.join("proj"), "agent": "claude", "worktree": false })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    id
}

async fn until_tail(api: &Api, args: Value, what: &str, f: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let at = Instant::now();
    loop {
        let v = api.cmd("events.tail", args.clone()).await;
        let list = v.as_array().cloned().unwrap_or_default();
        if f(&list) {
            return list;
        }
        assert!(at.elapsed() < Duration::from_secs(20), "{what}: {v}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_events_are_kept_and_read_from_outside() {
    let dir = temp("serve-events");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let id = task(&api, &dir, "fix the add bug").await;
    let list =
        until_tail(&api, json!({ "type": "turn.*", "subject": id }), "turn events", |l| l.iter().any(|e| e["type"] == "turn.finished"))
            .await;
    assert!(list.iter().all(|e| e["subject"] == json!(id) && e["seq"].as_u64().is_some()), "{list:?}");
    // the catalogue: every emitted type, durable ones marked
    let ls = api.cmd("events.ls", json!({})).await;
    let finished = ls.as_array().unwrap().iter().find(|e| e["type"] == "turn.finished").cloned().unwrap();
    assert_eq!((finished["durable"].clone(), finished["plugin"].clone()), (json!(true), json!("wisp.runtime")));
    assert!(ls.as_array().unwrap().iter().any(|e| e["type"] == "turn.activity" && e["durable"] == false), "stream events stay ephemeral");
    // the CLI
    let (code, out, err) = wisp(&dir, &["events", "tail", "--type", "turn.*"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("turn.finished") && out.contains(&id), "{out}");
    let seq = list.iter().find(|e| e["type"] == "turn.finished").unwrap()["seq"].as_u64().unwrap();
    let (code, out, _) = wisp(&dir, &["events", "why", &seq.to_string()]);
    assert!(code == 0 && out.contains("turn.finished"), "{out}");
    let (code, out, _) = wisp(&dir, &["events", "ls"]);
    assert!(code == 0 && out.contains("turn.finished") && out.contains("durable"), "{out}");
    drop(serve);
}

async fn mcp(http: &reqwest::Client, port: u16, headers: &[(&str, &str)], body: Value) -> Value {
    let mut r = http.post(format!("http://127.0.0.1:{port}/api/mcp")).header("content-type", "application/json");
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    serde_json::from_slice(&r.body(body.to_string()).send().await.unwrap().bytes().await.unwrap()).unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn capped_agent_sees_only_its_task_events_over_mcp() {
    let dir = temp("serve-events-mcp");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap()), ("FAKE_DELAY", "6000")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    // another task, finished: its events are in the log
    let made = api.cmd("runtime.create", json!({ "prompt": "first", "cwd": dir.join("proj"), "agent": "claude", "worktree": false })).await;
    let other = made["id"].as_str().unwrap().to_owned();
    api.until(&other, "it ends", |t| t.last().is_some_and(ended)).await;
    until_tail(&api, json!({ "subject": other }), "the first task's events", |l| !l.is_empty()).await;
    // a running task's agent, with its own token
    let _ = std::fs::remove_file(rec.join("claude.jsonl"));
    let made =
        api.cmd("runtime.create", json!({ "prompt": "second", "cwd": dir.join("proj"), "agent": "claude", "worktree": false })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let runs = common::until_records(&rec.join("claude.jsonl"), "the run's record", |r| {
        r.iter().any(|v| common::argv(v).iter().any(|a| a == "--mcp-config"))
    })
    .await;
    let argv = common::argv(runs.last().unwrap());
    let cfg: Value = serde_json::from_str(&argv[argv.iter().position(|a| a == "--mcp-config").unwrap() + 1]).unwrap();
    let token = cfg["mcpServers"]["wisp"]["headers"]["x-wisp-token"].as_str().unwrap().to_owned();
    let agent = [("x-wisp-token", token.as_str()), ("x-wisp-session", id.as_str())];
    let got = mcp(
        &api.http,
        port,
        &agent,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "wisp_events", "arguments": {} } }),
    )
    .await;
    let text = got.pointer("/result/content/0/text").and_then(Value::as_str).unwrap_or_else(|| panic!("{got}"));
    let seen: Value = serde_json::from_str(text).unwrap_or_else(|_| panic!("{got}"));
    assert!(seen.as_array().unwrap().iter().all(|e| e["subject"] == json!(id)), "only its own task: {seen}");
    assert!(!text.contains(&other), "{text}");
    // asking for another task's is refused
    let refused = mcp(&api.http, port, &agent, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "wisp_events", "arguments": { "subject": other } } })).await;
    assert!(refused.to_string().contains("its own task"), "{refused}");
    // the user sees both
    let all = api.cmd("events.tail", json!({})).await;
    assert!(all.to_string().contains(&other));
    drop(serve);
}

/// A webhook receiver: answers `fail` for the first requests, then 200; keeps what it got.
async fn receiver(fail_first: u32) -> (u16, Arc<Mutex<Vec<(String, String, String)>>>, Arc<AtomicU32>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let got = Arc::new(Mutex::new(Vec::new()));
    let hits = Arc::new(AtomicU32::new(0));
    let (g, h) = (got.clone(), hits.clone());
    let always = Arc::new(AtomicU32::new(fail_first));
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let (g, h, always) = (g.clone(), h.clone(), always.clone());
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= len {
                            let sig = head
                                .lines()
                                .find_map(|l| {
                                    l.split_once(':')
                                        .filter(|(k, _)| k.eq_ignore_ascii_case("x-wisp-signature"))
                                        .map(|(_, v)| v.trim().to_owned())
                                })
                                .unwrap_or_default();
                            let ty = head
                                .lines()
                                .find_map(|l| {
                                    l.split_once(':')
                                        .filter(|(k, _)| k.eq_ignore_ascii_case("x-wisp-event"))
                                        .map(|(_, v)| v.trim().to_owned())
                                })
                                .unwrap_or_default();
                            let n = h.fetch_add(1, Ordering::SeqCst);
                            let ok = n >= always.load(Ordering::SeqCst);
                            g.lock().unwrap().push((ty, sig, body[..len].to_owned()));
                            let status = if ok { "200 OK" } else { "500 Internal Server Error" };
                            let _ = s
                                .write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes())
                                .await;
                            break;
                        }
                    }
                }
            });
        }
    });
    (port, got, hits)
}

#[tokio::test(flavor = "multi_thread")]
async fn sink_webhook_signed_retried_with_backoff_and_paused_after_failures() {
    let dir = temp("serve-events-sink");
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::write(dir.join("home/secrets.json"), r#"{"wisp":{"HOOK_SECRET":"s3cr3t"}}"#).unwrap();
    let (rport, got, hits) = receiver(2).await;
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let sinks = json!([{ "name": "hook", "kind": "webhook", "url": format!("http://127.0.0.1:{rport}/in"), "match": "turn.finished", "secret": "HOOK_SECRET", "backoffMs": [50, 50], "pauseAfter": 1 }]);
    api.cmd("settings.set", json!({ "key": "events.sinks", "value": sinks })).await;
    task(&api, &dir, "one").await;
    // two 500s, then 200: retried with its backoff, delivered
    let at = Instant::now();
    while hits.load(Ordering::SeqCst) < 3 {
        assert!(at.elapsed() < Duration::from_secs(20), "tries: {}", hits.load(Ordering::SeqCst));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (ty, sig, body) = got.lock().unwrap()[2].clone();
    assert_eq!(ty, "turn.finished");
    // signed: sha256=HMAC(secret, body)
    let want = {
        use std::fmt::Write as _;
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(b"s3cr3t").unwrap();
        hmac::Mac::update(&mut mac, body.as_bytes());
        let out = hmac::Mac::finalize(mac).into_bytes();
        out.iter().fold("sha256=".to_owned(), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
    };
    assert_eq!(sig, want);
    let status = api.cmd("events.sinksStatus", json!({})).await;
    assert_eq!((status[0]["state"]["delivered"].clone(), status[0]["state"]["paused"].clone()), (json!(1), json!(false)), "{status}");
    // a receiver that's down: an event failing every try pauses the sink (pauseAfter 1), and nothing more goes
    drop(serve);
    let dir2 = temp("serve-events-sink2");
    std::fs::create_dir_all(dir2.join("home")).unwrap();
    std::fs::write(dir2.join("home/secrets.json"), r#"{"wisp":{"HOOK_SECRET":"s3cr3t"}}"#).unwrap();
    let (rport, _got, hits) = receiver(u32::MAX).await;
    let (serve, port) = start_with(&dir2, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let sinks = json!([{ "name": "hook", "kind": "webhook", "url": format!("http://127.0.0.1:{rport}/in"), "match": "turn.finished", "secret": "HOOK_SECRET", "backoffMs": [50], "pauseAfter": 1 }]);
    api.cmd("settings.set", json!({ "key": "events.sinks", "value": sinks })).await;
    task(&api, &dir2, "one").await;
    let at = Instant::now();
    loop {
        let s = api.cmd("events.sinksStatus", json!({})).await;
        if s[0]["state"]["paused"] == true {
            assert!(s[0]["state"]["lastError"].as_str().unwrap().contains("500"), "{s}");
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(20), "{s}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let tried = hits.load(Ordering::SeqCst);
    assert_eq!(tried, 2, "one try and one retry");
    task(&api, &dir2, "two").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(hits.load(Ordering::SeqCst), tried, "paused: nothing more is sent");
    api.cmd("events.resume", json!({ "name": "hook" })).await;
    drop(serve);
}

/// Opens the sync stream, subscribes to `topic` (from `since`), and collects frames for a while.
async fn stream(port: u16, client: &str, topic: &str, since: Option<u64>, until: impl Fn(&str) -> bool) -> String {
    let http = reqwest::Client::new();
    let mut r =
        http.get(format!("http://127.0.0.1:{port}/api/events?proto_min=2&proto_max=2&client_id={client}&build=t")).send().await.unwrap();
    let mut seen = String::new();
    let at = Instant::now();
    let mut subbed = false;
    while at.elapsed() < Duration::from_secs(15) {
        let Ok(Ok(Some(c))) = tokio::time::timeout(Duration::from_millis(300), r.chunk()).await else {
            if subbed && until(&seen) {
                break;
            }
            continue;
        };
        seen.push_str(&String::from_utf8_lossy(&c));
        if !subbed && seen.contains("welcome") {
            let mut sub = json!({ "t": "sub", "topic": topic });
            if let Some(s) = since {
                sub["since"] = json!(s);
            }
            let ok = http
                .post(format!("http://127.0.0.1:{port}/api/events"))
                .header("content-type", "application/json")
                .header("x-wisp-client", client)
                .body(sub.to_string())
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

#[tokio::test(flavor = "multi_thread")]
async fn topic_events_resumes_from_client_cursor() {
    let dir = temp("serve-events-topic");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let first = task(&api, &dir, "first").await;
    until_tail(&api, json!({ "subject": first, "type": "turn.finished" }), "kept", |l| !l.is_empty()).await;
    // a client's first look: a snapshot of the topic, and its cursor
    let snap = stream(port, "c1", "events:turn.*", None, |s| s.contains("\"snapshot\"") && s.contains(&first)).await;
    let cursor: u64 = snap
        .split("\"seq\":")
        .nth(1)
        .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("{snap}"));
    let second = task(&api, &dir, "second").await;
    until_tail(&api, json!({ "subject": second, "type": "turn.finished" }), "kept", |l| !l.is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // the same client again, from its cursor: only what's new
    let again = stream(port, "c1", "events:turn.*", Some(cursor), |s| s.contains(&second)).await;
    assert!(again.contains(&second), "{again}");
    assert!(!again.contains(&first), "resumed, not re-sent: {again}");
    drop(serve);
}

/// Projects reach every screen (round 17): a project applied as a resource is a `project` row on `config`, the topic
/// every screen watches, in the first snapshot (read in full, so the change feed's retention can't drop it) and
/// after a restart, as `{id: name, body: {path, …}}`.
#[tokio::test(flavor = "multi_thread")]
async fn a_project_reaches_every_screen_on_config_and_after_a_restart() {
    let dir = temp("serve-events-projects");
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let path = dir.join("proj").display().to_string();
    api.cmd(
        "resources.apply",
        json!({ "resources": [{ "kind": "project", "name": "web", "spec": { "path": path, "color": "teal" } }], "trust": true }),
    )
    .await;
    let snap = stream(port, "c1", "config", None, |s| s.contains("\"snapshot\"") && s.contains("\"web\"")).await;
    assert!(snap.contains("\"e\":\"project\"") && snap.contains("\"id\":\"web\"") && snap.contains("teal"), "{snap}");
    serve.stop();
    let (serve, port) = start_with(&dir, &[]);
    let snap = stream(port, "c2", "config", None, |s| s.contains("\"snapshot\"") && s.contains("\"web\"")).await;
    assert!(snap.contains("\"e\":\"project\"") && snap.contains(&path), "after a restart: {snap}");
    drop(serve);
}
