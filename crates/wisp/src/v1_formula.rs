//! v1's `~/.wisp/config.json` as a formula's resources (ADR-0026: `wisp import` is "export v1 as a
//! formula, then apply", so it shows its plan first). v1 kept one config file:
//! `{ projects, defaults, recipes, triggers, teams, crew, remote, machines, connectors }`. Tasks are
//! history, not configuration: their sessions are imported apart (`runtime.import`).
//!
//! Secrets are never copied into a formula: a connector's environment and a channel's token become
//! `${secret:…}` references only when the secret is already here; otherwise they're left out and named
//! in the notes.

use serde_json::{Map, Value, json};
use wisp_resources_api::Resource;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `fields` of `v` that are set (not empty), renamed `(from, to)`.
fn pick(v: &Value, fields: &[(&str, &str)]) -> Map<String, Value> {
    let mut o = Map::new();
    for (from, to) in fields {
        if let Some(x) = v.get(*from).filter(|x| !(x.is_null() || **x == json!("") || **x == json!([]) || **x == json!({}))) {
            o.insert((*to).to_owned(), x.clone());
        }
    }
    o
}

/// A name a formula can use (lowercase, dashes): v1 names are free text.
fn name_of(v: &Value, fallback: &str) -> String {
    let n = s(v, "name");
    let n = if n.is_empty() { fallback } else { n };
    let mut out = String::new();
    for c in n.chars() {
        if c.is_alphanumeric() || "-_.".contains(c) {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let t = out.trim_end_matches('-');
    if t.is_empty() { fallback.to_owned() } else { t.to_owned() }
}

/// The resources v1's config declares, and notes on what didn't carry over.
pub fn formula_of(cfg: &Value) -> (Vec<Resource>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    let list = |k: &str| cfg.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    for p in list("projects") {
        let spec = pick(&p, &[("path", "path"), ("color", "color"), ("agent", "agent")]);
        if spec.contains_key("path") {
            out.push(Resource::new("project", name_of(&p, "project"), Value::Object(spec)));
        }
    }
    let d = cfg.get("defaults").cloned().unwrap_or_default();
    let mut def = pick(&d, &[("model", "model"), ("effort", "effort"), ("mode", "mode"), ("subagentModel", "subagentModel")]);
    if !s(&d, "agent").is_empty() {
        def.insert("harness".into(), json!(s(&d, "agent")));
    }
    if !def.is_empty() {
        out.push(Resource::new("agent", "default", Value::Object(def)));
    }
    // the defaults that are settings now (wisp-settings-api V1_ALIASES)
    for (v1, key) in wisp_settings_api_aliases() {
        if let Some(v) = d.get(v1).filter(|v| !v.is_null()) {
            out.push(Resource::new("setting", key, v.clone()));
        }
    }
    for r in list("recipes") {
        let spec = pick(
            &r,
            &[("prompt", "prompt"), ("cwd", "project"), ("agent", "agent"), ("model", "model"), ("effort", "effort"), ("mode", "mode")],
        );
        out.push(Resource::new("task", name_of(&r, "recipe"), Value::Object(spec)));
    }
    triggers_of(list("triggers"), &mut out, &mut notes);
    for t in list("teams") {
        let mut members = Map::new();
        for (i, m) in t.get("members").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let mut slot = pick(m, &[("count", "count"), ("why", "why")]);
            let agent = if s(m, "agent").is_empty() { "auto" } else { s(m, "agent") };
            slot.insert("agent".into(), json!(agent));
            members.insert(name_of(m, &format!("member-{}", i + 1)), Value::Object(slot));
        }
        out.push(Resource::new("team", name_of(&t, "team"), json!({ "members": members })));
    }
    for m in list("crew") {
        let mut spec = pick(
            &m,
            &[
                ("role", "role"),
                ("avatar", "avatar"),
                ("color", "color"),
                ("brief", "brief"),
                ("cwd", "cwd"),
                ("machine", "machine"),
                ("sandbox", "sandbox"),
                ("agent", "agent"),
                ("model", "model"),
                ("effort", "effort"),
                ("mode", "mode"),
                ("cron", "cron"),
                ("parallel", "parallel"),
                ("kit", "kit"),
                ("team", "team"),
                ("paused", "paused"),
                ("notebook", "notebook"),
            ],
        );
        // v1's `on` (finished, done, ci) is the member's wakes now (ADR-0043)
        let on: Vec<String> =
            m.get("on").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let wakes = wisp_automations_api::v1::member_wakes(s(&m, "name"), &on);
        if !wakes.is_empty() {
            spec.insert("wakes".into(), serde_json::to_value(wakes).unwrap_or_default());
        }
        out.push(Resource::new("crew", s(&m, "name"), Value::Object(spec)));
    }
    for m in list("machines") {
        let addr = ["host", "ssh", "address"].iter().map(|k| s(&m, k)).find(|x| !x.is_empty()).unwrap_or_default();
        out.push(Resource::new("machine", name_of(&m, "machine"), json!({ "transport": "ssh", "address": addr })));
    }
    for c in list("connectors") {
        let spec = pick(&c, &[("command", "command"), ("args", "args"), ("url", "url"), ("enabled", "enabled")]);
        if c.get("env").is_some_and(|e| e.as_array().is_some_and(|a| !a.is_empty()) || e.as_object().is_some_and(|o| !o.is_empty())) {
            notes.push(format!("connector {}: its environment stays in secrets; set it with wisp secret set", s(&c, "name")));
        }
        out.push(Resource::new("connector", name_of(&c, "connector"), Value::Object(spec)));
    }
    if let Some(r) = cfg.get("remote").and_then(Value::as_object) {
        for (k, v) in r.iter().filter(|(k, v)| *k != "secret" && v.is_object()) {
            let allow: Vec<Value> = ["chatId", "user", "topic"]
                .iter()
                .filter_map(|f| v.get(*f).filter(|x| !x.is_null()).map(|x| json!(x.as_str().map_or_else(|| x.to_string(), str::to_owned))))
                .collect();
            out.push(Resource::new(
                "channel",
                k.clone(),
                json!({ "transport": k, "enabled": v.get("enabled").cloned().unwrap_or(json!(true)), "allow": allow }),
            ));
            notes.push(format!("channel {k}: its token stays in secrets (${{secret:…}} when you declare it)"));
        }
    }
    (out, notes)
}

/// v1's triggers: a schedule is a declared task, every other kind the trigger source it is now.
fn triggers_of(triggers: Vec<Value>, out: &mut Vec<Resource>, notes: &mut Vec<String>) {
    for t in triggers {
        let kind = s(&t, "kind");
        if kind == "schedule" {
            // a schedule is a declared task with its schedule (ADR-0027)
            let mut spec = pick(
                &t,
                &[
                    ("prompt", "prompt"),
                    ("cwd", "project"),
                    ("agent", "agent"),
                    ("model", "model"),
                    ("effort", "effort"),
                    ("mode", "mode"),
                    ("cron", "schedule"),
                    ("crew", "crew"),
                ],
            );
            if !spec.contains_key("prompt") {
                notes.push(format!("the schedule {} runs a recipe by id: declare its prompt", s(&t, "name")));
                continue;
            }
            if t.get("enabled") == Some(&json!(false)) {
                spec.insert("paused".into(), json!(true));
            }
            out.push(Resource::new("task", name_of(&t, "schedule"), Value::Object(spec)));
        } else {
            // each of v1's kinds as the source it is now (ADR-0043: ci → ci.failed, slack → chat.message, …)
            // v1 rows leave out what they didn't set: read over a blank row
            let mut base = serde_json::to_value(wisp_automations_api::TriggerBase::default()).unwrap_or_default();
            if let (Some(b), Some(o)) = (base.as_object_mut(), t.as_object()) {
                b.extend(o.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())));
            }
            let row = serde_json::from_value::<wisp_automations_api::TriggerBase>(base).ok();
            match row.as_ref().and_then(wisp_automations_api::v1::from_v1) {
                Some((_, spec)) => out.push(Resource::new("trigger", name_of(&t, kind), serde_json::to_value(spec).unwrap_or_default())),
                None => notes.push(format!(
                    "the trigger {} is a kind v2 doesn't know ({kind}): declare it again with wisp trigger add",
                    s(&t, "name")
                )),
            }
        }
    }
}

