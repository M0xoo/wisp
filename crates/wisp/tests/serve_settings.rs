//! wisp.settings in `wisp serve`: a setting changed with `settings.set` survives a restart (the kernel's
//! registry saves it through the store), and a value its declaration refuses is refused.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_setting_survives_a_restart() {
    let dir = temp("serve-settings");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let set = api.cmd("settings.set", json!({ "key": "review.harness", "value": "codex" })).await;
    assert_eq!(set["value"], "codex", "{set}");
    assert_ne!(api.try_cmd("settings.set", json!({ "key": "review.harness", "value": "nope" })).await["ok"], true, "the declaration's values only");
    api.cmd("settings.set", json!({ "key": "settings.timeZone", "value": "Europe/Zurich" })).await;
    serve.stop();
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    assert_eq!(api.cmd("settings.get", json!({ "key": "review.harness" })).await, "codex");
    assert_eq!(api.cmd("settings.get", json!({ "key": "settings.timeZone" })).await, "Europe/Zurich");
    drop(serve);
}
