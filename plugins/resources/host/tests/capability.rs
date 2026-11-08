//! The `capability` kind is acted on (ADR-0028): applying one loads `custom:<name>` into the kernel, so a
//! caller holding it may do what it allows and nothing else; removing it takes the set away.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::needless_pass_by_value)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

struct Look;
impl Command for Look {
    const ID: &'static str = "x.look";
    const PERMISSION: Option<&'static str> = Some("x:look");
    type Args = Value;
    type Out = Value;
}
struct Touch;
impl Command for Touch {
    const ID: &'static str = "x.touch";
    const PERMISSION: Option<&'static str> = Some("x:touch");
    type Args = Value;
    type Out = Value;
}
struct Acme;
impl Plugin for Acme {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.x", "version": "1.0.0", "api": "^1", "activation": ["onStartup"] })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Look, _, _>(|_c, _call, _a| async { Ok(json!("looked")) });
        s.command::<Touch, _, _>(|_c, _call, _a| async { Ok(json!("touched")) });
        Ok(())
    }
}

fn ci() -> Caller {
    Caller { set: "custom:ci".into(), session: None, plugin: None }
}

#[tokio::test]
async fn a_declared_capability_set_is_what_its_holder_may_do() {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let k = TestApp::new().with(wisp_resources::ResourcesPlugin).with(Acme).service(store).start().await;
    assert!(k.call(ci(), "x.look", json!({})).await.is_err(), "no such set yet");
    k.call(Caller::user(), "resources.apply", json!({ "resources": [{ "kind": "capability", "name": "ci", "spec": { "allow": ["x:look"] } }] })).await.unwrap();
    assert_eq!(k.call(ci(), "x.look", json!({})).await.unwrap(), json!("looked"));
    let refused = k.call(ci(), "x.touch", json!({})).await.unwrap_err();
    assert_eq!(refused.code, wisp_kernel::Code::Forbidden, "{refused:?}");
    // pruning it away (a formula that declares another set instead) takes the set away
    let gone = k.call(Caller::user(), "resources.apply", json!({ "resources": [{ "kind": "capability", "name": "other", "spec": {} }], "prune": true })).await.unwrap();
    assert_eq!(gone["applied"], 2, "{gone}");
    assert!(k.call(ci(), "x.look", json!({})).await.is_err(), "the set went with it");
}
