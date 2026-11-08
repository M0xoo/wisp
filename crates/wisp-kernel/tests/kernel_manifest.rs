//! Manifest validation (plan §6.2) and v1 spell conversion (plan §6.0.1).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names,
    clippy::case_sensitive_file_extension_comparisons
)]
mod common;

use serde_json::{Value, json};
use wisp_kernel::spell::{convert_spell, slot_input, spell_plugin_id};
use wisp_kernel::{Manifest, PluginGroup};

fn errors(v: &Value) -> Vec<(String, String)> {
    Manifest::check(v)
        .into_iter()
        .map(|e| (e.path, e.message))
        .collect()
}

fn ok() -> Value {
    json!({
        "wispPlugin": 1, "id": "wisp.claude", "version": "2.0.0", "api": "^1", "kind": "module", "extends": "wisp.runtime",
        "requires": { "wisp.git": { "version": "^2", "optional": true }, "git.service": "^1" },
        "permissions": ["proc:spawn{bin:claude}", "fs:read{scope:workspace}", "net:none", "secrets:read{key:claude.*}"],
        "server": { "builtin": "wisp_claude" },
        "activation": ["onCommand:runtime.start{harness:claude}", "onTopic:session:*", "onRoute:GET /api/claude/*"],
        "contributes": {
            "runtime.harness": [{ "id": "claude", "label": "Claude Code" }],
            "settings": [{ "key": "claude.model", "type": "enum", "values": ["auto", "opus"], "default": "auto", "overridable": true }],
            "commands": [{ "id": "claude.login", "title": "Sign in to Claude Code" }],
            "ui": [{ "id": "claude.model-picker", "attachTo": "shell.composer:left", "component": "./ui#ModelPicker", "if": "session.harness == 'claude'" }],
            "parts": ["claude.badge"], "icons": ["claude"], "blocks": []
        },
        "migrations": "migrations/", "qa": "qa/"
    })
}

#[test]
fn the_plan_example_is_valid() {
    assert_eq!(errors(&ok()), Vec::new());
    let m = Manifest::from_value(ok()).unwrap();
    assert_eq!(m.settings()[0].key, "claude.model");
    assert_eq!(m.ui()[0].attach_to.input, "left");
    assert!(!m.eager());
    assert_eq!(m.requirements().iter().filter(|r| r.optional).count(), 1);
}

#[test]
fn every_problem_has_its_path() {
    let mut v = ok();
    v["permisions"] = json!([]);
    v["buttons"] = json!([]);
    v["version"] = json!("2");
    v["permissions"] = json!(["proc"]);
    v["activation"] = json!(["onBoot"]);
    v["contributes"]["settings"][0]["type"] = json!("float");
    v["contributes"]["settings"][0]["colour"] = json!(1);
    v["contributes"]["commands"][0]["id"] = json!("git.push");
    v["contributes"]["ui"][0]["attachTo"] = json!(7);
    v["contributes"]["unknown"] = json!(1);
    v["requires"]["wisp.git"]["optinal"] = json!(true);
    let e = errors(&v);
    let has = |path: &str, needle: &str| e.iter().any(|(p, m)| p == path && m.contains(needle));
    assert!(has("permisions", "did you mean \"permissions\""), "{e:?}");
    assert!(has("buttons", "a wispSpell key"), "{e:?}");
    assert!(has("version", "semver"), "{e:?}");
    assert!(has("permissions[0]", "no ':'"), "{e:?}");
    assert!(has("activation[0]", "not an activation event"), "{e:?}");
    assert!(
        has("contributes.settings[0].type", "must be one of"),
        "{e:?}"
    );
    assert!(
        has("contributes.settings[0].colour", "unknown key"),
        "{e:?}"
    );
    assert!(
        has("contributes.commands[0].id", "this plugin's prefix"),
        "{e:?}"
    );
    assert!(has("contributes.ui[0].attachTo", "{id, input}"), "{e:?}");
    assert!(has("contributes.unknown", "unknown key"), "{e:?}");
    assert!(
        has("requires.wisp.git.optinal", "did you mean \"optional\""),
        "{e:?}"
    );
    let err = Manifest::from_value(v).unwrap_err();
    assert_eq!(err.code, wisp_kernel::Code::Invalid);
    assert!(err.details.unwrap()["errors"].as_array().unwrap().len() >= 11);
}

