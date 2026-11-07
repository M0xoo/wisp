//! The rest of a spell: data sources, prompt rules, settings, slash commands, ⌘K commands, hooks,
//! recipes and crew members, cleaned as v1 did.
use serde_json::{Map, Value, json};
use wisp_plugins_api::{PropType, Section};

use super::actions::{Problems, Refs, check_action};
use super::ui::MAX_ITEMS;
use crate::js::{arr, clamp_refresh, has, js_number, js_string, js_string_or, js_trim, obj, or_str, slice_utf16, str_, truncate, truthy};
use crate::rules::{gh_problem, wisp_path_problem};
use crate::schema::schema;
use crate::vocab::Vocab;

const MAX_PROMPT: usize = 600;
pub const SPELL_CREW_MAX: usize = 10;

/// Where a prompt rule, block or hook applies: `{ project, agent, mode }`, each a list.
pub fn scope_of(v: Option<&Value>) -> Option<Value> {
    let o = obj(v)?;
    let mut out = Map::new();
    for k in ["project", "agent", "mode"] {
        if has(o, k) {
            out.insert(k.into(), Value::Array(arr(o.get(k)).into_iter().map(|x| Value::from(str_(Some(x), 200))).collect()));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

fn source_name_ok(k: &str) -> bool {
    let b = k.as_bytes();
    (1..=31).contains(&b.len()) && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// data: what wisp fetches for the spell. Spell code never fetches anything itself.
pub fn data(p: &mut Problems, raw: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in obj(raw).into_iter().flatten() {
        let at = format!("data.{k}");
        let Some(x) = v.as_object().filter(|_| source_name_ok(k)) else {
            p.at(&at, "a source is { \"wisp\": \"/sessions\" } or { \"gh\": [\"pr\", \"list\", …] }");
            continue;
        };
        let refresh = clamp_refresh(x.get("refresh"));
        if has(x, "wisp") {
            if let Some(e) = wisp_path_problem(x.get("wisp")) {
                p.at(&at, e);
            }
            out.insert(k.clone(), json!({ "wisp": js_string(&x["wisp"]), "refresh": refresh }));
        } else if has(x, "gh") {
            if let Some(e) = gh_problem(x.get("gh")) {
                p.at(&at, e);
            }
            let gh: Vec<Value> = arr(x.get("gh")).into_iter().map(|a| Value::from(js_string(a))).collect();
            let mut src = json!({ "gh": gh, "refresh": refresh });
            if x.get("cwd") == Some(&json!("task")) {
                src["cwd"] = json!("task");
            }
            out.insert(k.clone(), src);
        } else {
            p.at(&at, "a source is { \"wisp\": \"/path\" } or { \"gh\": [args] }");
        }
    }
    out
}

pub fn prompt(p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, r)| {
        let (text, when) = match r {
            Value::String(s) => (s.clone(), None),
            Value::Object(o) => (if truthy(o.get("text")) { js_string(&o["text"]) } else { String::new() }, scope_of(o.get("when"))),
            _ => (String::new(), None),
        };
        let text = js_trim(&text).to_owned();
        if text.is_empty() {
            p.at(&format!("prompt[{i}]"), "needs text");
        }
        let mut o = json!({ "text": truncate(&text, MAX_PROMPT) });
        if let Some(w) = when {
            o["when"] = w;
        }
        o
    }).collect()
}

pub fn settings(p: &mut Problems, raw: Option<&Value>, warnings: &mut Vec<String>, vocab: &Vocab) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in obj(raw).into_iter().flatten() {
        // The layout switch is gone (split view is the only one): spells that set it still load.
        if k == "view" {
            warnings.push("settings.view: split view is the only layout now, ignored".into());
            continue;
        }
        // Goals have no cap on rounds any more: they go on until the check says met, can't or stalled.
        if k == "goalRounds" {
            warnings.push("settings.goalRounds: goals keep going until they are met, ignored".into());
            continue;
        }
        let at = format!("settings.{k}");
        match vocab.setting(k) {
            None => p.at(&at, format!("not a setting spells can change ({})", vocab.setting_names())),
            Some(PropType::OneOf(list)) if !v.as_str().is_some_and(|s| list.iter().any(|x| x == s)) => p.at(&at, list.join(" | ")),
            Some(PropType::Named(_)) if !v.is_string() => p.at(&at, "a string"),
            _ => match (k == "panes").then(|| wisp_stuff_api::pane::panes_problem(v)).flatten() {
                Some(e) => p.at("settings.panes", e),
                None => {
                    out.insert(k.clone(), v.clone());
                }
            },
        }
    }
    out
}

fn slash_name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    (2..=21).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn slash(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, x)| {
        let x = x.as_object().unwrap_or(&empty);
        let at = format!("slash[{i}]");
        let given = if truthy(x.get("name")) { js_string(&x["name"]) } else { String::new() };
        let name = given.strip_prefix('/').unwrap_or(&given).to_lowercase();
        if !slash_name_ok(&name) {
            p.at(&at, "name: lowercase letters, digits and dashes");
        }
        if schema().builtin_slash.contains(&name) {
            p.at(&at, format!("/{name} is built in"));
        }
        let act = check_action(x.get("do"), &at, p, r, false).unwrap_or(Value::Null);
        json!({ "name": name, "args": str_(x.get("args"), 40), "hint": str_(x.get("hint"), 80), "do": act })
    }).collect()
}

