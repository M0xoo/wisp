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
use wisp_runtime_api::TurnId;
use wisp_runtime_api::commands::{BtwArgs, FollowUpArgs, QuickArgs, StartArgs};
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
    fn ready(&self, s: &Session, _turn: Option<&TurnId>) -> BoxFuture<'static, Result<(), String>> {
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
    fn ready(&self, _s: &Session, _turn: Option<&TurnId>) -> BoxFuture<'static, Result<(), String>> {
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

/// ADR-0053: a /btw on an archived task whose worktree archiving removed would run in a deleted folder. It goes through the same `ready` as a turn: brought back first, and answered there.
#[tokio::test(flavor = "multi_thread")]
async fn a_btw_runs_in_the_folder_ready_brought_back() {
    let dir = folder("btw-back");
    let r = rig_with(Recorder { parts: vec![Arc::new(BringBack)], ..Recorder::default() }).await;
    let id = task_then_folder_removed(&r, &dir).await;
    let b = BtwArgs { id: id.clone().into(), question: "why?".into(), attachments: Vec::new() };
    r.rt.btw(b).await.unwrap();
    until("the /btw to spawn", || async { r.sim.spawned().len() == 2 }).await;
    assert_eq!(r.sim.spawned()[1].cwd.as_deref(), Some(dir.as_path()), "in its own folder, back again");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_btw_ready_refuses_is_refused_with_why_and_runs_nowhere() {
    let dir = folder("btw-refused");
    let r = rig_with(Recorder { parts: vec![Arc::new(Refuse)], ..Recorder::default() }).await;
    std::fs::create_dir_all(&dir).unwrap();
    let start = StartArgs { prompt: "fix it".into(), cwd: Some(dir.display().to_string()), ..StartArgs::default() };
    let id = r.rt.create(start).await.unwrap().id.0;
    let b = BtwArgs { id: id.into(), question: "why?".into(), attachments: Vec::new() };
    let err = r.rt.btw(b).await.unwrap_err().to_string();
    assert!(err.contains("couldn't come back on its branch wisp/x"), "{err}");
    assert!(r.sim.spawned().is_empty(), "nothing ran, here or anywhere else");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_btw_on_a_task_whose_folder_is_gone_is_refused_with_its_name() {
    let dir = folder("btw-gone");
    let r = rig_with(Recorder::default()).await;
    let id = task_then_folder_removed(&r, &dir).await;
    let b = BtwArgs { id: id.clone().into(), question: "why?".into(), attachments: Vec::new() };
    let err = r.rt.btw(b).await.unwrap_err().to_string();
    assert!(err.contains("folder is gone") && err.contains(&dir.display().to_string()), "{err}");
    assert_eq!(r.sim.spawned().len(), 1, "only the first turn ran");
    let s = r.rt.get(&id).await.unwrap();
    assert!(s.ext.get("wisp.runtime").and_then(|v| v.get("btw")).is_none(), "no pending /btw left behind: {:?}", s.ext);
}

/// A quick answer asked in a folder that's gone is refused, never answered from a scratch folder instead.
#[tokio::test(flavor = "multi_thread")]
async fn a_quick_run_in_a_folder_thats_gone_is_refused() {
    let dir = folder("quick-gone");
    std::fs::remove_dir_all(&dir).ok();
    let r = rig_with(Recorder::default()).await;
    let q = QuickArgs { prompt: "name it".into(), cwd: dir.display().to_string(), pick: None, timeout_ms: None, json: false, run_id: None };
    let err = r.rt.quick(q).await.unwrap_err().to_string();
    assert!(err.contains("gone") && err.contains(&dir.display().to_string()), "{err}");
    assert_eq!(r.sim.spawned().len(), 0, "nothing ran");
}

/// ADR-0053, extra folders (`dirs`, v1's `also`): a missing one refuses the turn
/// and the /btw with its name; it's never dropped from the run silently.
#[tokio::test(flavor = "multi_thread")]
async fn a_task_whose_extra_folder_is_gone_is_refused_with_its_name() {
    let (dir, extra) = (folder("dirs-main"), folder("dirs-extra"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&extra).unwrap();
    let r = rig_with(Recorder::default()).await;
    let start = StartArgs {
        prompt: "fix it".into(),
        cwd: Some(dir.display().to_string()),
        dirs: vec![extra.display().to_string()],
        ..StartArgs::default()
    };
    let id = r.rt.create(start).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    std::fs::remove_dir_all(&extra).unwrap();
    let t = follow_up(&r, &id).await;
    assert_eq!(t.status, TurnStatus::Error);
    let why = t.presentation.as_ref().unwrap().blocks[0]["summary"].as_str().unwrap().to_owned();
    assert!(why.contains("extra folders is gone") && why.contains(&extra.display().to_string()), "{why}");
    let b = BtwArgs { id: id.into(), question: "why?".into(), attachments: Vec::new() };
    let err = r.rt.btw(b).await.unwrap_err().to_string();
    assert!(err.contains(&extra.display().to_string()), "{err}");
    assert_eq!(r.sim.spawned().len(), 1, "only the first turn ran");
    std::fs::remove_dir_all(&dir).ok();
}

/// A part that brings an extra folder back (as worktrees does for one that's a removed worktree) lets it run.
#[tokio::test(flavor = "multi_thread")]
async fn an_extra_folder_ready_brings_back_runs_with_it() {
    struct Extras;
    impl RunPart for Extras {
        fn id(&self) -> &'static str {
            "wisp.worktrees"
        }
        fn ready(&self, s: &Session, _turn: Option<&TurnId>) -> BoxFuture<'static, Result<(), String>> {
            let dirs = s.dirs.clone();
            Box::pin(async move {
                for d in dirs {
                    tokio::fs::create_dir_all(&d).await.map_err(|e| e.to_string())?;
                }
                Ok(())
            })
        }
    }
    let (dir, extra) = (folder("dirs-back-main"), folder("dirs-back-extra"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&extra).unwrap();
    let r = rig_with(Recorder { parts: vec![Arc::new(Extras)], ..Recorder::default() }).await;
    let start = StartArgs {
        prompt: "fix it".into(),
        cwd: Some(dir.display().to_string()),
        dirs: vec![extra.display().to_string()],
        ..StartArgs::default()
    };
    let id = r.rt.create(start).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    std::fs::remove_dir_all(&extra).unwrap();
    let t = follow_up(&r, &id).await;
    assert_eq!(t.status, TurnStatus::Done, "{t:?}");
    assert!(extra.is_dir());
    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&extra).ok();
}

/// ADR-0053: `ready` is told which turn it readies (the id its `turn.started` / `turn.held` carries), so a
/// contributor's claims can be that turn's alone; a /btw, which has no turn and no such event, is told None.
#[tokio::test(flavor = "multi_thread")]
async fn ready_is_told_the_turn_it_readies_and_a_btw_none() {
    struct Seen(Arc<std::sync::Mutex<Vec<Option<String>>>>);
    impl RunPart for Seen {
        fn id(&self) -> &'static str {
            "wisp.worktrees"
        }
        fn ready(&self, _s: &Session, turn: Option<&TurnId>) -> BoxFuture<'static, Result<(), String>> {
            self.0.lock().unwrap().push(turn.map(|t| t.0.clone()));
            Box::pin(async { Ok(()) })
        }
    }
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dir = folder("turn-id");
    std::fs::create_dir_all(&dir).unwrap();
    let r = rig_with(Recorder { parts: vec![Arc::new(Seen(seen.clone()))], ..Recorder::default() }).await;
    let start = StartArgs { prompt: "fix it".into(), cwd: Some(dir.display().to_string()), ..StartArgs::default() };
    let id = r.rt.create(start).await.unwrap().id.0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    let second = follow_up(&r, &id).await;
    let first = r.rt.turns(&id, None, None).await.unwrap().swap_remove(0);
    let b = BtwArgs { id: id.clone().into(), question: "why?".into(), attachments: Vec::new() };
    r.rt.btw(b).await.unwrap();
    let got = seen.lock().unwrap().clone();
    assert_eq!(got, vec![Some(first.id.0), Some(second.id.0), None], "each turn's own id, then the /btw's none");
    std::fs::remove_dir_all(&dir).ok();
}
