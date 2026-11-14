//! ADR-0053: before any turn runs, `runtime.run@1`'s `ready` makes the task's folder ready (worktrees brings
//! back one archiving removed); a refusal, or a folder that's gone with nobody to bring it back, refuses the
//! turn with why, and nothing is spawned anywhere else.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{rig_with, until};
use wisp_kernel::BoxFuture;
use wisp_runtime::Recorder;
use wisp_runtime_api::commands::{FollowUpArgs, StartArgs};
use wisp_runtime_api::model::{Session, TurnStatus};
use wisp_runtime_api::points::RunPart;

fn folder(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("wisp-ready-{name}-{}", std::process::id()))
}

/// Makes the task's folder again, as worktrees' bring-back does.
struct BringBack;
impl RunPart for BringBack {
    fn id(&self) -> &'static str {
        "wisp.worktrees"
    }
    fn ready(&self, s: &Session) -> BoxFuture<'static, Result<(), String>> {
        let cwd = s.cwd.clone();
        Box::pin(async move { tokio::fs::create_dir_all(&cwd).await.map_err(|e| e.to_string()) })
    }
}

/// Can't bring it back.
struct Refuse;
impl RunPart for Refuse {
    fn id(&self) -> &'static str {
        "wisp.worktrees"
    }
    fn ready(&self, _s: &Session) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Err("This task's worktree couldn't come back on its branch wisp/x.".to_owned()) })
    }
}

async fn task_then_folder_removed(r: &common::Rig, dir: &std::path::Path) -> String {
    std::fs::create_dir_all(dir).unwrap();
    let start = StartArgs { prompt: "fix it".into(), cwd: Some(dir.display().to_string()), ..StartArgs::default() };
    let id = r.rt.create(start).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    std::fs::remove_dir_all(dir).unwrap(); // archiving removed it
    id
}

async fn follow_up(r: &common::Rig, id: &str) -> wisp_runtime_api::model::Turn {
    let f = FollowUpArgs { id: id.into(), text: "one more".into(), ..FollowUpArgs::default() };
    r.rt.follow_up(f).await.unwrap();
    until("the follow-up to end", || async {
        r.rt.turns(id, None, None).await.unwrap().get(1).is_some_and(|t| t.status != TurnStatus::Running)
    })
    .await;
    r.rt.turns(id, None, None).await.unwrap().swap_remove(1)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_follow_up_runs_in_the_folder_ready_brought_back() {
    let dir = folder("back");
    let r = rig_with(Recorder { parts: vec![Arc::new(BringBack)], ..Recorder::default() }).await;
    let id = task_then_folder_removed(&r, &dir).await;
    let t = follow_up(&r, &id).await;
    assert_eq!(t.status, TurnStatus::Done, "{t:?}");
    let spawned = r.sim.spawned();
    assert_eq!(spawned.len(), 2);
    assert_eq!(spawned[1].cwd.as_deref(), Some(dir.as_path()), "in its own folder, back again");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_ready_refuses_is_not_started_and_says_why() {
    let dir = folder("refused");
    let r = rig_with(Recorder { parts: vec![Arc::new(Refuse)], ..Recorder::default() }).await;
    // the first turn: its folder is there, but ready refuses every turn
    std::fs::create_dir_all(&dir).unwrap();
    let start = StartArgs { prompt: "fix it".into(), cwd: Some(dir.display().to_string()), ..StartArgs::default() };
    let id = r.rt.create(start).await.unwrap().id.0;
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Error);
    let hero = &t.presentation.as_ref().unwrap().blocks[0];
    assert_eq!(hero["title"], "Not started");
    assert!(hero["summary"].as_str().unwrap().contains("couldn't come back on its branch wisp/x"), "{hero}");
    assert!(r.sim.spawned().is_empty(), "nothing ran, here or anywhere else");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_whose_folder_is_gone_with_nobody_to_bring_it_back_is_refused() {
    let dir = folder("gone");
    let r = rig_with(Recorder::default()).await;
    let id = task_then_folder_removed(&r, &dir).await;
    let t = follow_up(&r, &id).await;
    assert_eq!(t.status, TurnStatus::Error);
    let why = t.presentation.as_ref().unwrap().blocks[0]["summary"].as_str().unwrap().to_owned();
    assert!(why.contains("folder is gone") && why.contains(&dir.display().to_string()), "{why}");
    assert_eq!(r.sim.spawned().len(), 1, "only the first turn ran");
}
