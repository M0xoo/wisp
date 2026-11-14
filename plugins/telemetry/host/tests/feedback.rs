//! Feedback for the wisp team (v1 services/feedback.js, F-page-42/43): thumbs stick to their turn and go out as
//! `turn_rated` with how the run was set up (never the prompt); a note goes out as `feedback`; what no sink took waits
//! in the outbox and goes with the next one.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::model::{Mode, Presentation, Session, Turn, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};
use wisp_store::{Location, Store, SystemClock};
use wisp_telemetry_api::{SINK, Sink};
use wisp_testkit::TestApp;

#[derive(Default, Clone)]
struct Seen {
    sent: Arc<Mutex<Vec<Value>>>,
    ext: Arc<Mutex<Vec<Value>>>,
    up: Arc<Mutex<bool>>,
}

struct Sometimes(Seen);
impl Sink for Sometimes {
    fn id(&self) -> &'static str {
        "file"
    }
    fn send(&self, batch: Vec<Value>) -> BoxFuture<'static, bool> {
        let up = *self.0.up.lock().unwrap();
        if up {
            self.0.sent.lock().unwrap().extend(batch);
        }
        Box::pin(async move { up })
    }
}

macro_rules! cmd {
    ($name:ident, $id:literal) => {
        struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            type Args = Value;
            type Out = Value;
        }
    };
}
cmd!(Get, "runtime.get");
cmd!(Turns, "runtime.turns");
cmd!(TurnExt, "runtime.turn.setExt");

/// wisp.runtime as far as feedback reads it: one task, one finished turn; a turn's slot is recorded.
struct Runtime(Seen);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "1.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&SINK, Arc::new(Sometimes(self.0.clone())) as Arc<dyn Sink>);
        // runtime's own shapes (a partial body would not read as a task or a turn)
        let task = Session { id: SessionId("s1".into()), agent: "claude".into(), mode: Mode::Auto, ..Session::default() };
        let turn = Turn {
            id: TurnId("t1".into()),
            session_id: SessionId("s1".into()),
            agent: "claude".into(),
            model: "opus".into(),
            status: TurnStatus::Done,
            started_at: 1000,
            ended_at: Some(61000),
            prompt: "secret prompt".into(),
            presentation: Some(Presentation {
                blocks: vec![json!({ "type": "hero", "status": "done" })],
                v: 1,
                dropped: Vec::new(),
                topic: None,
                notes: None,
                fallback: false,
            }),
            ..Turn::default()
        };
        let (task, turns) = (serde_json::to_value(task).unwrap(), serde_json::to_value([turn]).unwrap());
        s.command::<Get, _, _>(move |_, _, _| {
            let task = task.clone();
            async move { Ok(task) }
        });
        s.command::<Turns, _, _>(move |_, _, _| {
            let turns = turns.clone();
            async move { Ok(turns) }
        });
        let ext = self.0.ext.clone();
        s.command::<TurnExt, _, _>(move |_, _, a| {
            let ext = ext.clone();
            async move {
                ext.lock().unwrap().push(a);
                Ok(json!({}))
            }
        });
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn thumbs_stick_to_the_turn_a_note_goes_as_feedback_and_the_outbox_waits_for_a_sink_v1_feedback() {
    let seen = Seen::default();
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let k = TestApp::new()
        .with(wisp_telemetry::TelemetryPlugin::with_env(wisp_telemetry_core::Env::new()))
        .with(Runtime(seen.clone()))
        .service(store)
        .start()
        .await;
    let send = |body: Value| k.call(Caller::user(), "telemetry.feedback", body);

    // 👍 offline: kept on the turn at once, the event waits
    let r = send(json!({ "rating": "up", "sessionId": "s1", "turnId": "t1", "source": "turn" })).await.unwrap();
    assert_eq!((r["ok"].clone(), r["sent"].clone(), r["available"].clone()), (json!(true), json!(false), json!(true)));
    let kept = seen.ext.lock().unwrap().clone();
    assert_eq!(kept[0]["plugin"], "wisp.telemetry");
    assert_eq!(kept[0]["value"]["feedback"]["rating"], "up");
    assert!(seen.sent.lock().unwrap().is_empty());

    // back online: 👎 with a line goes, the 👍 that waited first
    *seen.up.lock().unwrap() = true;
    let r = send(json!({ "rating": "down", "text": "It edited the wrong file", "sessionId": "s1", "turnId": "t1" })).await.unwrap();
    assert_eq!(r["sent"], true);
    let sent = seen.sent.lock().unwrap().clone();
    let names: Vec<&str> = sent.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(names, ["turn_rated", "feedback"]);
    let p = &sent[0]["properties"];
    assert_eq!((p["rating"].clone(), p["agent"].clone(), p["status"].clone()), (json!("up"), json!("claude"), json!("done")));
    assert!(!sent.iter().any(|e| e.to_string().contains("secret prompt")), "never the prompt");
    assert_eq!(sent[1]["properties"]["text"], "It edited the wrong file");

    // taking it back says so; the dialog's note is about wisp, not a turn
    send(json!({ "rating": null, "sessionId": "s1", "turnId": "t1" })).await.unwrap();
    assert_eq!(seen.ext.lock().unwrap().last().unwrap()["value"]["feedback"], Value::Null);
    send(json!({ "text": "Love the viewer", "kind": "idea", "source": "dialog" })).await.unwrap();
    let last = seen.sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!((last["event"].clone(), last["properties"]["kind"].clone()), (json!("feedback"), json!("idea")));

    // v1's refusals
    let e = send(json!({ "kind": "bug" })).await.unwrap_err();
    assert_eq!(e.message, "Say what happened, so the team can fix it.");
    assert_eq!(send(json!({})).await.unwrap_err().message, "Write something, or pick 👍 / 👎.");
}
