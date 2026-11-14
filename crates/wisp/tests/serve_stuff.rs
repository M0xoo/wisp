//! My Stuff against the real runtime (`wisp serve`, the fake `claude`): Save to My Stuff on a reply's file copies
//! the task's file (v1 routes/stuff.js `taskFile`), and a pane's scopes never widen while its task runs in Full
//! auto (v1 `runsFullAuto`). Both go through `stuff.task-files@1`, which wisp.runtime provides. A pane granted
//! `tasks:write` only proposes, loses the write when its code changes, and can't gain it in Full auto (F-stuff-8).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn save_to_my_stuff_copies_a_replys_file_from_its_task_and_nothing_outside_its_folder() {
    let dir = temp("serve-stuff-file");
    std::fs::write(dir.join("secret.txt"), "not the task's").unwrap();
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let (_, task) = run_task(&api, &dir, "claude").await;
    let id = task["id"].as_str().unwrap().to_owned();
    let from = |key: &str| json!({ "session": id, "turn": "t1", "key": key });

    // a file of the task, named as the reply names it (relative to its folder): copied, with the task's title
    let saved = api.cmd("stuff.save", json!({ "file": "math.js", "from": from("k-math") })).await;
    assert_eq!(saved["kind"], "code", "{saved}");
    assert_eq!(saved["name"], "math.js");
    assert_eq!(saved["from"]["title"], task["title"], "the task's title as it is, not the page's");
    // the same button again finds the one already kept
    let again = api.cmd("stuff.save", json!({ "file": "math.js", "from": from("k-math") })).await;
    assert_eq!(again["id"], saved["id"]);

    // outside the folder, or gone: nothing of this computer goes
    let out = api.try_cmd("stuff.save", json!({ "file": "../secret.txt", "from": from("k-out") })).await;
    assert_eq!(out["ok"], false, "{out}");
    assert!(out.to_string().contains("That file is gone"), "{out}");
    let abs = dir.join("secret.txt").display().to_string();
    let out = api.try_cmd("stuff.save", json!({ "file": abs, "from": from("k-abs") })).await;
    assert_eq!(out["ok"], false, "an absolute path out of the folder, too: {out}");
    // a task that isn't here
    let none = api.try_cmd("stuff.save", json!({ "file": "math.js", "from": { "session": "nope", "key": "k-none" } })).await;
    assert!(none.to_string().contains("isn’t on this computer"), "{none}");
    assert_eq!(api.cmd("stuff.list", json!({})).await.as_array().map(Vec::len), Some(1));
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_panes_grant_never_widens_while_its_task_runs_in_full_auto_v1_runs_full_auto() {
    let dir = temp("serve-stuff-auto");
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "4000")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let board = api.cmd("stuff.addStarter", json!({ "id": "agent-board" })).await;
    let app = board["id"].as_str().unwrap().to_owned();
    let made = api.cmd("runtime.create", json!({ "prompt": "work", "cwd": dir.join("proj"), "agent": "claude", "mode": "auto" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;

    let refused = api.try_cmd("stuff.allow", json!({ "id": app, "uses": ["tasks:read"], "task": id })).await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused.to_string().contains("runs in Full auto."), "{refused}");

    // the turn over, you're reading cards again: it's allowed
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let allowed = api.cmd("stuff.allow", json!({ "id": app, "uses": ["tasks:read"], "task": id })).await;
    assert_eq!(allowed["allowed"], json!(["tasks:read"]), "{allowed}");
    drop(serve);
}

/// An app folder that asks for `tasks:write`, with `page` as its index.html.
fn board_app(dir: &std::path::Path, name: &str, page: &str) -> String {
    let app = dir.join(name);
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("wisp-app.json"), r#"{ "name": "Board", "uses": ["tasks:read", "tasks:write"] }"#).unwrap();
    std::fs::write(app.join("index.html"), page).unwrap();
    app.display().to_string()
}

/// A POST from the pane's own page (its Origin), as its script would make it.
async fn from_pane(api: &Api, origin: &str, path: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
    let r = api
        .http
        .post(format!("http://127.0.0.1:{}{path}", api.port))
        .header("content-type", "application/json")
        .header("origin", origin)
        .header("idempotency-key", format!("pane-{path}-{}", api.n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), serde_json::from_slice(&r.bytes().await.unwrap()).unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pane_with_tasks_write_only_proposes_loses_it_when_its_code_changes_and_cant_regain_it_in_full_auto_f_stuff_8() {
    let dir = temp("serve-stuff-pane");
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "4000")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let v1 = board_app(&dir, "board-v1", "<!doctype html><title>Board</title>");
    let it = api.cmd("stuff.save", json!({ "app": v1 })).await;
    let app = it["id"].as_str().unwrap().to_owned();
    let both = json!(["tasks:read", "tasks:write"]);
    assert_eq!(api.cmd("stuff.allow", json!({ "id": app, "uses": both })).await["allowed"], both);
    assert_eq!(api.cmd("stuff.grant", json!({ "id": app })).await, json!({ "allowed": both, "changed": false }));

    // (a) propose only: its page, on its own port, can't start or send a task, nor widen its grant, over the
    // command path or MCP; wisp's page (no foreign Origin) is where its card's prompt goes out, sent by you
    let url = api.cmd("stuff.launch", json!({ "id": app })).await["url"].as_str().unwrap().trim_end_matches('/').to_owned();
    let proj = dir.join("proj");
    let tries = [
        ("/api/cmd", json!({ "cmd": "runtime.create", "args": { "prompt": "x", "cwd": proj, "agent": "claude" } })),
        ("/api/cmd", json!({ "cmd": "runtime.followUp", "args": { "id": "any", "text": "x" } })),
        ("/api/cmd", json!({ "cmd": "stuff.allow", "args": { "id": app, "uses": both } })),
        (
            "/api/mcp",
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "wisp_launch", "arguments": { "prompt": "x" } } }),
        ),
    ];
    for (path, body) in tries {
        let (status, r) = from_pane(&api, &url, path, body.clone()).await;
        assert_eq!((status, r["code"].as_str()), (403, Some("forbidden")), "{path} {body}: {r}");
        assert!(r["message"].as_str().unwrap_or_default().contains("A pane can only propose a prompt"), "{r}");
    }
    let listed = api.cmd("runtime.list", json!({})).await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0), "nothing started from the pane: {listed}");
    // (b) its code changes: the write is off at once (reads aren't tied to the code, v1), nothing is deleted
    let v2 = board_app(&dir, "board-v2", "<!doctype html><title>Board</title><script>wisp.tasks.launch({prompt:'more'})</script>");
    let same = api.cmd("stuff.save", json!({ "app": v2, "replace": app })).await;
    assert_eq!(same["id"], app.as_str());
    let changed = json!({ "allowed": ["tasks:read"], "changed": true });
    assert_eq!(api.cmd("stuff.grant", json!({ "id": app })).await, changed);
    let row = api.cmd("stuff.get", json!({ "id": app })).await;
    assert_eq!(row["allowed"], both, "stored as allowed, so the old code gets it back: {row}");
    let back = api.cmd("stuff.restore", json!({ "id": app })).await;
    assert_eq!(back["id"], app.as_str());
    assert_eq!(
        api.cmd("stuff.grant", json!({ "id": app })).await,
        json!({ "allowed": both, "changed": false }),
        "the code it was allowed on"
    );
    api.cmd("stuff.save", json!({ "app": v2, "replace": app })).await;
    assert_eq!(api.cmd("stuff.grant", json!({ "id": app })).await, changed);

    // (c) the card's Send, your own call, starts a Full auto task; only three calls while its turn runs
    // (FAKE_DELAY), so a slow machine can't end it first
    let made = api.cmd("runtime.create", json!({ "prompt": "work", "cwd": proj, "agent": "claude", "mode": "auto" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;

    // asking again while the task it's shown on runs in Full auto: refused, it stays off
    let refused = api.try_cmd("stuff.allow", json!({ "id": app, "uses": both, "task": id })).await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused.to_string().contains("runs in Full auto."), "{refused}");
    assert_eq!(api.cmd("stuff.grant", json!({ "id": app })).await, changed);
    // narrowing always works, even then
    assert_eq!(api.cmd("stuff.allow", json!({ "id": app, "uses": ["tasks:read"], "task": id })).await["allowed"], json!(["tasks:read"]));

    // the turn over: you allow it again, tied to the code it has now
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    api.cmd("stuff.allow", json!({ "id": app, "uses": both, "task": id })).await;
    assert_eq!(api.cmd("stuff.grant", json!({ "id": app })).await, json!({ "allowed": both, "changed": false }));
    drop(serve);
}
