//! My Stuff against the real runtime (`wisp serve`, the fake `claude`): Save to My Stuff on a reply's file copies
//! the task's file (v1 routes/stuff.js `taskFile`), and a pane's scopes never widen while its task runs in Full
//! auto (v1 `runsFullAuto`). Both go through `stuff.task-files@1`, which wisp.runtime provides.
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
