//! wisp.later's scheduler against a stand-in wisp.runtime, on a fake clock: a wake-up the agent sets during its own
//! running turn is held while the turn runs and fires once it ends (v1's bug: one scheduled while a turn ran never
//! fired); a look that can't read a task keeps what it has scheduled; a reminder's note reaches the task.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{Caller, Kernel, Manifest, Plugin, Result, Setup, WireError};
use wisp_later::LaterPlugin;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Session, SessionState};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::{FakeClock, TestApp};

#[derive(Clone, Default)]
struct Rt {
    state: Arc<Mutex<Option<SessionState>>>,
    /// runtime.get refuses (it's starting) while set
    down: Arc<Mutex<bool>>,
    sent: Arc<Mutex<Vec<String>>>,
    notes: Arc<Mutex<Vec<String>>>,
}

impl Rt {
    fn set(&self, s: SessionState) {
        *self.state.lock().unwrap() = Some(s);
    }
    fn session(&self) -> Session {
        let state = self.state.lock().unwrap().unwrap_or_default();
        serde_json::from_value(json!({ "id": "t1", "title": "Ship it", "agent": "claude", "model": "", "effort": "", "mode": "auto",
            "cwd": "/repo", "state": state, "createdAt": 0, "updatedAt": 0 }))
        .unwrap()
    }
}

/// wisp.runtime as far as later calls it: one task, `t1`.
struct Runtime(Rt);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let rt = self.0.clone();
        s.command::<r::Get, _, _>(move |_, _, a: r::IdArgs| {
            let out = if *rt.down.lock().unwrap() {
                Err(WireError::unavailable("wisp.runtime is starting"))
            } else if a.id.0 == "t1" {
                Ok(rt.session())
            } else {
                Err(WireError::not_found("No such task."))
            };
            async move { out }
        });
        let rt = self.0.clone();
        s.command::<r::FollowUp, _, _>(move |_, _, a: r::FollowUpArgs| {
            assert_eq!(a.by.as_deref(), Some("later"));
            rt.sent.lock().unwrap().push(a.text);
            async move { Ok(r::FollowedUp { turn_id: None, queued: None }) }
        });
        let rt = self.0.clone();
        s.command::<r::Note, _, _>(move |_, _, a: r::NoteArgs| {
            rt.notes.lock().unwrap().push(a.label);
            async move { Ok(r::Ack::default()) }
        });
        s.command::<r::SetExt, _, _>(|_, _, _| async move { Ok(r::Ack::default()) });
        Ok(())
    }
}

async fn kernel(rt: &Rt, clock: &FakeClock) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    TestApp::new().clock(clock).service(store).with(LaterPlugin).with(Runtime(rt.clone())).start().await
}

async fn tick(k: &Kernel) -> Value {
    k.call(Caller::user(), "later.tick", json!({})).await.unwrap()
}

async fn listed(k: &Kernel) -> usize {
    k.call(Caller::user(), "later.list", json!({ "sessionId": "t1" })).await.unwrap().as_array().unwrap().len()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wake_set_during_a_running_turn_fires_once_the_turn_ends_v1_never_fired() {
    let (rt, clock) = (Rt::default(), FakeClock::at(1_800_000_000_000));
    rt.set(SessionState::Running);
    let k = kernel(&rt, &clock).await;
    // the agent's own wake-up, set from inside its running turn
    let out = k
        .call(Caller::user(), "later.agent.schedule", json!({ "session": "t1", "minutes": 1, "message": "see if CI passed" }))
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().starts_with("Scheduled (id "), "{out}");
    clock.advance(90_000);
    // due, but the turn still runs: held, not dropped
    tick(&k).await;
    assert!(rt.sent.lock().unwrap().is_empty(), "nothing goes into a running turn");
    assert_eq!(listed(&k).await, 1, "still scheduled while the turn runs");
    // the turn ends: the next look sends it
    rt.set(SessionState::Review);
    clock.advance(20_000);
    tick(&k).await;
    let sent = rt.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].contains("see if CI passed"), "{sent:?}");
    assert_eq!(listed(&k).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_look_that_cannot_read_a_task_keeps_what_it_has_scheduled() {
    let (rt, clock) = (Rt::default(), FakeClock::at(1_800_000_000_000));
    rt.set(SessionState::Review);
    let k = kernel(&rt, &clock).await;
    k.call(Caller::user(), "later.add", json!({ "sessionId": "t1", "text": "check the deploy", "in": 1 })).await.unwrap();
    clock.advance(90_000);
    // runtime refuses the read (starting, a failed read): the task isn't gone, its follow-up stays
    *rt.down.lock().unwrap() = true;
    tick(&k).await;
    assert_eq!(listed(&k).await, 1, "an unreadable task's follow-up was forgotten as if the task were gone");
    *rt.down.lock().unwrap() = false;
    tick(&k).await;
    assert_eq!(rt.sent.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reminder_coming_due_notes_its_text_on_the_task() {
    let (rt, clock) = (Rt::default(), FakeClock::at(1_800_000_000_000));
    rt.set(SessionState::Review);
    let k = kernel(&rt, &clock).await;
    k.call(Caller::user(), "later.add", json!({ "sessionId": "t1", "text": "call the client", "in": 1, "remind": true })).await.unwrap();
    clock.advance(90_000);
    tick(&k).await;
    assert_eq!(rt.notes.lock().unwrap().clone(), ["call the client"], "runtime.note got v1's {{text}} and refused it");
    assert!(rt.sent.lock().unwrap().is_empty(), "a reminder isn't sent to the agent");
}
