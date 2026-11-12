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

/// ADR-0048: whatever its manifest claims, an installed plugin is untrusted until you trust it; trusting it reloads
/// it as trusted and keeps it on, and taking the trust back makes it untrusted again.
#[tokio::test]
async fn an_installed_plugin_is_untrusted_whatever_its_manifest_says() {
    let home = dir("trust");
    let k = TestApp::new().with(wisp_plugins::PluginsPlugin).service(Paths::new(&home)).start().await;
    let src = source(&home, "user.claims", "1.0.0");
    let m = src.join("wisp-plugin.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    v["trust"] = json!("trusted");
    std::fs::write(&m, v.to_string()).unwrap();
    k.call(Caller::user(), "plugins.install", json!({ "source": src.display().to_string() })).await.unwrap();
    let builtin = |list: &Value| list.as_array().unwrap().iter().find(|p| p["id"] == "user.claims").map(|p| p["builtin"].clone());
    let trust_of = |k: &wisp_kernel::Kernel| k.status().into_iter().find(|s| s.id == "user.claims").map(|s| s.builtin);
    assert_eq!(trust_of(&k), Some(false));
    k.call(Caller::user(), "plugins.setEnabled", json!({ "id": "user.claims", "enabled": true })).await.unwrap();
    k.call(Caller::user(), "plugins.trust", json!({ "id": "user.claims", "trusted": true })).await.unwrap();
    assert!(home.join("plugins/claims/.wisp-trusted").is_file());
    let list = k.call(Caller::user(), "plugins.list", json!({})).await.unwrap();
    assert_eq!(state(&list, "user.claims").as_deref(), Some("active"), "still on after the reload");
    assert_eq!(builtin(&list), Some(json!(false)), "trusted, still yours: never a built-in");
    k.call(Caller::user(), "plugins.trust", json!({ "id": "user.claims", "trusted": false })).await.unwrap();
    assert!(!home.join("plugins/claims/.wisp-trusted").exists());
    // a built-in's trust isn't yours to change
    assert!(k.call(Caller::user(), "plugins.trust", json!({ "id": "wisp.runtime", "trusted": false })).await.is_err());
    // the manifest as read: untrusted whatever it said
    let text = std::fs::read_to_string(home.join("plugins/claims/wisp-plugin.json")).unwrap();
    let read = wisp_plugins::read_plugin(&home.join("plugins/claims"), &text, false).unwrap();
    assert_eq!(wisp_kernel::Plugin::manifest(&read).trust.as_deref(), Some("untrusted"));
}

/// ADR-0048: an untrusted plugin's UI calls wisp as the plugin (`plugin:<id>`), checked against the permissions its
/// manifest asked for and nothing more; and `plugins.ui` hands the app its module, only once it's on.
#[tokio::test]
async fn an_untrusted_plugins_calls_are_checked_against_its_own_permissions() {
    let home = dir("calls");
    let k = TestApp::new().with(wisp_plugins::PluginsPlugin).service(Paths::new(&home)).start().await;
    let d = home.join("src-pane");
    std::fs::create_dir_all(&d).unwrap();
    let m = json!({ "wispPlugin": 1, "id": "user.pane", "name": "Pane", "version": "1.0.0", "api": "^1", "permissions": ["plugins:read"], "activation": [],
        "contributes": { "ui": [{ "id": "user.pane.settings", "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./ui.js#default", "title": "Pane" }] } });
    std::fs::write(d.join("wisp-plugin.json"), m.to_string()).unwrap();
    std::fs::write(d.join("ui.js"), "wisp.render({ c: 'Text', text: 'hi' });").unwrap();
    k.call(Caller::user(), "plugins.install", json!({ "source": d.display().to_string() })).await.unwrap();
    assert_eq!(k.call(Caller::user(), "plugins.ui", json!({})).await.unwrap(), json!([]), "off: nothing shows");
    k.call(Caller::user(), "plugins.setEnabled", json!({ "id": "user.pane", "enabled": true })).await.unwrap();
    let ui = k.call(Caller::user(), "plugins.ui", json!({})).await.unwrap();
    assert_eq!((ui[0]["plugin"].as_str(), ui[0]["place"].as_str(), ui[0]["module"].as_str()), (Some("user.pane"), Some("shell.settings"), Some("wisp.render({ c: 'Text', text: 'hi' });")));
    // as itself: what it asked for, and nothing it didn't
    let me = Caller::set("plugin:user.pane");
    assert!(k.call(me.clone(), "plugins.list", json!({})).await.is_ok(), "plugins:read it asked for");
    let no = k.call(me.clone(), "plugins.install", json!({ "source": d.display().to_string() })).await.unwrap_err();
    assert_eq!(no.code, wisp_kernel::Code::Forbidden, "plugins:write it never asked for: {no:?}");
    assert!(k.call(me, "plugins.setEnabled", json!({ "id": "user.pane", "enabled": false })).await.is_err());
    let _ = std::fs::remove_dir_all(&home);
}
