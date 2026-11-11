//! ADR-0046: a user's plugin installed from a folder while wisp runs: off until switched on, a built-in id or a bad
//! manifest refused with nothing kept, the same plugin again replacing it, uninstall removing it and its folder, and
//! the folders under `~/.wisp/plugins` read at start.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use wisp_kernel::Caller;
use wisp_kernel::services::Paths;
use wisp_testkit::TestApp;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-plugins-{name}-{}", wisp_kernel::ids::uuid7()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn source(at: &Path, id: &str, version: &str) -> PathBuf {
    let d = at.join(format!("src-{id}-{version}"));
    std::fs::create_dir_all(&d).unwrap();
    let m = json!({ "wispPlugin": 1, "id": id, "name": "Theme", "version": version, "api": "^1", "permissions": ["settings:read"], "activation": [], "contributes": {} });
    std::fs::write(d.join("wisp-plugin.json"), m.to_string()).unwrap();
    std::fs::write(d.join("README.md"), "hello").unwrap();
    d
}

fn state(list: &Value, id: &str) -> Option<String> {
    list.as_array().unwrap().iter().find(|p| p["id"] == id).map(|p| p["state"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn an_installed_plugin_starts_off_until_switched_on_and_uninstall_removes_it() {
    let home = dir("home");
    let k = TestApp::new().with(wisp_plugins::PluginsPlugin).service(Paths::new(&home)).start().await;
    let src = source(&home, "user.theme", "1.0.0");
    let out = k.call(Caller::user(), "plugins.install", json!({ "source": src.display().to_string() })).await.unwrap();
    assert_eq!((out["id"].clone(), out["permissions"].clone()), (json!("user.theme"), json!(["settings:read"])));
    assert!(home.join("plugins/theme/wisp-plugin.json").is_file() && home.join("plugins/theme/README.md").is_file());
    let list = k.call(Caller::user(), "plugins.list", json!({})).await.unwrap();
    assert_eq!(state(&list, "user.theme").as_deref(), Some("off"), "off until switched on");
    k.call(Caller::user(), "plugins.setEnabled", json!({ "id": "user.theme", "enabled": true })).await.unwrap();
    let list = k.call(Caller::user(), "plugins.list", json!({})).await.unwrap();
    assert_ne!(state(&list, "user.theme").as_deref(), Some("off"));
    // installing_the_same_id_again_replaces_it
    let v2 = source(&home, "user.theme", "2.0.0");
    let out = k.call(Caller::user(), "plugins.install", json!({ "source": v2.display().to_string() })).await.unwrap();
    assert_eq!(out["version"], json!("2.0.0"));
    // uninstall_takes_a_user_plugin_off_and_removes_it
    k.call(Caller::user(), "plugins.uninstall", json!({ "id": "user.theme" })).await.unwrap();
    let list = k.call(Caller::user(), "plugins.list", json!({})).await.unwrap();
    assert!(state(&list, "user.theme").is_none());
    assert!(!home.join("plugins/theme").exists());
    assert!(k.call(Caller::user(), "plugins.uninstall", json!({ "id": "wisp.plugins" })).await.is_err(), "a built-in stays");
    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn a_plugin_claiming_a_built_in_id_is_refused_and_nothing_is_kept() {
    let home = dir("refused");
    let k = TestApp::new().with(wisp_plugins::PluginsPlugin).service(Paths::new(&home)).start().await;
    let src = source(&home, "wisp.theme", "1.0.0");
    let e = k.call(Caller::user(), "plugins.install", json!({ "source": src.display().to_string() })).await.unwrap_err();
    assert!(e.message.contains("isn't a user plugin's id"), "{}", e.message);
    // an_invalid_manifest_is_refused_and_nothing_is_kept
    let bad = home.join("bad");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(bad.join("wisp-plugin.json"), "{ not json").unwrap();
    assert!(k.call(Caller::user(), "plugins.install", json!({ "source": bad.display().to_string() })).await.is_err());
    let left: Vec<_> = std::fs::read_dir(home.join("plugins")).map(|r| r.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "nothing kept: {left:?}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn user_plugins_load_at_start() {
    let home = dir("start");
    let plugins = home.join("plugins");
    std::fs::create_dir_all(plugins.join("theme")).unwrap();
    std::fs::write(plugins.join("theme/wisp-plugin.json"), json!({ "wispPlugin": 1, "id": "user.theme", "version": "1.0.0", "api": "^1" }).to_string()).unwrap();
    std::fs::create_dir_all(plugins.join("broken")).unwrap();
    std::fs::write(plugins.join("broken/wisp-plugin.json"), "nope").unwrap();
    let got = wisp_plugins::user_plugins(&plugins);
    assert_eq!(got.iter().map(|p| wisp_kernel::Plugin::manifest(p).id).collect::<Vec<_>>(), ["user.theme"]);
    let _ = std::fs::remove_dir_all(&home);
}
