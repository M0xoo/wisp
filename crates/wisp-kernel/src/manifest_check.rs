//! `wisp-plugin.json` validation (plan §6.2): the whole static truth about a plugin, checked without
//! running any of its code. Unknown keys are refused with their path (and the key it probably meant),
//! every id carries its owner's prefix, versions and ranges parse, permissions and activation events
//! follow their grammars.
//!
//! size-ok: one validator per manifest section, all walking the same JSON-path error list
use serde_json::{Map, Value};

use crate::caps::owned_by;
use crate::manifest::ManifestError;
use crate::{perm, semver};

pub(crate) const TOP: &[&str] = &[
    "wispPlugin",
    "id",
    "name",
    "version",
    "api",
    "description",
    "author",
    "kind",
    "extends",
    "requires",
    "provides",
    "permissions",
    "server",
    "activation",
    "disable",
    "contributes",
    "migrations",
    "trust",
    "qa",
];
const CONTRIB: &[&str] = &[
    "commands",
    "events",
    "topics",
    "points",
    "settings",
    "setSettings",
    "ui",
    "parts",
    "partStyles",
    "icons",
    "blocks",
    "recipes",
    // the `on` names a plugin offers to triggers (ADR-0043): known by name even while the plugin is off
    "triggerSources",
];
const SETTING_TYPES: &[&str] = &["string", "int", "bool", "enum", "json"];
const ACTIVATION_KINDS: &[&str] = &["onStartup", "onCommand", "onTopic", "onRoute", "onView", "onBlock", "onSchedule"];

#[derive(Default)]
pub(crate) struct Problems(pub(crate) Vec<ManifestError>);

impl Problems {
    pub(crate) fn add(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.0.push(ManifestError { path: path.into(), message: message.into() });
    }
}

/// 'wisp.runtime', 'acme.thing', 'user.my-prs': two or more dot-separated segments, the first a name.
pub fn plugin_id_ok(s: &str) -> bool {
    let mut parts = s.split('.');
    let first = parts.next().unwrap_or_default();
    let seg = |p: &str, lead: fn(char) -> bool| {
        p.starts_with(lead) && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let rest: Vec<&str> = parts.collect();
    seg(first, |c| c.is_ascii_lowercase())
        && !rest.is_empty()
        && rest.iter().all(|p| seg(p, |c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

/// A point key in `contributes`: `runtime.harness`, `kernel.setting`, `shell.task:toolbar@1`.
fn point_key_ok(s: &str) -> bool {
    let s = s.split_once('@').map_or(s, |(k, v)| if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) { k } else { "" });
    let mut parts = s.split('.');
    let first = parts.next().unwrap_or_default();
    let rest: Vec<&str> = parts.collect();
    first.starts_with(|c: char| c.is_ascii_lowercase())
        && first.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !rest.is_empty()
        && rest.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':')))
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.to_lowercase().chars().collect(), b.to_lowercase().chars().collect());
    let mut d: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = d[0];
        d[0] = i;
        for j in 1..=b.len() {
            let t = d[j];
            d[j] = (d[j] + 1).min(d[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = t;
        }
    }
    d[b.len()]
}

/// The closest known key, when one is close enough to be a typo.
pub(crate) fn closest<'a>(key: &str, known: &[&'a str]) -> Option<&'a str> {
    let mut best = None;
    let mut score = (key.len() / 3).max(2) + 1;
    for k in known {
        let s = distance(key, k);
        if s < score {
            best = Some(*k);
            score = s;
        }
    }
    best
}

pub(crate) fn join(at: &str, k: &str) -> String {
    if at.is_empty() { k.to_owned() } else { format!("{at}.{k}") }
}

pub(crate) fn unknown_keys(o: &Map<String, Value>, known: &[&str], at: &str, p: &mut Problems) {
    for k in o.keys() {
        if known.contains(&k.as_str()) {
            continue;
        }
        let msg = match closest(k, known) {
            Some(near) => format!("unknown key \"{k}\"; did you mean \"{near}\"?"),
            None => format!("unknown key \"{k}\"; known keys: {}", known.join(", ")),
        };
        p.add(join(at, k), msg);
    }
}

fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

pub(crate) fn string_list(v: Option<&Value>, path: &str, p: &mut Problems, check: &mut dyn FnMut(&str, &str, &mut Problems)) {
    let Some(v) = v else { return };
    let Some(list) = v.as_array() else {
        return p.add(path, "must be a list of strings");
    };
    for (i, s) in list.iter().enumerate() {
        let at = format!("{path}[{i}]");
        match nonempty(s) {
            Some(s) => check(s, &at, p),
            None => p.add(at, "must be a non-empty string"),
        }
    }
}

pub(crate) fn check_permission(s: &str, at: &str, p: &mut Problems) {
    if let Some(why) = perm::problem(s) {
        p.add(at, why);
    }
}