/// v1's `defaults` names that are settings now, and their keys (as wisp-settings-api's `V1_ALIASES`).
fn wisp_settings_api_aliases() -> [(&'static str, &'static str); 6] {
    [
        ("timeZone", "settings.timeZone"),
        ("review", "review.harness"),
        ("panes", "stuff.panes"),
        ("worktreeCleanup", "worktrees.cleanup"),
        ("worktreeMax", "worktrees.max"),
        ("worktreeOnDone", "worktrees.onDone"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixture_home_becomes_resources() {
        let cfg: Value = serde_json::from_str(include_str!("../tests/fixtures/v1-home/config.json")).unwrap();
        let (rs, notes) = formula_of(&cfg);
        let names: Vec<String> = rs.iter().map(|r| format!("{}/{}", r.kind, r.name)).collect();
        for want in [
            "project/api",
            "agent/default",
            "setting/settings.timeZone",
            "task/fix-issue",
            "task/nightly",
            "trigger/ci",
            "team/review-pair",
            "crew/Ada",
            "machine/studio",
            "connector/linear",
            "channel/telegram",
        ] {
            assert!(names.iter().any(|n| n == want), "{want} in {names:?}");
        }
        let ci = rs.iter().find(|r| r.kind == "trigger" && r.name == "ci").unwrap();
        assert_eq!(
            (ci.spec["on"].as_str(), ci.spec["branch"].as_str(), ci.spec["every"].as_u64()),
            (Some("ci.failed"), Some("main"), Some(5)),
            "v1's ci is ci.failed now"
        );
        let nightly = rs.iter().find(|r| r.name == "nightly").unwrap();
        assert_eq!(nightly.spec["schedule"], "0 2 * * *");
        assert!(notes.iter().any(|n| n.contains("linear")), "{notes:?}");
    }
}
