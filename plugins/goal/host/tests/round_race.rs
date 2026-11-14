//! A judge round against a stand-in wisp.runtime whose judge runs and goal writes the test holds and lets go: a
//! `goal.drop` that lands while a round is under way always wins over that round's result (`serve_goal`'s typed-goal
//! test saw the second drop find a goal again under load), and a round the goal no longer is starts no more judges.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc};
use wisp_goal::GoalPlugin;
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup, WireError};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Session, Turn, TurnStatus};
use wisp_testkit::TestApp;

/// What the stand-in saw, in order: a judge's run starting, a goal write (its state, and whether it went).
#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Quick(String),
    Wrote { state: String, went: bool },
}

#[derive(Clone)]
struct Rt {
    task: Arc<Mutex<Session>>,
    /// each judge's run waits for one permit
    judges: Arc<Semaphore>,
    /// armed: the round's result write (any state but judging/cleared) waits on `go` until the test lets it go
    hold_result: Arc<Mutex<bool>>,
    held: Arc<Semaphore>,
    go: Arc<Semaphore>,
    seen: mpsc::UnboundedSender<Seen>,
}

impl Rt {
    fn goal(&self) -> Value {
        self.task.lock().unwrap().ext.get("wisp.goal").cloned().unwrap_or(Value::Null)
    }
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
                let judge = a.pick.and_then(|p| p.agent).unwrap_or_default();
                rt.seen.send(Seen::Quick(judge)).unwrap();
                rt.judges.acquire().await.unwrap().forget();
                Ok(r::QuickResult {
                    text: "NOT MET: not yet".into(),
                    json: None,
                    agent: String::new(),
                    model: String::new(),
                    cost_usd: None,
                    activity: Vec::new(),
                })
            }
        });
        // as the real one: the write goes only if the slot still holds `expect`, compared as it's written
        let rt = self.0.clone();
        s.command::<r::SetExt, _, _>(move |_, _, a: r::SetExtArgs| {
            let rt = rt.clone();
            async move {
                let state = a.value.get("state").and_then(Value::as_str).unwrap_or_default().to_owned();
                let hold = !matches!(state.as_str(), "judging" | "cleared") && std::mem::take(&mut *rt.hold_result.lock().unwrap());
                if hold {
                    rt.held.add_permits(1);
                    rt.go.acquire().await.unwrap().forget();
                }
                let went = {
                    let mut t = rt.task.lock().unwrap();
                    let now = t.ext.get(&a.plugin).cloned().unwrap_or(Value::Null);
                    let ok = a.expect.as_ref().is_none_or(|e| e.value == now);
                    if ok {
                        t.ext.insert(a.plugin.clone(), a.value.clone());
                    }
                    ok
                };
                rt.seen.send(Seen::Wrote { state, went }).unwrap();
                if went { Ok(r::Ack {}) } else { Err(WireError::conflict("changed meanwhile")) }
            }
        });
        s.command::<r::FollowUp, _, _>(|_, _, _a| async move { Ok(r::FollowedUp { turn_id: None, queued: None }) });
        s.command::<r::Ask, _, _>(|_, _, _a| async move { Ok(r::Asked { ask_id: "q1".into() }) });
        Ok(())
    }
}

async fn start(judges: &[&str]) -> (Kernel, Rt, mpsc::UnboundedReceiver<Seen>) {
    let mut task = Session { id: "t1".into(), cwd: "/tmp".into(), title: "t".into(), ..Session::default() };
    task.ext.insert("wisp.runtime".into(), json!({ "spec": { "goal": { "text": "a.txt says hello", "judges": judges } } }));
    let (tx, rx) = mpsc::unbounded_channel();
    let rt = Rt {
        task: Arc::new(Mutex::new(task)),
        judges: Arc::new(Semaphore::new(0)),
        hold_result: Arc::new(Mutex::new(false)),
        held: Arc::new(Semaphore::new(0)),
        go: Arc::new(Semaphore::new(0)),
        seen: tx,
    };
    let k = TestApp::new().with(GoalPlugin).with(Runtime(rt.clone())).start().await;
    (k, rt, rx)
}

/// The next thing the stand-in saw (a guard against a hang, not a wait for timing).
async fn next(rx: &mut mpsc::UnboundedReceiver<Seen>) -> Seen {
    tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("the round went quiet").expect("open")
}

async fn drop_goal(k: &Kernel) -> std::result::Result<Value, String> {
    k.call(Caller::user(), "goal.drop", json!({ "id": "t1" })).await.map_err(|e| e.message)
}

/// The race `serve_goal` hit: the round read the goal (still judging, still its round), a `goal.drop` landed, then
/// the round wrote its votes. The drop stands: the goal stays dropped and a second drop says there's none.
#[tokio::test(flavor = "multi_thread")]
async fn a_drop_between_a_rounds_read_and_its_write_wins() {
    let (k, rt, mut rx) = start(&["claude"]).await;
    k.call(Caller::user(), "goal.check", json!({ "id": "t1" })).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "judging".into(), went: true });
    assert_eq!(next(&mut rx).await, Seen::Quick("claude".into()));
    *rt.hold_result.lock().unwrap() = true;
    rt.judges.add_permits(1);
    // the round's result write is on its way (everything it checked said the round was still the goal's)
    rt.held.acquire().await.unwrap().forget();
    drop_goal(&k).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "cleared".into(), went: true });
    rt.go.add_permits(1);
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "again".into(), went: false }, "the old round's votes are refused");
    assert_eq!(rt.goal()["state"], "cleared");
    assert_eq!(drop_goal(&k).await.unwrap_err(), "This task has no goal to drop.");
}

/// A drop while the round's first judge is still answering: its answer stays on its record, no other judge is
/// started for a goal that's gone, and nothing is written over the drop.
#[tokio::test(flavor = "multi_thread")]
async fn a_drop_mid_round_starts_no_further_judge() {
    let (k, rt, mut rx) = start(&["claude", "codex"]).await;
    k.call(Caller::user(), "goal.check", json!({ "id": "t1" })).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "judging".into(), went: true });
    assert_eq!(next(&mut rx).await, Seen::Quick("claude".into()));
    drop_goal(&k).await.unwrap();
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "cleared".into(), went: true });
    rt.judges.add_permits(2);
    assert_eq!(next(&mut rx).await, Seen::Wrote { state: "again".into(), went: false }, "no codex run, and the drop stands");
    assert_eq!(rt.goal()["state"], "cleared");
    assert_eq!(drop_goal(&k).await.unwrap_err(), "This task has no goal to drop.");
}