/// `onStartup`, `onCommand:runtime.start{harness:claude}`, `onTopic:session:*`, `onRoute:GET /api/x/*`,
/// `onView:shell.task`, `onBlock:usage-chart`, `onSchedule:5m` or `onSchedule:<name>`.
pub(crate) fn activation_problem(s: &str) -> Option<String> {
    let (kind, name) = s.split_once(':').unwrap_or((s, ""));
    if !ACTIVATION_KINDS.contains(&kind) {
        return Some(format!("\"{kind}\" is not an activation event; use one of {}", ACTIVATION_KINDS.join(", ")));
    }
    let id_ok = |n: &str| {
        n.starts_with(|c: char| c.is_ascii_lowercase())
            && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'*'))
    };
    let ok = match kind {
        "onStartup" => name.is_empty() && !s.contains(':'),
        "onCommand" => match name.split_once('{') {
            Some((n, f)) => id_ok(n) && f.strip_suffix('}').is_some_and(|f| !f.is_empty() && !f.contains(['{', '}'])),
            None => id_ok(name),
        },
        "onTopic" | "onSchedule" => !name.is_empty() && !name.contains(char::is_whitespace),
        "onRoute" => route_activation(name).is_some(),
        _ => id_ok(name),
    };
    if ok {
        return None;
    }
    Some(match kind {
        "onStartup" => format!("\"{s}\" is not onStartup"),
        "onRoute" => format!("\"{s}\" is not onRoute:<path> or onRoute:<METHOD> <path>"),
        _ => format!("\"{s}\" is not {kind}:<name>"),
    })
}

/// `onRoute:GET /api/sessions/*` or `onRoute:/api/sessions/*` → (method or "*", path pattern).
pub(crate) fn route_activation(name: &str) -> Option<(&str, &str)> {
    let (m, path) = match name.split_once(' ') {
        Some((m, path)) if !m.is_empty() && m.bytes().all(|b| b.is_ascii_uppercase()) => (m, path.trim()),
        Some(_) => return None,
        None => ("*", name),
    };
    (path.starts_with('/') && !path.contains(char::is_whitespace)).then_some((m, path))
}

/// 'shell.composer:left' or {id, input}, as (id, input).
pub(crate) fn attach_to(v: Option<&Value>, path: &str, p: &mut Problems) -> Option<(String, String)> {
    match v {
        Some(Value::String(s)) => {
            if let Some((id, input)) = s.rsplit_once(':').filter(|(a, b)| !a.is_empty() && !b.is_empty()) {
                return Some((id.to_owned(), input.to_owned()));
            }
        }
        Some(Value::Object(o)) => {
            if let (Some(id), Some(input)) = (o.get("id").and_then(nonempty), o.get("input").and_then(nonempty)) {
                unknown_keys(o, &["id", "input"], path, p);
                return Some((id.to_owned(), input.to_owned()));
            }
        }
        _ => {}
    }
    p.add(path, "must be {id, input} or \"parent.id:input\"");
    None
}

/// Checks a manifest given as JSON. Every problem, each with its path; empty means valid.
pub(crate) fn check(json: &Value) -> Vec<ManifestError> {
    let mut p = Problems::default();
    let Some(o) = json.as_object() else {
        p.add("", "a manifest is a JSON object");
        return p.0;
    };
    unknown_keys(o, TOP, "", &mut p);
    if o.get("wispPlugin") != Some(&Value::from(1)) {
        p.add("wispPlugin", "must be 1");
    }
    let pid = o.get("id").and_then(Value::as_str).unwrap_or_default();
    if !plugin_id_ok(pid) {
        p.add("id", "an owner-prefixed id: lowercase segments joined by dots, like \"acme.thing\"");
    }
    header(o, &mut p);
    relations(o, &mut p);
    string_list(o.get("permissions"), "permissions", &mut p, &mut |s, at, p| check_permission(s, at, p));
    string_list(o.get("activation"), "activation", &mut p, &mut |s, at, p| {
        if let Some(why) = activation_problem(s) {
            p.add(at, why);
        }
    });
    string_list(o.get("disable"), "disable", &mut p, &mut |_, _, _| {});
    server(o.get("server"), &mut p);
    if let Some(c) = o.get("contributes") {
        crate::manifest_contrib::contributes(c, pid, &mut p);
    }
    p.0
}

fn header(o: &Map<String, Value>, p: &mut Problems) {
    for k in ["name", "description", "author", "migrations", "qa"] {
        if o.get(k).is_some_and(|v| !v.is_string()) {
            p.add(k, "must be a string");
        }
    }
    if !o.get("version").and_then(Value::as_str).is_some_and(semver::valid_version) {
        p.add("version", "must be a semver version, like \"1.0.0\"");
    }
    if !o.get("api").and_then(Value::as_str).is_some_and(semver::valid_range) {
        p.add("api", "must be a semver range of the kernel api, like \"^1\"");
    }
    if o.get("kind").is_some_and(|k| k != "plugin" && k != "module") {
        p.add("kind", "must be \"plugin\" or \"module\"");
    }
    if o.get("trust").is_some_and(|t| !matches!(t.as_str(), Some("declarative" | "untrusted" | "trusted"))) {
        p.add("trust", "must be \"declarative\", \"untrusted\" or \"trusted\"");
    }
}

