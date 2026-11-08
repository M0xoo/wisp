//! wisp.settings in `wisp serve`: a setting changed through v1's `PATCH /config` (or `settings.set`)
//! survives a restart (the kernel's registry saves it through the store; before, v2 kept settings in
//! memory only), a value its declaration refuses is refused, and v1's names map to the keys.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn a_setting_survives_a_restart() {
    let dir = temp("serve-settings");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let set = api.cmd("settings.set", json!({ "key": "review.harness", "value": "codex" })).await;
    assert_eq!(set["value"], "codex", "{set}");
    assert_ne!(api.try_cmd("settings.set", json!({ "key": "review.harness", "value": "nope" })).await["ok"], true, "the declaration's values only");
    let r = api.http.patch(format!("http://127.0.0.1:{port}/api/config")).header("content-type", "application/json").body(json!({ "defaults": { "timeZone": "Europe/Zurich" } }).to_string()).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    serve.stop();
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    assert_eq!(api.cmd("settings.get", json!({ "key": "review.harness" })).await, "codex");
    let cfg: Value = serde_json::from_slice(&api.http.get(format!("http://127.0.0.1:{port}/api/config")).send().await.unwrap().bytes().await.unwrap()).unwrap();
    assert_eq!((cfg["defaults"]["timeZone"].as_str(), cfg["defaults"]["review"].as_str()), (Some("Europe/Zurich"), Some("codex")), "{cfg}");
    drop(serve);
}
