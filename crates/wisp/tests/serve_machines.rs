//! wisp.machines end to end: two `wisp serve` (two temp homes, two ports) on this computer. The
//! second is added as a peer of the first through the `loopback` transport (another wisp on this
//! computer, straight over 127.0.0.1: no ssh needed, and the same link the ssh transport runs over its
//! `-L` forward). The first then sees the second's tasks through the v2 sync stream, starts one there
//! through `machines.route` (the same idempotency key: a retry runs nothing twice), calls its API,
//! and hangs up.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

async fn until(api: &Api, what: &str, name: &str, args: Value, f: impl Fn(&Value) -> bool) -> Value {
    let at = Instant::now();
    loop {
        let v = api.cmd(name, args.clone()).await;
        if f(&v) {
            return v;
        }
        assert!(at.elapsed() < Duration::from_secs(60), "{what}: {v}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn has_task(rows: &Value, id: &str) -> bool {
    rows.as_array().is_some_and(|l| l.iter().any(|r| r["id"] == id))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_s_tasks_are_seen_and_started_from_another_wisp() {
    let (da, db) = (temp("machines-a"), temp("machines-b"));
    let (sa, pa) = start(&da);
    let (sb, pb) = start(&db);
    let a = Api { http: reqwest::Client::new(), port: pa, n: 0.into() };
    let b = Api { http: reqwest::Client::new(), port: pb, n: 0.into() };

    // a task on b before it is a peer: the first snapshot brings it
    let before = b.cmd("runtime.create", json!({ "prompt": "fix add TOPIC[Fix add]", "cwd": db.join("proj"), "agent": "claude" })).await;
    let before = before["id"].as_str().unwrap().to_owned();

    // anything off this computer is refused by the loopback transport
    let off = a.try_cmd("machines.add", json!({ "transport": "loopback", "address": "example.com", "port": pb })).await;
    assert_eq!(off["ok"], false, "{off}");

    let added = a.cmd("machines.add", json!({ "transport": "loopback", "address": "127.0.0.1", "port": pb, "name": "studio" })).await;
    let id = added["id"].as_str().unwrap().to_owned();
    assert_eq!((added["name"].as_str(), added["transport"].as_str()), (Some("studio"), Some("loopback")));
    let online = until(&a, "the peer comes online", "machines.get", json!({ "id": id }), |v| v["state"] == "online").await;
    assert!(online["peer"].is_string(), "its peer_id is learned from the welcome: {online}");
    assert!(online["steps"].as_array().unwrap().iter().all(|s| s["status"] == "done" || s["status"] == "warn"), "{online}");
    let agents = online["remote"]["agents"].as_array().unwrap();
    assert!(agents.iter().any(|x| x["id"] == "claude"), "its harnesses: {agents:?}");

    // b's task is on a, through the sync stream
    until(&a, "b's task is mirrored", "machines.sessions", json!({ "id": id }), |v| has_task(v, &before)).await;
    // a task made on b now arrives as a patch
    let later = b.cmd("runtime.create", json!({ "prompt": "second", "cwd": db.join("proj"), "agent": "claude" })).await;
    let later = later["id"].as_str().unwrap().to_owned();
    until(&a, "a new task on b arrives", "machines.sessions", json!({}), |v| has_task(v, &later)).await;

    // a starts a task on b: routed there with the client's key
    let args = json!({ "prompt": "routed TOPIC[Routed]", "cwd": db.join("proj"), "agent": "claude" });
    let routed = a.cmd("machines.route", json!({ "id": id, "cmd": "runtime.create", "args": args, "mid": "route-1" })).await;
    let rid = routed["id"].as_str().unwrap_or_else(|| panic!("the peer's answer: {routed}")).to_owned();
    assert_eq!(b.cmd("runtime.get", json!({ "id": rid })).await["id"], rid.as_str(), "it runs on b");
    // the same key again: the peer answers the first result and runs nothing new
    let again = a.cmd("machines.route", json!({ "id": id, "cmd": "runtime.create", "args": args, "mid": "route-1" })).await;
    assert_eq!(again["id"], rid.as_str(), "{again}");
    let on_b = b.cmd("runtime.list", json!({})).await;
    let n = on_b.as_array().or_else(|| on_b["sessions"].as_array()).map_or(0, Vec::len);
    assert_eq!(n, 3, "one routed task, not two: {on_b}");
    until(&a, "the routed task is mirrored", "machines.sessions", json!({ "id": id }), |v| has_task(v, &rid)).await;
    // a refusal over there comes back as the peer's error
    let bad = a.try_cmd("machines.route", json!({ "id": id, "cmd": "runtime.get", "args": { "id": "nope" }, "mid": "route-2" })).await;
    assert_eq!(bad["ok"], false, "{bad}");

    // a JSON call to b's API
    let h = a.cmd("machines.call", json!({ "id": id, "method": "GET", "path": "/health" })).await;
    assert_eq!(h["name"], "wisp", "{h}");

    // hung up by hand: it stays off, its last rows stay on screen
    let off = a.cmd("machines.disconnect", json!({ "id": id })).await;
    assert_eq!(off["state"], "off", "{off}");
    assert!(has_task(&a.cmd("machines.sessions", json!({ "id": id })).await, &before), "the last rows stay");
    let refused = a.try_cmd("machines.call", json!({ "id": id, "method": "GET", "path": "/health" })).await;
    assert_eq!(refused["ok"], false, "an offline peer takes no request: {refused}");

    // removed: it and its rows are gone
    let gone = a.cmd("machines.remove", json!({ "id": id })).await;
    assert_eq!(gone["removed"], json!([id]));
    assert_eq!(a.cmd("machines.list", json!({})).await, json!([]));
    assert_eq!(a.cmd("machines.sessions", json!({})).await, json!([]));
    drop((sa, sb));
}
