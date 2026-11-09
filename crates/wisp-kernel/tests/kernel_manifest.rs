//! Manifest validation (plan §6.2).
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
use wisp_kernel::Manifest;

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
    assert!(has("buttons", "unknown key"), "{e:?}");
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

#[test]
fn a_ui_only_without_a_reason_is_refused() {
    let with = |u: Value| errors(&json!({ "wispPlugin": 1, "id": "acme.x", "version": "1.0.0", "api": "^1", "contributes": { "commands": [{ "id": "x.pick", "title": "Pick", "uiOnly": u }] } }));
    assert!(with(json!("")).iter().any(|(p, m)| p == "contributes.commands[0].uiOnly" && m.contains("says why")));
    assert!(with(json!(true)).iter().any(|(p, _)| p == "contributes.commands[0].uiOnly"));
    assert_eq!(with(json!("a drag on the canvas; there's nothing to type")), Vec::new());
}
