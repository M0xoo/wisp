//! A turn's start reads the task, awaits its folder, `before:run` and run parts, then writes the task. Another
//! plugin's slot written in between (`runtime.setExt`: a goal dropped while its round's follow-up starts) stays:
//! `serve_goal`'s typed-goal test saw the dropped goal come back as the follow-up's start wrote its old copy.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::{Arc, Mutex};

use common::{rig_with, until};
use serde_json::json;
use tokio::sync::Semaphore;
use wisp_kernel::BoxFuture;
use wisp_runtime::Recorder;
use wisp_runtime_api::TurnId;
use wisp_runtime_api::commands::{FollowUpArgs, StartArgs};
use wisp_runtime_api::model::{Session, TurnStatus};
use wisp_runtime_api::points::RunPart;

/// Armed: the next turn's `ready` waits (in the middle of its start) until the test lets it go.
#[derive(Clone)]
struct Gate {
    armed: Arc<Mutex<bool>>,
    hit: Arc<Semaphore>,
    go: Arc<Semaphore>,
}
impl Gate {
    fn new() -> Self {
        Self { armed: Arc::new(Mutex::new(false)), hit: Arc::new(Semaphore::new(0)), go: Arc::new(Semaphore::new(0)) }
    }
}
impl RunPart for Gate {
    fn id(&self) -> &'static str {
        "wisp.test"
    }
    fn ready(&self, _s: &Session, turn: Option<&TurnId>) -> BoxFuture<'static, Result<(), String>> {
        let hold = turn.is_some() && std::mem::take(&mut *self.armed.lock().unwrap());
        let g = self.clone();
        Box::pin(async move {
            if hold {
                g.hit.add_permits(1);
                g.go.acquire().await.unwrap().forget();
            }
            Ok(())
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slot_written_while_a_turn_starts_is_kept() {
    let gate = Gate::new();
    let r = rig_with(Recorder { parts: vec![Arc::new(gate.clone())], ..Recorder::default() }).await;
    let dir = std::env::temp_dir().join(format!("wisp-start-ext-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let id =
        r.rt.create(StartArgs { prompt: "fix it".into(), cwd: Some(dir.display().to_string()), ..StartArgs::default() })
            .await
            .unwrap()
            .id
            .0;
    until("the first turn", || async { r.rt.turns(&id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done) })
        .await;
    r.rt.set_ext(&id, "wisp.goal", json!({ "state": "again", "rounds": 1 }), None).await.unwrap();
    *gate.armed.lock().unwrap() = true;
    let (rt, tid) = (r.rt.clone(), id.clone());
    let started =
        tokio::spawn(async move { rt.follow_up(FollowUpArgs { id: tid.into(), text: "more".into(), ..FollowUpArgs::default() }).await });
    // the follow-up's start has read the task and waits on its folder: the goal is dropped now
    gate.hit.acquire().await.unwrap().forget();
    r.rt.set_ext(&id, "wisp.goal", json!({ "state": "cleared" }), None).await.unwrap();
    gate.go.add_permits(1);
    started.await.unwrap().unwrap();
    until("the follow-up", || async { r.rt.turns(&id, None, None).await.unwrap().len() == 2 }).await;
    assert_eq!(r.rt.get(&id).await.unwrap().ext["wisp.goal"], json!({ "state": "cleared" }), "the drop stands");
    std::fs::remove_dir_all(&dir).ok();
}