fn relations(o: &Map<String, Value>, p: &mut Problems) {
    let module = o.get("kind").is_some_and(|k| k == "module");
    match o.get("extends") {
        Some(e) if !e.as_str().is_some_and(plugin_id_ok) => p.add("extends", "must be a plugin id"),
        Some(_) if !module => p.add("kind", "only a module extends a plugin: set kind to \"module\""),
        None if module => p.add("extends", "a module extends exactly one plugin: name it"),
        _ => {}
    }
    if let Some(r) = o.get("requires") {
        requires(r, p);
    }
    if let Some(r) = o.get("provides") {
        provides(r, p);
    }
}

fn requires(r: &Value, p: &mut Problems) {
    let Some(r) = r.as_object() else {
        return p.add("requires", "must map plugin or service ids to a range or {version, optional}");
    };
    for (k, v) in r {
        let at = format!("requires.{k}");
        if !plugin_id_ok(k) {
            p.add(&at, "must be a plugin id or a service contract id, like \"git.service\"");
        }
        match v {
            Value::String(s) if !semver::valid_range(s) => {
                p.add(&at, format!("\"{s}\" is not a semver range"));
            }
            Value::String(_) => {}
            Value::Object(o) => {
                unknown_keys(o, &["version", "optional"], &at, p);
                if !o.get("version").and_then(Value::as_str).is_some_and(semver::valid_range) {
                    p.add(format!("{at}.version"), "must be a semver range");
                }
                if o.get("optional").is_some_and(|x| !x.is_boolean()) {
                    p.add(format!("{at}.optional"), "must be true or false");
                }
            }
            _ => p.add(&at, "must be a range or {version, optional}"),
        }
    }
}

fn provides(r: &Value, p: &mut Problems) {
    let Some(r) = r.as_object() else {
        return p.add("provides", "must map service contract ids to {version}");
    };
    for (k, v) in r {
        let at = format!("provides.{k}");
        if !plugin_id_ok(k) {
            p.add(&at, "must be a service contract id, like \"git.service\"");
        }
        match v.as_object() {
            Some(o) if o.get("version").and_then(Value::as_str).is_some_and(semver::valid_version) => {
                unknown_keys(o, &["version"], &at, p);
            }
            _ => p.add(&at, "must be {version: \"1.3.0\"}"),
        }
    }
}

fn server(v: Option<&Value>, p: &mut Problems) {
    let Some(v) = v else { return };
    let ok = v.as_object().is_some_and(|o| {
        o.len() == 1
            && (o.get("builtin").and_then(nonempty).is_some()
                || o.get("exec").and_then(Value::as_array).is_some_and(|a| !a.is_empty() && a.iter().all(|x| nonempty(x).is_some())))
    });
    if !ok {
        p.add("server", "must be {builtin: \"<crate>\"} or {exec: [\"<program>\", …args]}");
    }
}

/// `owned` check shared by the contribution checks.
pub(crate) fn owned(v: Option<&Value>, pid: &str, at: &str, p: &mut Problems, what: &str) -> bool {
    let Some(id) = v.and_then(nonempty) else {
        p.add(at, format!("{what} must be a non-empty string"));
        return false;
    };
    if !pid.is_empty() && !owned_by(id, pid) {
        p.add(at, format!("\"{id}\" must start with this plugin's prefix (\"{}.\" or \"{pid}.\")", crate::caps::owner_prefix(pid)));
    }
    true
}

pub(crate) const fn contrib_keys() -> &'static [&'static str] {
    CONTRIB
}
pub(crate) const fn setting_types() -> &'static [&'static str] {
    SETTING_TYPES
}
pub(crate) fn is_point_key(s: &str) -> bool {
    point_key_ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        for ok in ["wisp.runtime", "acme.thing", "user.my-prs", "wisp.shell.task", "a.1b"] {
            assert!(plugin_id_ok(ok), "{ok}");
        }
        for bad in ["wisp", "Wisp.x", "1a.b", "a..b", "a.", "a.B"] {
            assert!(!plugin_id_ok(bad), "{bad}");
        }
        assert!(point_key_ok("runtime.harness"));
        assert!(point_key_ok("shell.task:toolbar@1"));
        assert!(!point_key_ok("runtime"));
    }

    #[test]
    fn activation() {
        for ok in [
            "onStartup",
            "onCommand:runtime.start",
            "onCommand:runtime.start{harness:claude}",
            "onTopic:session:*",
            "onRoute:GET /api/x/*",
            "onRoute:/hooks/*",
            "onView:shell.task",
            "onBlock:usage-chart",
            "onSchedule:5m",
        ] {
            assert_eq!(activation_problem(ok), None, "{ok}");
        }
        assert!(activation_problem("onBoot").is_some_and(|m| m.contains("not an activation event")));
        assert!(activation_problem("onCommand:").is_some());
        assert!(activation_problem("onStartup:x").is_some());
        assert!(activation_problem("onRoute:get /x").is_some());
    }

    #[test]
    fn typos() {
        assert_eq!(closest("permisions", TOP), Some("permissions"));
        assert_eq!(closest("zzzzzz", TOP), None);
    }
}
