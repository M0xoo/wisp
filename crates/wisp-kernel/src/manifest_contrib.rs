//! `contributes` in a manifest (plan §6.2, §6.6): commands, events, points, settings declared and set,
//! UI extensions with `attachTo`, parts and their styles, blocks, recipes, and contributions to other
//! plugins' points (any `owner.point` key, plain JSON).
use serde_json::{Map, Value};

use crate::caps::owned_by;
use crate::manifest_check::{Problems, attach_to, contrib_keys, is_point_key, owned, setting_types, string_list, unknown_keys};

pub(crate) fn contributes(v: &Value, pid: &str, p: &mut Problems) {
    let Some(o) = v.as_object() else {
        return p.add("contributes", "must be an object");
    };
    for k in o.keys() {
        if !contrib_keys().contains(&k.as_str()) && !is_point_key(k) {
            let single: Map<String, Value> = std::iter::once((k.clone(), Value::Null)).collect();
            unknown_keys(&single, contrib_keys(), "contributes", p);
        }
    }
    commands(o.get("commands"), pid, p);
    events(o.get("events"), pid, p);
    for k in ["topics", "parts", "icons"] {
        let own = k == "parts";
        string_list(o.get(k), &format!("contributes.{k}"), p, &mut |s, at, p| {
            if own && !owned_by(s, pid) && !pid.is_empty() {
                owned(Some(&Value::from(s)), pid, at, p, k);
            }
        });
    }
    points(o.get("points"), pid, p);
    settings(o.get("settings"), pid, p);
    set_settings(o.get("setSettings"), pid, p);
    ui(o.get("ui"), p);
    misc(o, p);
}

/// `contributes.events` (ADR-0044): the types this plugin emits, as a type or
/// `{ type, durable, title, subject, key }`. Types are named by area (`pr.opened`, `turn.finished`), not by
/// plugin, so any plugin may emit any area's; `tools/check` (rust-events) holds the list to the code.
fn events(v: Option<&Value>, _pid: &str, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add("contributes.events", "must be a list of types or {type, durable, title}");
    };
    for (i, e) in list.iter().enumerate() {
        let at = format!("contributes.events[{i}]");
        let ty = match e {
            Value::String(_) => e.clone(),
            Value::Object(o) => {
                unknown_keys(o, &["type", "durable", "title", "subject", "key", "schema", "until"], &at, p);
                if o.get("durable").is_some_and(|d| !d.is_boolean()) {
                    p.add(format!("{at}.durable"), "must be true or false");
                }
                o.get("type").cloned().unwrap_or(Value::Null)
            }
            _ => {
                p.add(at, "must be a type or {type, durable, title}");
                continue;
            }
        };
        if ty.as_str().is_none_or(str::is_empty) {
            p.add(format!("{at}.type"), "must be the event's type");
        }
    }
}

fn commands(v: Option<&Value>, pid: &str, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add("contributes.commands", "must be a list of {id, title}");
    };
    let mut seen: Vec<&str> = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let at = format!("contributes.commands[{i}]");
        let Some(c) = c.as_object() else {
            p.add(at, "must be {id, title}");
            continue;
        };
        unknown_keys(c, &["id", "title", "optimistic", "readOnly", "permission", "uiOnly"], &at, p);
        if !owned(c.get("id"), pid, &format!("{at}.id"), p, "id") {
            continue;
        }
        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
        if seen.contains(&id) {
            p.add(format!("{at}.id"), format!("\"{id}\" is listed twice"));
        }
        seen.push(id);
        if c.get("title").and_then(Value::as_str).is_none_or(str::is_empty) {
            p.add(format!("{at}.title"), "every command has a title (the palette shows it)");
        }
        // ADR-0040: a command that isn't an MCP tool says why
        if c.get("uiOnly").is_some_and(|u| u.as_str().is_none_or(|w| w.trim().len() < 8)) {
            p.add(format!("{at}.uiOnly"), "a command left out of the MCP tools says why (a sentence: what only a screen can do)");
        }
        if c.get("optimistic").is_some_and(|o| o != "none" && o != "declared") {
            p.add(format!("{at}.optimistic"), "must be \"none\" or \"declared\"");
        }
        if c.get("readOnly").is_some_and(|x| !x.is_boolean()) {
            p.add(format!("{at}.readOnly"), "must be true or false");
        }
        if let Some(perm) = c.get("permission") {
            match perm.as_str() {
                Some(s) => {
                    crate::manifest_check::check_permission(s, &format!("{at}.permission"), p);
                }
                None => p.add(format!("{at}.permission"), "must be a permission string"),
            }
        }
    }
}

fn points(v: Option<&Value>, pid: &str, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add("contributes.points", "must be a list of {id, version, kind}");
    };
    for (i, x) in list.iter().enumerate() {
        let at = format!("contributes.points[{i}]");
        let Some(x) = x.as_object() else {
            p.add(at, "must be {id, version, kind}");
            continue;
        };
        unknown_keys(x, &["id", "version", "kind"], &at, p);
        owned(x.get("id"), pid, &format!("{at}.id"), p, "id");
        if x.get("version").and_then(Value::as_u64).is_none_or(|v| v < 1) {
            p.add(format!("{at}.version"), "every extension point has a version: a whole number from 1");
        }
        if !matches!(x.get("kind").and_then(Value::as_str), Some("list" | "interceptor" | "subscriber")) {
            p.add(format!("{at}.kind"), "must be \"list\", \"interceptor\" or \"subscriber\"");
        }
    }
}

