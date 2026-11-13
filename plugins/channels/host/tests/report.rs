//! A channel-started task answers there (v1 test/remote.test.js "notify"; F-chan-5/7/8/10): on a kernel with a
//! stand-in wisp.runtime and a fake thread transport, a finished turn's report reaches the thread it came from
//! (once, even with a notification declared for that channel too); a subagent's approval is said in its parent's
//! thread as one fixed line, never twice; a task from elsewhere gets only what a notification declares.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels::ChannelsPlugin;
use wisp_channels_api::views::{Msg, SessionView};
use wisp_channels_api::{ChannelHub, TRANSPORTS, Transport, TransportDef, TransportKind};
use wisp_kernel::{BoxFuture, Caller, CancellationToken, Kernel, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::{TaskAsked, TaskFact, TurnEnded};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

type Published = Arc<Mutex<Vec<(String, Msg)>>>;

/// A thread transport that reports `s1` only (the task started there).
struct Fake(Published);
#[async_trait]
impl Transport for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn ready(&self) -> bool {
        true
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }
    async fn start(&self, _stop: CancellationToken) {}
    async fn publish(&self, msg: &Msg, s: Option<&SessionView>) -> Result<()> {
        self.0.lock().unwrap().push((s.map(|s| s.id.clone()).unwrap_or_default(), msg.clone()));
        Ok(())
    }
    fn reports(&self, s: Option<&SessionView>) -> bool {
        s.is_some_and(|s| s.id == "s1")
    }
}
struct Def(Published);
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn create(&self, _hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new(Fake(self.0.clone()))
    }
}

/// wisp.runtime as the report reads it: `s1` (from the channel), `s2` its subagent, `s3` from elsewhere.
struct Runtime(Published);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1" })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let tasks: BTreeMap<&str, Value> = BTreeMap::from([
            ("s1", json!({ "title": "Fix login", "cwd": "/w/api" })),
            (
                "s2",
                json!({ "title": "Run tests", "cwd": "/w/api", "parentId": "s1", "ext": { "wisp.runtime": { "ask": { "id": "a1", "question": "OK?", "permission": { "action": "edit src/a.ts" } } } } }),
            ),
            ("s3", json!({ "title": "Elsewhere", "cwd": "/w/api" })),
        ]);
        s.command::<r::Get, _, _>(move |_, _, a: r::IdArgs| {
            let mut t = tasks.get(a.id.0.as_str()).cloned().unwrap_or_default();
            t["id"] = json!(a.id.0);
            t["agent"] = json!("claude");
            let base = json!({ "model": "", "effort": "", "mode": "edits", "state": "review", "createdAt": 0, "updatedAt": 0 });
            async move { Ok(merge(base, &t)) }
        });
        s.command::<r::Turns, _, _>(|_, _, _a: r::TurnsArgs| async move { Ok(serde_json::from_value(json!([turn()])).unwrap()) });
        s.contribute(&TRANSPORTS, Arc::new(Def(self.0.clone())) as Arc<dyn TransportDef>);
        Ok(())
    }
}

fn merge(mut base: Value, t: &Value) -> wisp_runtime_api::model::Session {
    for (k, v) in t.as_object().cloned().unwrap_or_default() {
        base[k] = v;
    }
    serde_json::from_value(base).unwrap()
}

fn turn() -> Value {
    json!({ "id": "t1", "sessionId": "s1", "idx": 0, "prompt": "fix it", "agent": "claude", "model": "", "effort": "", "mode": "edits",
        "status": "done", "startedAt": 0, "presentation": { "v": 1, "blocks": [{ "type": "hero", "title": "Login fixed", "summary": "Refresh retries.", "status": "done" }] } })
}

