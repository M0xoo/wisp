//! The `channel` and `notification` kinds act (ADR-0028), end to end on a real `wisp serve` with the
//! fake agent and a fake ntfy server: nothing is sent while no channel is on; with an ntfy channel and
//! two notifications a finished task reaches the topic (with a signed Done button) and a webhook; and a
//! tap on that button, read back from `<topic>-reply`, marks the task done.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

#[derive(Default)]
struct Fake {
    /// (method, path, body) of every request
    got: Mutex<Vec<(String, String, String)>>,
    /// the next poll's answer: a tap
    tap: Mutex<Option<String>>,
}

/// A tiny ntfy: POST / and /hook are recorded; GET <topic>-reply/json answers a queued tap once.
fn fake_ntfy() -> (u16, Arc<Fake>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let fake = Arc::new(Fake::default());
    let f = fake.clone();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            if r.read_line(&mut line).is_err() {
                continue;
            }
            let mut parts = line.split_whitespace();
            let (method, path) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
            let mut len = 0;
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; len];
            let _ = r.read_exact(&mut body);
            let body = String::from_utf8_lossy(&body).into_owned();
            let answer = if method == "GET" { f.tap.lock().unwrap().take().unwrap_or_default() } else { "{}".into() };
            f.got.lock().unwrap().push((method, path, body));
            let mut s = s;
            let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
        }
    });
    (port, fake)
}

fn posts(f: &Fake, path: &str) -> Vec<Value> {
    f.got.lock().unwrap().iter().filter(|(m, p, _)| m == "POST" && p == path).filter_map(|(_, _, b)| serde_json::from_str(b).ok()).collect()
}

