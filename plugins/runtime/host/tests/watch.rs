//! Watch through the host (v1 server/watch.js, F-page-32): `wisp_watch` writes the task's watch and its page in one
//! transaction with the row's marker; a state never writes the page again; a page from a file is read from disk.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::rig;
use serde_json::{Value, json};
use wisp_runtime_api::commands::{AgentWatchArgs, StartArgs};

fn call(session: &str, body: Value) -> AgentWatchArgs {
    let Value::Object(body) = body else { panic!("a call is an object") };
    AgentWatchArgs { session: session.to_owned(), body }
}

fn body(store: &wisp_store::Store, kind: &str, id: &str) -> Option<Value> {
    store.read(|r| Ok(r.get(kind, id)?.and_then(|row| row.get("body").cloned()))).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_watch_opens_beside_its_task_and_a_state_leaves_the_page_alone_v1_watch_host() {
    let r = rig().await;
    let dir = std::env::temp_dir().join(format!("wisp-watch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("watch.html"), "<h1>from a file</h1>").unwrap();
    let id = r.rt.create(StartArgs { prompt: "migrate".into(), cwd: Some(dir.display().to_string()), hold: true, ..StartArgs::default() }).await.unwrap().id;
    let sid = id.0;

    // before open: the agent is told what to do
    let no = r.rt.agent_watch(call(&sid, json!({ "action": "state", "state": 1 }))).await.unwrap_err();
    assert!(no.contains("open\" first"), "{no}");

    let said = r.rt.agent_watch(call(&sid, json!({ "action": "open", "title": "Migration", "html": "<p>0 of 9</p>", "state": { "done": 0 } }))).await.unwrap();
    assert!(said.starts_with("Opened “Migration”"), "{said}");
    assert_eq!(body(&r.store, "watch_page", &sid).unwrap()["html"], "<p>0 of 9</p>");
    // the row's marker (the summary field `watch` reads it), written with the watch
    let marker = |s: &wisp_runtime_api::model::Session| s.ext["wisp.runtime"]["watch"].clone();
    assert_eq!(marker(&r.rt.get(&sid).await.unwrap()), json!({ "title": "Migration", "caption": "", "seq": 1, "rev": 1, "opened": 1 }));

    // a state: the watch moves, the page row is not written again
    std::fs::remove_file(dir.join("watch.html")).ok();
    r.rt.agent_watch(call(&sid, json!({ "action": "state", "state": { "done": 3 }, "merge": true }))).await.unwrap();
    let w = body(&r.store, "watch", &sid).unwrap();
    assert_eq!((w["seq"].as_u64(), w["rev"].as_u64(), w["state"].clone()), (Some(2), Some(1), json!({ "done": 3 })));
    assert_eq!(body(&r.store, "watch_page", &sid).unwrap()["html"], "<p>0 of 9</p>");

    // a page from a file the agent wrote, relative to the task's folder
    std::fs::write(dir.join("watch.html"), "<h1>from a file</h1>").unwrap();
    r.rt.agent_watch(call(&sid, json!({ "action": "open", "path": "watch.html" }))).await.unwrap();
    assert_eq!(body(&r.store, "watch_page", &sid).unwrap()["html"], "<h1>from a file</h1>");
    let gone = r.rt.agent_watch(call(&sid, json!({ "action": "open", "path": "nope.html" }))).await.unwrap_err();
    assert!(gone.starts_with("No such file"), "{gone}");

    r.rt.agent_watch(call(&sid, json!({ "action": "close", "caption": "Done" }))).await.unwrap();
    assert_eq!(marker(&r.rt.get(&sid).await.unwrap())["closed"], true);
    // the task's own fields in runtime's slot stay
    assert_eq!(r.rt.get(&sid).await.unwrap().ext["wisp.runtime"]["titleAuto"], true);
    std::fs::remove_dir_all(&dir).ok();
}
