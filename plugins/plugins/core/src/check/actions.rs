//! What a button, chip, slash command, ⌘K command or hook does (`do`), checked as v1's checkAction
//! did: exactly one action, by name, and a hook only the ones safe to run on their own.
use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::js::{arr, has, js_string, js_trim, obj, str_, truncate, truthy};
use crate::schema::schema;
use crate::vocab::Vocab;

/// Every check pushes one line; a spell with any is refused.
#[derive(Debug, Default, Clone)]
pub struct Problems(pub Vec<String>);

impl Problems {
    pub fn at(&mut self, at: &str, msg: impl AsRef<str>) {
        self.0.push(format!("{at}: {}", msg.as_ref()));
    }
    pub fn push(&mut self, line: String) {
        self.0.push(line);
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// What the rest of the spell declares, for references to check against.
#[derive(Debug)]
pub struct Refs<'a> {
    pub vocab: &'a Vocab,
    /// panel ids as written (v1 compared them with ===)
    pub panels: Vec<Value>,
    pub data: HashSet<String>,
    pub fns: HashSet<String>,
}

impl Refs<'_> {
    pub fn has_data(&self, v: Option<&Value>) -> bool {
        v.and_then(Value::as_str).is_some_and(|s| self.data.contains(s))
    }
    pub fn has_fn(&self, v: Option<&Value>) -> bool {
        v.and_then(Value::as_str).is_some_and(|s| self.fns.contains(s))
    }
    /// v1 needFn: a named function the script must export.
    pub fn need_fn(&self, p: &mut Problems, f: Option<&Value>, at: &str) {
        if truthy(f) && !self.has_fn(f) {
            p.at(at, format!("the script exports no function {}", f.map(js_string).unwrap_or_default()));
        }
    }
}

fn is_text(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty())
}

fn starts_http(s: &str) -> bool {
    let l = s.get(..8).unwrap_or(s).to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

/// `{field}` or `{a.b}` at the start.
fn starts_template(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('{') else { return false };
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.')).unwrap_or(rest.len());
    end > 0 && rest[end..].starts_with('}')
}

const TEXT: &[&str] = &["insert", "copy", "toast", "send", "reply", "notify", "exec", "recipe"];
const FLAGS: &[&str] = &["ship", "done", "archive", "forLater", "compact"];
const RUNS: &[&str] = &["setLaunch", "launchWith", "rerun", "fork", "side", "launch"];
const RUN_FIELDS: &[&str] = &["agent", "model", "effort", "mode", "text", "prompt", "cwd"];

fn open_all(v: Option<&Value>, at: &str, p: &mut Problems, r: &Refs) -> Option<Value> {
    let x = obj(v);
    let get = |k: &str| x.and_then(|x| x.get(k));
    if truthy(get("fn")) {
        if !r.has_fn(get("fn")) {
            p.at(at, format!("openAll: the script exports no function {}", get("fn").map(js_string).unwrap_or_default()));
        }
        let with = get("with").filter(|w| !w.is_null()).or_else(|| get("data"));
        let data: Vec<Value> = arr(with).into_iter().map(|d| Value::from(str_(Some(d), 40))).collect();
        return Some(json!({ "openAll": { "fn": str_(get("fn"), 60), "data": data } }));
    }
    if truthy(get("data")) {
        if !r.has_data(get("data")) {
            p.at(at, format!("openAll: no data source named {}", get("data").map(js_string).unwrap_or_default()));
        }
        let field = if truthy(get("field")) { str_(get("field"), 60) } else { "url".into() };
        return Some(json!({ "openAll": { "data": str_(get("data"), 40), "field": field } }));
    }
    p.at(at, "openAll needs { \"data\": \"<source>\", \"field\": \"url\" } or { \"fn\": \"<script function>\" }");
    None
}

fn run_action(k: &str, v: Option<&Value>, at: &str, p: &mut Problems) -> Value {
    let empty = Map::new();
    let x = obj(v).unwrap_or(&empty);
    let mut out = Map::new();
    for f in RUN_FIELDS {
        if has(x, f) {
            let s = if *f == "prompt" || *f == "text" { truncate(&js_string(&x[*f]), 4000) } else { str_(x.get(*f), 200) };
            out.insert((*f).into(), Value::from(s));
        }
    }
    let field = |k: &str| out.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    if field("mode").is_some_and(|m| !["plan", "edits", "auto"].contains(&m)) {
        p.at(at, "mode must be plan, edits or auto");
    }
    let what = match k {
        "launch" => Some("task should do"),
        "fork" => Some("fork should try"),
        "side" => Some("side discussion should talk over"),
        _ => None,
    };
    if let Some(what) = what
        && field("prompt").is_none()
    {
        p.at(at, format!("{k} needs a prompt: what the {what}"));
    }
    if k == "side" && field("mode").is_some() {
        p.at(at, "side takes no mode: a side discussion only reads");
    }
    json!({ k: out })
}

/// The action, cleaned, or None (with the problem pushed). `hook`: only hook actions are allowed.
pub fn check_action(a: Option<&Value>, at: &str, p: &mut Problems, r: &Refs, hook: bool) -> Option<Value> {
    let s = schema();
    let Some(o) = obj(a) else {
        p.at(at, "do must be an object like { \"open\": \"https://…\" }");
        return None;
    };
    let keys: Vec<&String> = o.keys().filter(|k| s.action(k).is_some()).collect();
    let [k] = keys.as_slice() else {
        p.at(at, format!("do needs exactly one of {}", s.action_names().join(", ")));
        return None;
    };
    let k = k.as_str();
    let v = o.get(k);
    if hook && !s.hook_actions.iter().any(|h| h == k) {
        p.at(at, format!("a hook can only {}", s.hook_actions.join(", ")));
        return None;
    }
    if k == "open" || k == "webhook" {
        let t = v.and_then(Value::as_str).map(js_trim).unwrap_or("");
        if !is_text(v) || !(starts_http(t) || (k == "open" && starts_template(t))) {
            p.at(at, format!("{k} needs an http(s) URL"));
        }
        return Some(json!({ k: str_(v, 500) }));
    }
    if k == "openAll" {
        return open_all(v, at, p, r);
    }
    if k == "panel" {
        if !v.is_some_and(|v| r.panels.contains(v)) {
            p.at(at, format!("no panel named {}", v.map_or_else(|| "undefined".into(), js_string)));
        }
        return Some(json!({ "panel": str_(v, 40) }));
    }
    if TEXT.contains(&k) {
        if !is_text(v) {
            p.at(at, format!("{k} needs text"));
        }
        // Kept as written (line breaks, a trailing space after "Explain why "), only capped.
        let text = if k == "exec" { str_(v, 1000) } else { truncate(&if truthy(v) { v.map(js_string).unwrap_or_default() } else { String::new() }, 4000) };
        return Some(json!({ k: text }));
    }
    if FLAGS.contains(&k) {
        return Some(json!({ k: true }));
    }
    RUNS.contains(&k).then(|| run_action(k, v, at, p))
}
