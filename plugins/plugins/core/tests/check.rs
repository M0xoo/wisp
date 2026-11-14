//! `wisp_plugin_check` (ADR-0048): a plugin validated without installing it, every problem at once.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_kernel::CommandInfo;
use wisp_plugins_core::check::{check, entries};

fn cmd(id: &str, permission: &str, read_only: bool) -> CommandInfo {
    CommandInfo {
        id: id.into(),
        plugin: "wisp.plugins".into(),
        title: Some("Which plugins this wisp has".into()),
        read_only,
        permission: permission.into(),
        args: None,
        ui_only: None,
    }
}

fn catalogue() -> Vec<CommandInfo> {
    vec![cmd("plugins.list", "plugins:read", true), cmd("plugins.setEnabled", "plugins:write", false)]
}

fn files(f: &[(&str, &str)]) -> BTreeMap<String, String> {
    f.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
}

fn pane(id: &str, perms: &Value) -> Value {
    json!({
        "wispPlugin": 1, "id": id, "name": "Mine", "version": "1.0.0", "api": "^1", "permissions": perms,
        "contributes": { "ui": [{ "id": format!("{id}.pane"), "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./ui.js#default", "title": "Mine" }] }
    })
}

#[test]
fn a_good_plugin_checks_ok_and_says_what_it_does_in_plain_words() {
    let ui = "wisp.on('go', () => wisp.call('plugins.list', {}).then((r) => wisp.render({ c: 'Text', k: [String(r.length)] })));\nwisp.render({ c: 'Button', p: { label: 'Go' }, on: 'go' });";
    let r = check(&pane("user.mine", &json!(["plugins:read"])), &files(&[("ui.js", ui)]), &catalogue());
    assert!(r.ok, "{}", r.text());
    let t = r.text();
    assert!(t.starts_with("ok: Mine (user.mine) would install. What it does:"), "{t}");
    assert!(t.contains("- shows a pane in Settings → Advanced “Mine”, drawn from ui.js"), "{t}");
    assert!(t.contains("- calls plugins.list (Which plugins this wisp has), which only reads"), "{t}");
    assert!(t.contains("- may run 1 command with \"plugins:read\""), "{t}");
}

#[test]
fn a_check_lists_every_problem_at_once() {
    let mut m = pane("acme.mine", &json!(["plugins:read"]));
    m["colour"] = json!("red");
    m["contributes"]["ui"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "acme.mine.frame", "attachTo": { "id": "shell.frame", "input": "main" }, "component": "./ui.js#default" }));
    m["contributes"]["ui"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": "acme.mine.side", "attachTo": { "id": "shell.side", "input": "view" }, "component": "./side.js#default" }));
    let ui = "document.body.innerHTML = '<b>hi</b>';\nfetch('https://x.test');\nlocalStorage.x = 1;\nwisp.watch('t');\nwisp.render({ c: 'div', k: [{ c: 'Stack' }] });\nwisp.call('plugins.setEnabled', { id: 'x' });\nwisp.call('nope.cmd');";
    let r = check(&m, &files(&[("ui.js", ui)]), &catalogue());
    assert!(!r.ok);
    let t = r.text();
    let want = [
        "colour",                                // the kernel's checker: an unknown key, by path
        "id: acme.mine isn't a plugin of yours", // a user. id
        "\"shell.frame\" isn't where an untrusted plugin may show",
        "contributes.ui[2]: side.js isn't given", // a module that isn't passed
        "ui.js uses `document`",
        "ui.js calls fetch",
        "ui.js uses browser storage",
        "ui.js writes HTML",
        "ui.js uses wisp.watch: its wisp has only wisp.render, wisp.call, wisp.on",
        "ui.js names `div`, which isn't a kit component",
        "ui.js calls plugins.setEnabled, which needs \"plugins:write\": add it to permissions",
        "ui.js calls nope.cmd, which isn't a command wisp has",
    ];
    for w in want {
        assert!(t.contains(w), "missing “{w}” in:\n{t}");
    }
    assert!(t.starts_with(&format!("{} problems to fix in Mine (acme.mine):\n1. ", r.problems.len())), "{t}");
    assert!(t.contains("wisp doesn't draw a side view for plugins yet"), "a note, not a problem: {t}");
}