fn settings(v: Option<&Value>, pid: &str, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add("contributes.settings", "must be a list of setting declarations");
    };
    for (i, d) in list.iter().enumerate() {
        let at = format!("contributes.settings[{i}]");
        let Some(d) = d.as_object() else {
            p.add(at, "must be {key, type, …}");
            continue;
        };
        unknown_keys(d, &["key", "type", "values", "min", "max", "default", "overridable", "scope", "secret", "title"], &at, p);
        owned(d.get("key"), pid, &format!("{at}.key"), p, "key");
        let ty = d.get("type").and_then(Value::as_str).unwrap_or_default();
        if !setting_types().contains(&ty) {
            p.add(format!("{at}.type"), format!("must be one of {}", setting_types().join(", ")));
        }
        if ty == "enum"
            && !d
                .get("values")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty())))
        {
            p.add(format!("{at}.values"), "an enum lists its values");
        }
        for k in ["min", "max"] {
            if d.get(k).is_some_and(|x| !x.is_number()) {
                p.add(format!("{at}.{k}"), "must be a number");
            }
        }
        if let (Some(lo), Some(hi)) = (d.get("min").and_then(Value::as_f64), d.get("max").and_then(Value::as_f64))
            && lo > hi
        {
            p.add(format!("{at}.min"), "is above max");
        }
        if d.get("scope").is_some_and(|s| s != "server" && s != "device") {
            p.add(format!("{at}.scope"), "must be \"server\" or \"device\"");
        }
        for k in ["overridable", "secret"] {
            if d.get(k).is_some_and(|x| !x.is_boolean()) {
                p.add(format!("{at}.{k}"), "must be true or false");
            }
        }
        if let (Some(default), Ok(decl)) =
            (d.get("default"), serde_json::from_value::<crate::manifest::SettingDecl>(Value::Object(d.clone())))
            && let Some(why) = decl.problem(default)
        {
            p.add(format!("{at}.default"), why);
        }
    }
}

fn set_settings(v: Option<&Value>, pid: &str, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(o) = v.as_object() else {
        return p.add("contributes.setSettings", "must map other plugins' setting keys to values");
    };
    for k in o.keys() {
        if !pid.is_empty() && owned_by(k, pid) {
            p.add(format!("contributes.setSettings.{k}"), "is this plugin’s own setting: give it a default instead");
        }
    }
}

fn ui(v: Option<&Value>, p: &mut Problems) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add("contributes.ui", "must be a list of extensions");
    };
    for (i, x) in list.iter().enumerate() {
        let at = format!("contributes.ui[{i}]");
        let Some(x) = x.as_object() else {
            p.add(at, "must be {id, attachTo, …}");
            continue;
        };
        unknown_keys(x, &["id", "attachTo", "component", "kit", "config", "if", "priority", "title"], &at, p);
        // any id: reusing another plugin's extension id is how an override replaces it (plan §6.0.3)
        if x.get("id").and_then(Value::as_str).is_none_or(str::is_empty) {
            p.add(format!("{at}.id"), "id must be a non-empty string");
        }
        attach_to(x.get("attachTo"), &format!("{at}.attachTo"), p);
        if let Some(c) = x.get("component")
            && !c.as_str().is_some_and(component_ok)
        {
            p.add(format!("{at}.component"), "must be \"./path#Export\" inside the plugin’s ui package");
        }
        if x.get("component").is_none() && x.get("kit").is_none() {
            p.add(&at, "an extension has a component or a kit descriptor");
        }
        if x.get("if").is_some_and(|v| !v.is_string()) {
            p.add(format!("{at}.if"), "must be an expression string");
        }
        if x.get("priority").is_some_and(|v| !v.is_number()) {
            p.add(format!("{at}.priority"), "must be a number");
        }
    }
}

/// `./path#Export` inside the plugin's ui package.
fn component_ok(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("./") else {
        return false;
    };
    let (path, export) = rest.split_once('#').map_or((rest, None), |(a, b)| (a, Some(b)));
    !path.is_empty()
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-'))
        && export.is_none_or(|e| !e.is_empty() && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

fn misc(o: &Map<String, Value>, p: &mut Problems) {
    if let Some(s) = o.get("partStyles")
        && !s.as_object().is_some_and(|m| m.values().all(|x| x.as_object().is_some_and(|y| y.values().all(Value::is_string))))
    {
        p.add("contributes.partStyles", "must map part names to {property: value}");
    }
    if let Some(b) = o.get("blocks")
        && !b.as_array().is_some_and(|a| {
            a.iter().all(|x| {
                x.as_object().is_some_and(|m| m.get("type").is_some_and(Value::is_string) && m.keys().all(|k| k == "type" || k == "schema"))
            })
        })
    {
        p.add("contributes.blocks", "must be a list of {type, schema?}");
    }
    if o.get("triggerSources").is_some_and(|r| {
        !r.as_array().is_some_and(|a| a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty() && !s.contains(char::is_whitespace))))
    }) {
        p.add("contributes.triggerSources", "must be a list of trigger source names (`ci.failed`)");
    }
    if o.get("recipes").is_some_and(|r| !r.is_array()) {
        p.add("contributes.recipes", "must be a list of plain JSON recipes");
    }
}
