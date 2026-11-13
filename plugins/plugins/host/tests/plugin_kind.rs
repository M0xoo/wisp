//! The `plugin` kind is acted on (ADR-0028): applying `enabled: false` switches the plugin off through the
//! kernel (its commands go with it), `plugins.list` says so, and removing the resource switches it back
//! on. wisp.plugins can't switch itself off, and an unknown plugin is refused before anything is stored.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::needless_pass_by_value)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Caller, Command, Manifest, Plugin, Result, Setup};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

struct Look;
impl Command for Look {
    const ID: &'static str = "x.look";
    type Args = Value;
    type Out = Value;
}
struct Acme;
impl Plugin for Acme {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.x", "version": "1.0.0", "api": "^1", "activation": ["onStartup"] }))
            .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Look, _, _>(|_c, _call, _a| async { Ok(json!("looked")) });
        Ok(())
    }
}

fn plugin(name: &str, spec: Value) -> Value {
    json!({ "resources": [{ "kind": "plugin", "name": name, "spec": spec }] })
}

#[tokio::test]
async fn a_formula_switches_a_plugin_off_and_back_on() {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let k = TestApp::new().with(wisp_resources::ResourcesPlugin).with(wisp_plugins::PluginsPlugin).with(Acme).service(store).start().await;
    let state =
        |list: &Value| list.as_array().unwrap().iter().find(|p| p["id"] == "acme.x").map(|p| p["state"].clone()).unwrap_or_default();
    assert_eq!(k.call(Caller::user(), "x.look", json!({})).await.unwrap(), json!("looked"));

    k.call(Caller::user(), "resources.apply", plugin("acme.x", json!({ "enabled": false }))).await.unwrap();
    assert!(k.call(Caller::user(), "x.look", json!({})).await.is_err(), "its command went with it");
    let list = k.call(Caller::user(), "plugins.list", json!({})).await.unwrap();
    assert_eq!(state(&list), json!("off"), "{list}");

    // removing the resource (pruned for another) switches it back on
    k.call(
        Caller::user(),
        "resources.apply",
        json!({ "resources": [{ "kind": "plugin", "name": "wisp.resources", "spec": { "version": "2" } }], "prune": true }),
    )
    .await
    .unwrap();
    assert_eq!(k.call(Caller::user(), "x.look", json!({})).await.unwrap(), json!("looked"));

    // refused: itself, and a plugin this wisp doesn't have (nothing stored either way)
    assert!(k.call(Caller::user(), "resources.apply", plugin("wisp.plugins", json!({ "enabled": false }))).await.is_err());
    assert!(k.call(Caller::user(), "resources.apply", plugin("acme.nope", json!({ "enabled": false }))).await.is_err());
    let left = k.call(Caller::user(), "resources.export", json!({ "kinds": ["plugin"] })).await.unwrap();
    assert!(!left.to_string().contains("acme.nope") && !left.to_string().contains("\"wisp.plugins\""), "{left}");

    // the command does the same
    let row = k.call(Caller::user(), "plugins.setEnabled", json!({ "id": "acme.x", "enabled": false })).await.unwrap();
    assert_eq!((row["state"].clone(), row["enabled"].clone()), (json!("off"), json!(false)));
}
