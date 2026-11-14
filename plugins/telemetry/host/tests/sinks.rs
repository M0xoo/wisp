//! ADR-0021: wisp.telemetry hands every sink the same scrubbed batch, with `PostHog` nowhere in sight; a
//! failing sink holds no other up; opting out sends nothing; only catalogue keys go out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_store::{Location, Store, SystemClock};
use wisp_telemetry_api::{SINK, Sink};
use wisp_testkit::TestApp;

#[derive(Default, Clone)]
struct Got(Arc<Mutex<Vec<Value>>>);

struct FileSink(Got);
impl Sink for FileSink {
    fn id(&self) -> &'static str {
        "file"
    }
    fn send(&self, batch: Vec<Value>) -> BoxFuture<'static, bool> {
        self.0.0.lock().unwrap().extend(batch);
        Box::pin(async { true })
    }
}
/// A sink that never answers: it must hold nothing up.
struct Stuck;
impl Sink for Stuck {
    fn id(&self) -> &'static str {
        "stuck"
    }
    fn send(&self, _batch: Vec<Value>) -> BoxFuture<'static, bool> {
        Box::pin(std::future::pending())
    }
}

/// A plugin that owns a fact and records it.
struct Emit;
impl Command for Emit {
    const ID: &'static str = "metrics.emit";
    type Args = Value;
    type Out = Value;
}
struct Acme(Got);
impl Plugin for Acme {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(
            json!({ "wispPlugin": 1, "id": "acme.metrics", "version": "1.0.0", "api": "^1", "permissions": ["telemetry:track"] }),
        )
        .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&SINK, Arc::new(FileSink(self.0.clone())) as Arc<dyn Sink>);
        s.contribute(&SINK, Arc::new(Stuck) as Arc<dyn Sink>);
        s.command::<Emit, _, _>(|ctx, call, a| async move { ctx.run_json(&call, "telemetry.track", a).await });
        Ok(())
    }
}

async fn kernel(got: &Got) -> wisp_kernel::Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    TestApp::new()
        .with(wisp_telemetry::TelemetryPlugin::with_env(wisp_telemetry_core::Env::new()))
        .with(Acme(got.clone()))
        .service(store)
        .start()
        .await
}

async fn flushed(k: &wisp_kernel::Kernel, got: &Got) -> Vec<Value> {
    k.call(Caller::user(), "telemetry.flush", Value::Null).await.unwrap();
    for _ in 0..50 {
        if !got.0.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    got.0.lock().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn another_sink_gets_the_events_without_posthog() {
    let got = Got::default();
    let k = kernel(&got).await;
    let r = k
        .call(
            Caller::user(),
            "metrics.emit",
            json!({ "event": "stuff_save", "props": { "by": "user", "kind": "note", "update": false, "secret": "/Users/me/x" } }),
        )
        .await
        .unwrap();
    assert_eq!(r["queued"], true);
    let batch = flushed(&k, &got).await;
    assert_eq!(batch.len(), 1, "{batch:?}");
    let p = &batch[0]["properties"];
    assert_eq!((batch[0]["event"].as_str(), p["kind"].as_str()), (Some("stuff_save"), Some("note")));
    assert!(p.get("secret").is_none(), "a key the catalogue doesn't know is never sent");
    assert!(p["distinct_id"].is_string() && p["$lib"] == "wisp");
    // the page may send only its events and values
    assert_eq!(k.call(Caller::user(), "telemetry.track", json!({ "event": "stuff_save", "props": {} })).await.unwrap()["queued"], false);
    assert_eq!(
        k.call(Caller::user(), "telemetry.track", json!({ "event": "getapp_opened", "props": { "from": "button" } })).await.unwrap()["queued"],
        true
    );
    // opted out: nothing is queued, nothing goes
    got.0.lock().unwrap().clear();
    k.call(Caller::user(), "telemetry.set", json!({ "on": false })).await.unwrap();
    assert_eq!(k.call(Caller::user(), "metrics.emit", json!({ "event": "stuff_save", "props": {} })).await.unwrap()["queued"], false);
    k.call(Caller::user(), "telemetry.flush", Value::Null).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(got.0.lock().unwrap().is_empty());
}
