//! A judge already running when its goal is dropped, replaced or its task deleted is stopped (`runtime.quickCancel`
//! with the check's id), not left to run to its end and spend tokens on a vote that's thrown away. Against a
//! stand-in wisp.runtime whose judge runs answer only when they're cancelled.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use wisp_goal::GoalPlugin;
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup, WireError};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::SessionDeleted;
use wisp_runtime_api::model::{Session, Turn, TurnStatus};
use wisp_testkit::TestApp;

#[derive(Debug, Clone, PartialEq)]
enum Seen {
    /// a judge's run started: its run id
    Quick(String),
    /// `runtime.quickCancel` for this run id
    Cancel(String),
    Wrote(String),
}

#[derive(Clone)]
struct Rt {
    task: Arc<Mutex<Session>>,
    /// the run ids cancelled so far: a judge's run waits until its own id is here
    cancelled: watch::Sender<Vec<String>>,
    seen: mpsc::UnboundedSender<Seen>,
}

struct Runtime(Rt);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let rt = self.0.clone();
        s.command::<r::Get, _, _>(move |_, _, _a| {
            let t = rt.task.lock().unwrap().clone();
            async move { Ok(t) }
        });
        s.command::<r::Turns, _, _>(|_, _, _a| async move {
            Ok(vec![Turn {
                id: "u1".into(),
                session_id: "t1".into(),
                status: TurnStatus::Done,
                text: Some("done".into()),
                ..Turn::default()
            }])
        });
        s.command::<r::Profiles, _, _>(|_, _, _a: Value| async move { Ok(Vec::new()) });
        let rt = self.0.clone();
        s.command::<r::Quick, _, _>(move |_, _, a: r::QuickArgs| {
            let rt = rt.clone();
            async move {
                let id = a.run_id.expect("a judge's run is named, so it can be stopped");
                rt.seen.send(Seen::Quick(id.clone())).unwrap();
                let mut rx = rt.cancelled.subscribe();
                rx.wait_for(|c| c.contains(&id)).await.unwrap();
                Err::<r::QuickResult, _>(WireError::conflict("It was cancelled.").with_details(json!({ "cancelled": true })))
            }
        });
        let rt = self.0.clone();
        s.command::<r::QuickCancel, _, _>(move |_, _, a: r::QuickCancelArgs| {
            let rt = rt.clone();
            async move {
                rt.seen.send(Seen::Cancel(a.run_id.clone())).unwrap();
                rt.cancelled.send_modify(|c| c.push(a.run_id));
                Ok(r::QuickCancelled { stopped: true })
            }
        });
        let rt = self.0.clone();
        s.command::<r::SetExt, _, _>(move |_, _, a: r::SetExtArgs| {
            let rt = rt.clone();
            async move {
                let state = a.value.get("state").and_then(Value::as_str).unwrap_or_default().to_owned();
                let went = {
                    let mut t = rt.task.lock().unwrap();
                    let now = t.ext.get(&a.plugin).cloned().unwrap_or(Value::Null);
                    let ok = a.expect.as_ref().is_none_or(|e| e.value == now);
                    if ok {
                        t.ext.insert(a.plugin.clone(), a.value.clone());
                    }
                    ok
                };
                if went {
                    rt.seen.send(Seen::Wrote(state)).unwrap();
                    Ok(r::Ack {})
                } else {
                    Err(WireError::conflict("changed meanwhile"))
                }
            }
        });
        s.command::<r::FollowUp, _, _>(|_, _, _a| async move { Ok(r::FollowedUp { turn_id: None, queued: None }) });
        s.command::<r::Ask, _, _>(|_, _, _a| async move { Ok(r::Asked { ask_id: "q1".into() }) });
        Ok(())
    }
}

async fn start() -> (Kernel, mpsc::UnboundedReceiver<Seen>) {
    let mut task = Session { id: "t1".into(), cwd: "/tmp".into(), title: "t".into(), ..Session::default() };
    task.ext.insert("wisp.runtime".into(), json!({ "spec": { "goal": { "text": "a.txt says hello", "judges": ["claude"] } } }));
    let (tx, rx) = mpsc::unbounded_channel();
    let rt = Rt { task: Arc::new(Mutex::new(task)), cancelled: watch::channel(Vec::new()).0, seen: tx };
    let k = TestApp::new().with(GoalPlugin).with(Runtime(rt)).start().await;
    (k, rx)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<Seen>) -> Seen {
    tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("the round went quiet").expect("open")
}

/// A round under way: its judge's run started, its id.
async fn judging(k: &Kernel, rx: &mut mpsc::UnboundedReceiver<Seen>) -> String {
    k.call(Caller::user(), "goal.check", json!({ "id": "t1" })).await.unwrap();
    assert_eq!(next(rx).await, Seen::Wrote("judging".into()));
    let Seen::Quick(id) = next(rx).await else { panic!("a judge's run") };
    id
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_goal_mid_judge_stops_its_judge() {
    let (k, mut rx) = start().await;
    let run = judging(&k, &mut rx).await;
    k.call(Caller::user(), "goal.drop", json!({ "id": "t1" })).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote("cleared".into()));
    assert_eq!(next(&mut rx).await, Seen::Cancel(run), "the judge under way is stopped, by its run's id");
    let again = k.call(Caller::user(), "goal.drop", json!({ "id": "t1" })).await.unwrap_err();
    assert_eq!(again.message, "This task has no goal to drop.", "the stopped round wrote nothing over the drop");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_goal_mid_judge_stops_the_old_goals_judge() {
    let (k, mut rx) = start().await;
    let run = judging(&k, &mut rx).await;
    k.call(Caller::user(), "goal.set", json!({ "id": "t1", "text": "a.txt says goodbye" })).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote(String::new()), "the new goal");
    assert_eq!(next(&mut rx).await, Seen::Cancel(run));
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_task_mid_judge_stops_its_judge() {
    let (k, mut rx) = start().await;
    let run = judging(&k, &mut rx).await;
    let ctx = k.ctx("wisp.runtime").unwrap();
    ctx.emit(&ctx.root_call(), &SessionDeleted { id: SessionId::from("t1") });
    assert_eq!(next(&mut rx).await, Seen::Cancel(run));
}