pub fn commands(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, x)| {
        let x = x.as_object().unwrap_or(&empty);
        let at = format!("commands[{i}]");
        if !truthy(x.get("label")) {
            p.at(&at, "needs a label");
        }
        let icon = match x.get("icon") {
            None => String::new(),
            Some(Value::String(s)) if s.is_empty() => String::new(),
            Some(v) => {
                if !v.as_str().is_some_and(|s| r.vocab.icons.iter().any(|i| i == s)) {
                    p.at(&at, format!("icon must be one of {}", r.vocab.icons.join(", ")));
                }
                js_string(v)
            }
        };
        let mut o = json!({ "id": str_(Some(&or_str(x.get("id"), &format!("k{i}"))), 40), "label": str_(x.get("label"), 60), "keywords": str_(x.get("keywords"), 120), "icon": icon });
        if truthy(x.get("key")) {
            o["key"] = Value::from(str_(x.get("key"), 20));
        }
        o["do"] = check_action(x.get("do"), &at, p, r, false).unwrap_or(Value::Null);
        o
    }).collect()
}

pub fn hooks(r: &Refs, p: &mut Problems, raw: Option<&Value>) -> Vec<Value> {
    let s = schema();
    let empty = Map::new();
    arr(raw).into_iter().take(MAX_ITEMS).enumerate().map(|(i, x)| {
        let x = x.as_object().unwrap_or(&empty);
        let at = format!("hooks[{i}]");
        if !x.get("on").is_some_and(|on| s.is_event(&js_string(on))) {
            p.at(&at, format!("on must be one of {}", s.event_names().join(", ")));
        }
        let cond = obj(x.get("if")).cloned().unwrap_or_default();
        for k in cond.keys() {
            if !s.hook_if.contains(k) {
                p.at(&at, format!("if.{k}: one of {}", s.hook_if.join(", ")));
            }
        }
        let n = js_number(x.get("max"));
        let max = if n == 0.0 || n.is_nan() { 1.0 } else { n.clamp(1.0, 10.0) };
        let act = check_action(x.get("do"), &at, p, r, true).unwrap_or(Value::Null);
        let mut o = json!({ "id": str_(Some(&or_str(x.get("id"), &format!("h{i}"))), 40), "if": cond, "max": crate::js::num(max), "do": act });
        if let Some(on) = x.get("on") {
            o["on"] = on.clone();
        }
        o
    }).collect()
}

fn effort_ok(e: &str) -> bool {
    e.chars().count() <= 20 && e.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// v1 recipes.js normalizeRecipe, as far as a spell's recipe goes; ids are `spell-<spell>-<id>`.
fn recipe(x: &Map<String, Value>, i: usize, spell: &str) -> Result<Value, &'static str> {
    let name = slice_utf16(js_trim(&js_string_or(x.get("name"), "")), 60).to_owned();
    let prompt = js_trim(&js_string_or(x.get("prompt"), "")).to_owned();
    if name.is_empty() {
        return Err("A recipe needs a name.");
    }
    if prompt.is_empty() {
        return Err("A recipe needs a prompt.");
    }
    let cwd = if has(x, "cwd") { if truthy(x.get("cwd")) { js_string(&x["cwd"]) } else { String::new() } } else { String::new() };
    if !cwd.is_empty() && !cwd.starts_with('/') {
        return Err("cwd must be an absolute project path (or empty for any project).");
    }
    let mode = x.get("mode").filter(|m| !m.is_null()).cloned().unwrap_or_else(|| json!(""));
    if truthy(Some(&mode)) && !mode.as_str().is_some_and(|m| ["plan", "edits", "auto"].contains(&m)) {
        return Err("mode must be plan, edits or auto.");
    }
    let pick = |k: &str| js_string_or(x.get(k), "");
    let effort = pick("effort");
    let rid: String = js_string_or(x.get("id"), &i.to_string()).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    let prefix = format!("spell-{spell}-");
    let id = if rid.starts_with(&prefix) { rid } else { format!("{prefix}{rid}") };
    Ok(json!({ "id": id, "name": name, "prompt": prompt, "cwd": cwd, "agent": pick("agent"), "model": pick("model"), "effort": if effort_ok(&effort) { effort } else { String::new() }, "mode": mode }))
}

pub fn recipes(p: &mut Problems, raw: Option<&Value>, spell: &str) -> Vec<Value> {
    let empty = Map::new();
    arr(raw)
        .into_iter()
        .take(MAX_ITEMS)
        .enumerate()
        .filter_map(|(i, r)| match recipe(r.as_object().unwrap_or(&empty), i, spell) {
            Ok(v) => Some(v),
            Err(e) => {
                p.at(&format!("recipes[{i}]"), e);
                None
            }
        })
        .collect()
}

pub fn crew(p: &mut Problems, raw: Option<&Value>, section: Option<&dyn Section>) -> Vec<Value> {
    let list: Vec<Value> = arr(raw).into_iter().cloned().collect();
    let max = section.map_or(SPELL_CREW_MAX, Section::max);
    if list.len() > max {
        p.at("crew", format!("at most {max} members"));
    }
    let some = &list[..list.len().min(max)];
    let checked = match section {
        Some(s) => s.check(some, "crew"),
        None => crate::crew::check(some, "crew"),
    };
    checked.unwrap_or_else(|e| {
        p.push(e);
        Vec::new()
    })
}