#[derive(Default)]
struct Secrets(Mutex<BTreeMap<String, String>>);
impl wisp_kernel::services::Secrets for Secrets {
    fn get(&self, key: &str) -> BoxFuture<'static, Result<Option<String>>> {
        let v = self.0.lock().unwrap().get(key).cloned();
        Box::pin(async move { Ok(v) })
    }
    fn set(&self, key: &str, value: &str) -> BoxFuture<'static, Result<()>> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Box::pin(async { Ok(()) })
    }
    fn delete(&self, key: &str) -> BoxFuture<'static, Result<()>> {
        self.0.lock().unwrap().remove(key);
        Box::pin(async { Ok(()) })
    }
    fn keys(&self, _prefix: &str) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

async fn kernel(out: &Published) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let secrets: wisp_kernel::services::SecretsService = Arc::new(Secrets::default());
    let k = TestApp::new()
        .service(store)
        .service(secrets)
        .with(wisp_resources::ResourcesPlugin)
        .with(ChannelsPlugin)
        .with(Runtime(out.clone()))
        .start()
        .await;
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [
            { "kind": "channel", "name": "fake", "spec": { "transport": "fake", "enabled": true } },
            { "kind": "notification", "name": "done", "spec": { "on": ["finished"], "to": "fake" } },
        ] }),
    )
    .await
    .unwrap();
    k
}

async fn settle(out: &Published, n: usize) -> Vec<(String, Msg)> {
    for _ in 0..200 {
        if out.lock().unwrap().len() >= n {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // what else would arrive comes as fast: a short wait shows there's no more
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    out.lock().unwrap().clone()
}

fn finished(id: &str) -> TurnEnded {
    serde_json::from_value(
        json!({ "sessionId": id, "turnId": "t1", "status": "done", "interrupted": false, "agent": "claude", "model": "", "inner": false }),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_channel_task_reports_in_its_thread_once_and_another_only_where_a_notification_says() {
    let out = Published::default();
    let k = kernel(&out).await;
    let ctx = k.ctx("wisp.runtime").unwrap();
    ctx.emit(&ctx.root_call(), &finished("s1"));
    ctx.emit(&ctx.root_call(), &finished("s3"));
    let mut got = settle(&out, 2).await;
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(got.len(), 2, "s1 once (its notification is covered by the report), s3 by its notification only: {got:?}");
    let (id, msg) = &got[0];
    assert_eq!(id, "s1");
    assert_eq!(msg.title, "✅ Fix login");
    assert_eq!(msg.text, "Login fixed\n\nRefresh retries.");
    assert_eq!(msg.actions.iter().map(|a| a.label.as_str()).collect::<Vec<_>>(), ["Mark done"]);
    assert_eq!((got[1].0.as_str(), got[1].1.title.as_str()), ("s3", "✓ Elsewhere"), "the declared notification, as before");
    let mut compact = finished("s1");
    (compact.turn_id, compact.inner) = ("t2".into(), true);
    ctx.emit(&ctx.root_call(), &compact);
    assert_eq!(settle(&out, 3).await.len(), 3, "wisp's own turn (a compact): no report; its declared notification still goes");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subagents_approval_is_said_once_in_its_parents_thread() {
    let out = Published::default();
    let k = kernel(&out).await;
    let ctx = k.ctx("wisp.runtime").unwrap();
    // the event's own key differs each time (the bus would drop a repeat): the ask id is what's said once
    let asked = |text: &str| {
        TaskAsked(TaskFact {
            session_id: SessionId::from("s2"),
            title: "Run tests".into(),
            cwd: "/w/api".into(),
            status: "asked".into(),
            text: text.into(),
            ..TaskFact::default()
        })
    };
    ctx.emit(&ctx.root_call(), &asked("OK?"));
    let got = settle(&out, 1).await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!((got[0].0.as_str(), got[0].1.title.as_str()), ("s1", "Waiting for your OK in wisp: edit src/a.ts"));
    assert!(got[0].1.actions.is_empty(), "nothing to tap: it's approved in wisp");
    ctx.emit(&ctx.root_call(), &asked("OK? (still)"));
    assert_eq!(settle(&out, 2).await.len(), 1, "the same ask isn't said twice");
}