#[test]
fn relations_and_settings_rules() {
    let base = |extra: Value| {
        let mut v = json!({ "wispPlugin": 1, "id": "acme.x", "version": "1.0.0", "api": "^1" });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        errors(&v)
    };
    assert!(
        base(json!({ "kind": "module" }))
            .iter()
            .any(|(p, _)| p == "extends")
    );
    assert!(
        base(json!({ "extends": "wisp.runtime" }))
            .iter()
            .any(|(p, _)| p == "kind")
    );
    assert!(
        base(json!({ "server": { "exec": [] } }))
            .iter()
            .any(|(p, _)| p == "server")
    );
    assert_eq!(
        base(json!({ "server": { "exec": ["bin/x", "--y"] } })),
        [] as [(std::string::String, std::string::String); 0]
    );
    assert!(
        base(json!({ "provides": { "x.service": { "version": "1" } } }))
            .iter()
            .any(|(p, _)| p == "provides.x.service")
    );
    let s = |d: Value| base(json!({ "contributes": { "settings": [d] } }));
    assert!(
        s(json!({ "key": "x.n", "type": "int", "min": 5, "max": 1 }))
            .iter()
            .any(|(p, _)| p.ends_with(".min"))
    );
    assert!(
        s(json!({ "key": "x.n", "type": "int", "max": 3, "default": 9 }))
            .iter()
            .any(|(p, m)| p.ends_with(".default") && m.contains("at most 3"))
    );
    assert!(
        s(json!({ "key": "x.e", "type": "enum" }))
            .iter()
            .any(|(p, _)| p.ends_with(".values"))
    );
    assert!(
        s(json!({ "key": "y.n", "type": "int" }))
            .iter()
            .any(|(p, _)| p.ends_with(".key"))
    );
    assert!(
        s(json!({ "key": "x.d", "type": "bool", "scope": "phone" }))
            .iter()
            .any(|(p, _)| p.ends_with(".scope"))
    );
    assert!(
        base(json!({ "contributes": { "setSettings": { "x.own": 1 } } }))
            .iter()
            .any(|(_, m)| m.contains("own setting"))
    );
    assert!(base(json!({ "contributes": { "points": [{ "id": "x.list", "version": 0, "kind": "list" }] } })).iter().any(|(p, _)| p.ends_with(".version")));
    assert!(errors(&json!("nope")).iter().any(|(p, _)| p.is_empty()));
}

