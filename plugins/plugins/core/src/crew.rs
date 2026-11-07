//! A spell's `crew` members are wisp.crew's to check, through its `plugins.section` contribution.
//! Without it, the rules that keep a shared member safe still hold here (v1 crew-share.js
//! normalizeBlueprint): a name, a key, no folder, no machine, known triggers and modes, unique keys.
//! The schedule and the kit are kept as written: reading them is wisp.crew's.
use serde_json::{Map, Value, json};

use crate::js::{arr, clip, js_number, js_string, js_trim, truncate, truthy};

const MAX_PARALLEL: f64 = 5.0;
const BRIEF_MAX: usize = 4000;
const KINDS: &[&str] = &["finished", "done", "ci"];
const MODES: &[&str] = &["plan", "edits", "auto"];

/// v1 handleOf: a name as a key.
pub fn handle_of(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.chars().take(41).collect()
}

fn key_ok(k: &str) -> bool {
    let b = k.as_bytes();
    (1..=41).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn name_ok(n: &str) -> bool {
    let mut cs = n.chars();
    cs.next().is_some_and(char::is_alphanumeric) && n.chars().count() <= 24 && cs.all(|c| c.is_alphanumeric() || " ._-".contains(c))
}

fn one_line(v: Option<&Value>) -> String {
    clip(&if truthy(v) { v.map(js_string).unwrap_or_default() } else { String::new() }, 10_000)
}

/// One member, cleaned, or the problem.
pub fn blueprint(raw: &Value) -> Result<Value, String> {
    let x = raw.as_object().ok_or("A crew member is a JSON object with at least a name.")?;
    for (k, what) in [("cwd", "folder"), ("machine", "machine")] {
        if truthy(x.get(k)) {
            return Err(format!("{k}: a shared member has no {what}; whoever adds them picks one."));
        }
    }
    let name = one_line(x.get("name"));
    if name.is_empty() {
        return Err("name: required".into());
    }
    if !name_ok(&name) {
        return Err(format!("name: up to 24 letters, digits, spaces, dots, dashes or underscores, not “{}”", truncate(&name, 40)));
    }
    let key = match x.get("key") {
        None | Some(Value::Null) => handle_of(&name),
        Some(Value::String(s)) if s.is_empty() => handle_of(&name),
        Some(v) => js_string(v),
    };
    let key = if key.is_empty() { "member".to_owned() } else { key };
    if !key_ok(&key) {
        return Err("key: lowercase letters, digits and dashes (at most 41)".into());
    }
    let brief = js_trim(&if truthy(x.get("brief")) { js_string(&x["brief"]).replace("\r\n", "\n") } else { String::new() }).to_owned();
    if brief.chars().count() > BRIEF_MAX {
        return Err("brief: at most 4,000 characters".into());
    }
    let mut on: Vec<String> = arr(x.get("on")).into_iter().map(js_string).collect();
    on.sort();
    on.dedup();
    if let Some(k) = on.iter().find(|k| !KINDS.contains(&k.as_str())) {
        return Err(format!("on: {k} isn't one of {}", KINDS.join(", ")));
    }
    let mode = if truthy(x.get("mode")) { js_string(&x["mode"]) } else { "auto".into() };
    if !MODES.contains(&mode.as_str()) {
        return Err("mode: plan, edits or auto".into());
    }
    let parallel = if x.contains_key("parallel") { js_number(x.get("parallel")).floor() } else { 2.0 };
    if !(1.0..=MAX_PARALLEL).contains(&parallel) {
        return Err("parallel: 1 to 5".into());
    }
    let mut out: Map<String, Value> = x.iter().filter(|(k, _)| !["path", "log", "queue", "offers"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let cron = if truthy(x.get("cron")) { js_trim(&js_string(&x["cron"])).to_owned() } else { String::new() };
    for (k, v) in [("key", json!(key)), ("name", json!(name)), ("brief", json!(brief)), ("cron", json!(cron)), ("on", json!(on)), ("mode", json!(mode)), ("parallel", crate::js::num(parallel))] {
        out.insert(k.into(), v);
    }
    out.insert("kit".into(), Value::Array(arr(x.get("kit")).into_iter().cloned().collect()));
    out.insert("team".into(), Value::Array(arr(x.get("team")).into_iter().cloned().collect()));
    Ok(Value::Object(out))
}

/// A list of members, checked together: each on its own, then unique keys and names.
pub fn check(list: &[Value], at: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::with_capacity(list.len());
    for (i, x) in list.iter().enumerate() {
        let named = x.get("name").filter(|n| truthy(Some(n))).map(|n| format!(" ({})", truncate(&js_string(n), 24))).unwrap_or_default();
        out.push(blueprint(x).map_err(|e| format!("{at}[{i}]{named}: {e}"))?);
    }
    let mut seen: Vec<(String, String)> = Vec::new();
    for (i, b) in out.iter().enumerate() {
        let key = b["key"].as_str().unwrap_or_default().to_owned();
        let name = b["name"].as_str().unwrap_or_default().to_owned();
        let h = handle_of(&name);
        if seen.iter().any(|(k, hh)| *k == key || *hh == h) {
            return Err(format!("{at}[{i}] ({name}): two members share the key {key} or the name {name}"));
        }
        seen.push((key, h));
    }
    Ok(out)
}
