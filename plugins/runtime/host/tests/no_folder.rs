//! A task with no folder (adopted from a share, made before `specs::folder`) never uses the server's own folder:
//! `Path::new("")` and a spawn with no cwd both resolve against it. Each place that would is refused or skips.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::rig;
use serde_json::{Value, json};
use wisp_runtime_api::commands::AgentWatchArgs;
use wisp_runtime_api::spec::AdoptArgs;

/// A PNG's first bytes: what the content check on a file outside the folder wants.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

async fn no_folder(r: &common::Rig) -> String {
    let turn = serde_json::to_value(wisp_runtime_api::model::Turn { prompt: "fix".into(), ..Default::default() }).unwrap();
    r.rt.adopt(AdoptArgs { title: "shared".into(), agent: "fake".into(), cwd: String::new(), turns: vec![turn], ..AdoptArgs::default() })
        .await
        .unwrap()
        .id
        .0
}

/// One-click commands (`runtime.exec`) ran `sh -c` in the server's folder when the task had none.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_in_a_task_with_no_folder_is_refused_not_run_in_the_servers_folder() {
    let r = rig().await;
    let id = no_folder(&r).await;
    let e = r.rt.exec(&id, "pwd").await.unwrap_err();
    assert!(e.to_string().contains("no folder"), "{e}");
}

/// A relative picture of a task with no folder was the server's own folder's file (served once its bytes looked
/// like a picture): not served, not shown in Finder.
#[tokio::test(flavor = "multi_thread")]
async fn a_relative_picture_of_a_task_with_no_folder_is_never_read_from_the_servers_folder() {
    let r = rig().await;
    let id = no_folder(&r).await;
    // a real picture in the process's own folder, under the name the task asks for
    let name = format!("wisp-leak-{}.png", std::process::id());
    std::fs::write(&name, PNG).unwrap();
    let served = r.rt.media(&id, &name).await;
    let shown = r.rt.reveal(&id, &name).await;
    std::fs::remove_file(&name).ok();
    assert!(served.unwrap().is_none(), "served the server folder's file");
    assert!(shown.is_err(), "revealed the server folder's file");
}

/// `wisp_watch open` with a relative path read the page from the server's folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_relative_watch_page_of_a_task_with_no_folder_is_refused() {
    let r = rig().await;
    let id = no_folder(&r).await;
    let Value::Object(body) = json!({ "action": "open", "title": "Page", "path": "Cargo.toml" }) else { panic!() };
    let e = r.rt.agent_watch(AgentWatchArgs { session: id, body }).await.unwrap_err();
    assert!(e.contains("isn't a full path"), "{e}");
}