#[test]
fn an_invalid_embedded_manifest_is_refused_with_why() {
    let m = Manifest::embedded(r#"{"wispPlugin":1,"id":"acme.x","version":"x","api":"^1"}"#);
    assert_eq!(m.id, "invalid.manifest");
    assert!(m.validate().is_err());
}

fn spells() -> (Value, Value, Value, Value) {
    let my_prs = json!({
        "wispSpell": 1, "id": "my-prs", "name": "My PRs", "version": "1.0.0", "author": "", "harnesses": ["*"],
        "data": { "prs": { "gh": ["search", "prs", "--author", "@me", "--state", "open"], "refresh": 120 } },
        "buttons": [{ "id": "my-prs-btn", "slot": "float", "label": "My PRs", "icon": "github", "badge": { "count": "prs" }, "do": { "openAll": { "data": "prs", "field": "url" } } }]
    });
    let usage = json!({
        "wispSpell": 1, "id": "claude-usage", "name": "Claude usage", "harnesses": ["claude"], "when": { "hasPr": true },
        "data": { "today": { "wisp": "/usage", "refresh": 60 } },
        "buttons": [{ "id": "open", "slot": "topbar", "label": "Usage", "do": { "panel": "claude-usage" } }],
        "chips": [{ "label": "chip with no id or slot" }],
        "panels": [{ "id": "claude-usage", "title": "Claude usage", "as": "dialog" }, { "id": "in-card", "as": "card", "slot": "card.top" }, { "id": "home", "as": "feed" }, { "id": "side" }],
        "blocks": [{ "type": "usage-chart", "fn": "chart" }],
        "script": "export function usage() { return {} }"
    });
    let theme = json!({
        "wispSpell": 1, "id": "windows-95", "name": "Windows 95", "version": "not-semver",
        "parts": { "topbar": { "style": { "background": "#000080" } }, "card.menu": { "hide": true }, "list.rows": { "compact": true } },
        "ui": { "tokens": { "--bg": "#008080" }, "dark": { "--bg": "#000" }, "hide": ["topbar.brand"] },
        "settings": { "theme": "light" }
    });
    let grid = json!({
        "wispSpell": 1, "id": "grid-users", "name": "Grid users", "harnesses": ["*"],
        "commands": [{ "id": "k0", "label": "Check wisp Grid users", "do": { "recipe": "Grid users" } }, { "label": "no id" }],
        "recipes": [{ "id": "r0", "name": "Grid users", "prompt": "check the users" }],
        "hooks": [{ "on": "finished", "do": "notify" }], "slash": [{ "name": "grid" }], "prompt": "Be brief.", "crew": [{ "name": "ops" }],
        "wisp": "1.40.0", "sparkles": true
    });
    (my_prs, usage, theme, grid)
}

#[test]
fn spells_convert() {
    let (my_prs, usage, theme, grid) = spells();
    let m = convert_spell(&my_prs).unwrap().manifest;
    assert_eq!(m.id, "user.my-prs");
    assert_eq!(m.trust.as_deref(), Some("declarative"));
    assert_eq!(m.permissions, vec!["gh:read{cmd:search prs}"]);
    let ui = m.ui();
    assert_eq!(ui[0].id, "my-prs.my-prs-btn");
    assert_eq!(
        (ui[0].attach_to.id.as_str(), ui[0].attach_to.input.as_str()),
        ("shell", "float")
    );
    assert_eq!(ui[0].kit.as_ref().unwrap()["c"], "Button");
    assert_eq!(ui[0].when, None);
    assert_eq!(
        m.contributes["shell.data"],
        json!([{ "name": "prs", "gh": my_prs["data"]["prs"]["gh"], "refresh": 120 }])
    );
    assert!(m.requires.is_empty());

    let m = convert_spell(&usage).unwrap().manifest;
    assert_eq!(m.trust.as_deref(), Some("untrusted"));
    assert_eq!(
        m.requires["wisp.claude"],
        json!({ "version": "*", "optional": true })
    );
    assert_eq!(m.permissions, vec!["topic:read{path:/usage}"]);
    let at: Vec<String> = m
        .ui()
        .iter()
        .map(|x| format!("{} {}:{}", x.id, x.attach_to.id, x.attach_to.input))
        .collect();
    assert_eq!(
        at,
        [
            "claude-usage.open shell:topbar",
            "claude-usage.chip0 shell.composer:chips",
            "claude-usage.claude-usage shell:dialogs",
            "claude-usage.in-card shell.card:top",
            "claude-usage.home shell.home:feed",
            "claude-usage.side shell:panes"
        ]
    );
    assert_eq!(
        m.ui()[0].when.as_deref(),
        Some("session.harness in ['claude'] && session.hasPr == true")
    );
    assert_eq!(m.contributes["blocks"], json!([{ "type": "usage-chart" }]));
    assert_eq!(
        m.contributes["shell.blocks"],
        json!([{ "type": "usage-chart", "fn": "chart" }])
    );

    let m = convert_spell(&theme).unwrap().manifest;
    assert_eq!(m.version, "1.0.0");
    assert_eq!(
        m.contributes["partStyles"],
        json!({ "topbar": { "background": "#000080" }, "card.menu": { "display": "none" }, "topbar.brand": { "display": "none" } })
    );
    assert_eq!(
        m.contributes["shell.partProps"],
        json!([{ "list.rows": { "compact": true } }])
    );
    assert_eq!(
        m.contributes["shell.tokens"],
        json!([{ "tokens": { "--bg": "#008080" }, "dark": { "--bg": "#000" } }])
    );
    assert_eq!(
        m.contributes["setSettings"],
        json!({ "shell.theme": "light" })
    );

    let c = convert_spell(&grid).unwrap();
    let m = c.manifest;
    assert_eq!(
        m.contributes["commands"],
        json!([{ "id": "grid-users.k0", "title": "Check wisp Grid users" }, { "id": "grid-users.k1", "title": "no id" }])
    );
    assert_eq!(
        m.contributes["shell.actions"][0]["command"],
        "grid-users.k0"
    );
    assert_eq!(m.contributes["runtime.hooks"], grid["hooks"]);
    assert_eq!(
        m.contributes["runtime.prompt"],
        json!([{ "text": "Be brief." }])
    );
    assert_eq!(m.contributes["crew.members"], grid["crew"]);
    assert!(c.warnings.iter().any(|w| w.starts_with("sparkles:")));
    assert!(c.warnings.iter().any(|w| w.starts_with("wisp:")));
}

#[test]
fn what_is_not_a_spell_is_refused() {
    assert!(convert_spell(&Value::Null).is_err());
    assert!(convert_spell(&json!({ "wispSpell": 2, "id": "a" })).is_err());
    assert_eq!(
        convert_spell(&json!({ "wispSpell": 1, "id": "-bad" })).unwrap_err()[0].path,
        "id"
    );
    assert_eq!(
        slot_input("composer.bar"),
        ("shell.composer".into(), "bar".into())
    );
    assert_eq!(slot_input("float"), ("shell".into(), "float".into()));
}

#[tokio::test]
async fn a_converted_spell_loads_and_locks_the_setting_it_sets() {
    let shell = common::bare(
        "wisp.shell",
        json!({ "contributes": {
        "settings": [{ "key": "shell.theme", "type": "enum", "values": ["system", "light", "dark"], "default": "system", "overridable": true }],
        "points": [{ "id": "shell.tokens", "version": 1, "kind": "list" }]
    } }),
    );
    let theme = convert_spell(&spells().2).unwrap().manifest;
    let k = common::start(
        PluginGroup::new()
            .add(shell)
            .add(wisp_kernel::Declarative(theme)),
    )
    .await;
    let id = spell_plugin_id("windows-95");
    assert_eq!(k.setting("shell.theme"), Some(json!("light")));
    assert_eq!(
        k.setting_info("shell.theme").unwrap().locked_by.as_deref(),
        Some(id.as_str())
    );
    assert!(
        k.set_setting("shell.theme", Some(json!("dark"))).is_err(),
        "locked"
    );
    assert_eq!(k.declared("shell.tokens").len(), 1);
    assert_eq!(common::state(&k, &id).0, "active");
    k.set_enabled(&id, false).await.unwrap();
    assert_eq!(k.setting("shell.theme"), Some(json!("system")));
    assert_eq!(k.declared("shell.tokens").len(), 0);
    k.set_setting("shell.theme", Some(json!("dark"))).unwrap();
    assert!(k.set_setting("shell.theme", Some(json!("purple"))).is_err());
    assert_eq!(k.setting("shell.theme"), Some(json!("dark")));
}