async fn wait_for(what: &str, f: impl Fn() -> bool) {
    let at = Instant::now();
    while !f() {
        assert!(at.elapsed() < Duration::from_secs(30), "{what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ntfy_channel_and_a_webhook_hear_a_finished_task_and_a_tap_marks_it_done() {
    let dir = temp("serve-channels");
    let (np, fake) = fake_ntfy();
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };

    // off by default: a task finishes and nothing is sent
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": dir.join("proj"), "agent": "claude" })).await;
    api.until(made["id"].as_str().unwrap(), "the turn ends", |t| t.last().is_some_and(ended)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(fake.got.lock().unwrap().is_empty(), "nothing goes out with no channel on");

    let server = format!("http://127.0.0.1:{np}");
    let r = api
        .try_cmd(
            "resources.apply",
            json!({ "resources": [
                { "kind": "channel", "name": "phone", "spec": { "transport": "ntfy", "enabled": true, "routing": { "server": server, "topic": "wisp-test" } } },
                { "kind": "notification", "name": "done", "spec": { "on": ["finished"], "to": "phone" } },
                { "kind": "notification", "name": "hook", "spec": { "on": ["finished", "failed"], "to": format!("{server}/hook") } }
            ] }),
        )
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let view = api.cmd("channels.view", json!({})).await;
    assert_eq!(view["channels"][0]["running"], true, "{view}");
    wait_for("it polls the reply topic", || fake.got.lock().unwrap().iter().any(|(m, p, _)| m == "GET" && p.starts_with("/wisp-test-reply/json?poll=1"))).await;

    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug TOPIC[Fix add]", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    wait_for("the topic and the webhook hear it", || !posts(&fake, "/").is_empty() && !posts(&fake, "/hook").is_empty()).await;
    let note = posts(&fake, "/").pop().unwrap();
    assert_eq!(note["topic"], "wisp-test");
    assert!(note["title"].as_str().unwrap().starts_with('✓'), "{note}");
    let hook = posts(&fake, "/hook").pop().unwrap();
    assert_eq!((hook["event"].clone(), hook["session"]["id"].clone()), (json!("finished"), json!(id)), "{hook}");

    // the Done button: what the ntfy app posts back, read by the next poll
    let button = &note["actions"][0];
    assert_eq!(button["label"], "Done", "{note}");
    let tap = button["body"].as_str().unwrap().to_owned();
    *fake.tap.lock().unwrap() = Some(format!("{}\n", json!({ "id": "m1", "event": "message", "time": 1, "message": tap })));
    let at = Instant::now();
    while api.cmd("runtime.get", json!({ "id": id })).await["state"] != "done" {
        assert!(at.elapsed() < Duration::from_secs(30), "the tap marks it done");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // a forged tap does nothing
    let other = api.cmd("runtime.create", json!({ "prompt": "again", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let oid = other["id"].as_str().unwrap().to_owned();
    api.until(&oid, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let forged = json!({ "s": oid, "k": "d", "r": "x", "i": 0, "sig": "nope" }).to_string();
    *fake.tap.lock().unwrap() = Some(format!("{}\n", json!({ "id": "m2", "event": "message", "time": 2, "message": forged })));
    wait_for("the forged tap is read", || fake.tap.lock().unwrap().is_none()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_ne!(api.cmd("runtime.get", json!({ "id": oid })).await["state"], "done", "not signed by wisp: ignored");
    drop(serve);
}

/// A task started from a channel (here a message the grid routed to this computer) runs in the project it names;
/// one that names none runs where v1 ran it (remote.js `defaultProject`): the project picked in `channels.project`,
/// else the last used (the newest task's), else the first. A pick that no longer exists falls through.
#[tokio::test(flavor = "multi_thread")]
async fn a_channel_task_lands_in_the_project_it_names_else_the_picked_else_the_last_used_else_the_first() {
    let dir = temp("serve-channels-project");
    let (api_dir, web_dir) = (dir.join("api"), dir.join("web"));
    std::fs::create_dir_all(&api_dir).unwrap();
    std::fs::create_dir_all(&web_dir).unwrap();
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let applied = api
        .try_cmd(
            "resources.apply",
            json!({ "resources": [
                { "kind": "project", "name": "api", "spec": { "path": api_dir } },
                { "kind": "project", "name": "web", "spec": { "path": web_dir } }
            ], "trust": true }),
        )
        .await;
    assert_eq!(applied["ok"], true, "{applied}");
    let exported = api.cmd("resources.export", json!({ "kinds": ["project"] })).await;
    let path = |name: &str| exported.as_array().unwrap().iter().find(|r| r["name"] == name).unwrap()["spec"]["path"].clone();
    let first = exported[0]["name"].as_str().unwrap().to_owned();
    let other = if first == "api" { "web" } else { "api" };
    api.cmd("settings.set", json!({ "key": "channels.acceptChannels", "value": true })).await;

    let tasks = || async { api.cmd("runtime.list", json!({})).await.as_array().unwrap().iter().map(|t| (t["prompt"].as_str().or(t["title"].as_str()).unwrap_or("").to_lowercase(), t["cwd"].clone())).collect::<Vec<_>>() };
    // one message, then where its task runs (the next is sent once it has started, so "last used" is this one)
    let n = std::sync::atomic::AtomicUsize::new(0);
    let send = |text: &'static str| {
        let (api, tasks, n) = (&api, &tasks, &n);
        async move {
            let k = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let said = api.cmd("channels.routed", json!({ "channel": "slack", "name": "Ada", "sender": "u1", "text": text, "thread": format!("t{k}") })).await;
            assert_eq!(said["status"], 200, "{said}");
            let at = Instant::now();
            loop {
                let t = tasks().await;
                if t.len() >= k {
                    let words = text.split(' ').next_back().unwrap();
                    tokio::time::sleep(Duration::from_millis(20)).await; // the next task starts in a later millisecond
                    break t.iter().find(|(p, _)| p.contains(words)).unwrap_or_else(|| panic!("{text}: {t:?}")).1.clone();
                }
                assert!(at.elapsed() < Duration::from_secs(30), "{text} starts: {t:?} {said}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    };
    assert_eq!(send("tidy the readme").await, path(&first), "no task yet, nothing picked: the first project ({first})");
    let named = if other == "web" { "in web fix the add bug" } else { "in api fix the add bug" };
    assert_eq!(send(named).await, path(other), "the project the message names");
    assert_eq!(send("write the changelog").await, path(other), "none named: the last used ({other})");
    api.cmd("settings.set", json!({ "key": "channels.project", "value": first })).await;
    assert_eq!(send("bump the deps").await, path(&first), "none named: the one picked in the channels' settings");
    api.cmd("settings.set", json!({ "key": "channels.project", "value": "gone" })).await;
    assert_eq!(send("rename the flag").await, path(&first), "a picked project that's gone: the last used again");
    drop(serve);
}