#[test]
fn a_plugin_that_does_nothing_or_isnt_a_manifest_is_refused() {
    let r = check(&json!({ "wispPlugin": 1, "id": "user.empty", "version": "1.0.0", "api": "^1" }), &BTreeMap::new(), &catalogue());
    assert!(r.problems.iter().any(|p| p == "it does nothing: no UI, no server and no contributions"), "{}", r.text());
    let r = check(&json!("not json"), &BTreeMap::new(), &catalogue());
    assert_eq!(r.problems, vec!["manifest must be the whole wisp-plugin.json, as a JSON object".to_owned()]);
    let mut kit_only = pane("user.k", &json!([]));
    kit_only["contributes"]["ui"][0].as_object_mut().unwrap().remove("component");
    kit_only["contributes"]["ui"][0]["kit"] = json!({ "c": "Text", "k": ["hi"] });
    let r = check(&kit_only, &BTreeMap::new(), &catalogue());
    assert!(r.text().contains("a kit descriptor in the manifest isn't drawn for an untrusted plugin"), "{}", r.text());
}

#[test]
fn trust_in_the_manifest_is_only_a_note_and_a_server_is_said_in_words() {
    let mut m = pane("user.srv", &json!([]));
    m["trust"] = json!("trusted");
    m["server"] = json!({ "exec": ["node", "server.js"] });
    let r = check(&m, &files(&[("ui.js", "wisp.render('hi');")]), &catalogue());
    assert!(r.ok, "{}", r.text());
    assert!(r.does.iter().any(|d| d.starts_with("runs its own process `node server.js` in its folder")), "{:?}", r.does);
    assert!(r.notes.iter().any(|n| n.starts_with("trust is ignored on install")), "{:?}", r.notes);
}

#[test]
fn ui_entries_are_what_plugins_ui_serves_attach_to_in_either_form() {
    let c: BTreeMap<String, Value> = [(
        "ui".to_owned(),
        json!([
            { "id": "a", "attachTo": "shell.settings:pane", "component": "./ui.js#default", "title": "A" },
            { "id": "b", "attachTo": { "id": "shell.frame", "input": "main" }, "component": "./ui.js#default" },
            { "id": "c", "attachTo": { "id": "shell.side", "input": "view" }, "component": "./../x.js#default" }
        ]),
    )]
    .into_iter()
    .collect();
    assert_eq!(entries(&c), vec![("a".into(), "shell.settings".into(), "A".into(), "ui.js".into())]);
}

#[test]
fn a_check_reads_what_the_code_does_not_what_its_text_says() {
    let ui = "// fetch('x') and document.body are only words here\n/* window.open() */\nconst rows = (all) => all.filter((r) => r.id !== 'wisp.plugins');\nwisp\n  .render({ c: 'Stack', k: [{ c: 'Text', k: ['Open the document. Close this window.'] }, `import your settings\nfrom fetch(…)`] });";
    let r = check(&pane("user.mine", &json!([])), &files(&[("ui.js", ui)]), &catalogue());
    assert!(r.ok, "{}", r.text());
    let code = wisp_plugins_core::check::code_only("a('x\\'y') // z\nb");
    assert_eq!(code.len(), "a('x\\'y') // z\nb".len());
    assert_eq!(code, "a('    ')     \nb");
}

#[test]
fn a_plugins_own_commands_are_its_own_to_call_and_a_run_time_id_is_a_note() {
    let mut m = pane("user.mine", &json!([]));
    m["server"] = json!({ "exec": ["./server"] });
    m["contributes"]["commands"] = json!([{ "id": "user.mine.refresh", "title": "Refresh" }]);
    let ui = "const id = 'user.mine';\nwisp.call('user.mine.refresh');\nwisp.call(`${id}.other`);\nwisp.render('ok');";
    let r = check(&m, &files(&[("ui.js", ui)]), &catalogue());
    assert!(r.ok, "{}", r.text());
    assert!(r.does.iter().any(|d| d == "calls its own command user.mine.refresh"), "{:?}", r.does);
    assert!(r.notes.iter().any(|n| n.contains("calls a command named at run time")), "{:?}", r.notes);
}
