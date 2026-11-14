//! `wisp_plugin_check`: a plugin validated without installing it, and nothing of it run. The manifest goes through
//! the kernel's own checker (every problem with its path), then what makes an *untrusted* plugin (ADR-0048) work:
//! a `user.` id, UI only where an untrusted UI may show, its modules given and small enough, and a read of each
//! module's text for what fails in its Worker (no DOM, no network), kit components it names that aren't the kit's,
//! and each `wisp.call` it makes against the commands wisp has and the permissions it asks for. Ok: what it does,
//! in plain words. Not ok: every problem, numbered.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use wisp_kernel::{CommandInfo, Manifest, perm};

use crate::kit::kit;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub ok: bool,
    pub name: String,
    /// what it does, in plain words
    pub does: Vec<String>,
    /// what stops it working
    pub problems: Vec<String>,
    /// worth knowing, not wrong
    pub notes: Vec<String>,
}

impl Report {
    /// The tool's answer.
    pub fn text(&self) -> String {
        let list = |xs: &[String]| xs.iter().map(|x| format!("- {x}")).collect::<Vec<_>>().join("\n");
        let mut out = if self.ok {
            format!("ok: {} would install. What it does:\n{}", self.name, list(&self.does))
        } else {
            let n = self.problems.len();
            let numbered = self.problems.iter().enumerate().map(|(i, p)| format!("{}. {p}", i + 1)).collect::<Vec<_>>().join("\n");
            format!("{n} problem{} to fix in {}:\n{numbered}", if n == 1 { "" } else { "s" }, self.name)
        };
        if !self.notes.is_empty() {
            let _ = write!(out, "\n\nNotes:\n{}", list(&self.notes));
        }
        out
    }
}

/// `(id, place, title, module path)` of each `contributes.ui` entry an untrusted UI may have (a place it may show,
/// a `.js` module in its own folder): what `plugins.ui` serves. `attachTo` as `{id, input}` or `"id:input"`.
pub fn entries(contributes: &BTreeMap<String, Value>) -> Vec<(String, String, String, String)> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    contributes
        .get("ui")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let place = place_of(x);
            let path = crate::module_path(&s(x, "component"))?;
            kit().places.contains_key(&place).then(|| (s(x, "id"), place, s(x, "title"), path))
        })
        .collect()
}

fn place_of(x: &Value) -> String {
    match x.get("attachTo") {
        Some(Value::String(s)) => s.rsplit_once(':').map_or(s.as_str(), |(id, _)| id).to_owned(),
        Some(a) => a.get("id").and_then(Value::as_str).unwrap_or_default().to_owned(),
        None => String::new(),
    }
}

/// What a module can't do in its Worker (no DOM, no network, no storage, no imports), and why it would fail.
const NOT_IN_A_WORKER: &[(&str, &str)] = &[
    (r"\bdocument\s*\.", "uses `document`: its Worker has no DOM. Describe the UI with wisp.render instead"),
    (r"\bwindow\s*\.", "uses `window`: its Worker has no window. Describe the UI with wisp.render instead"),
    (r"\bfetch\s*\(", "calls fetch: its frame opens no network (CSP default-src 'none'). Read wisp's data with wisp.call"),
    (r"\bXMLHttpRequest\b", "uses XMLHttpRequest: its frame opens no network. Read wisp's data with wisp.call"),
    (r"\bWebSocket\b|\bEventSource\b", "opens a socket: its frame opens no network"),
    (r"\b(?:localStorage|sessionStorage|indexedDB)\b", "uses browser storage: its frame has an opaque origin and none of wisp's"),
    (r"\bimportScripts\s*\(|\bimport\s*\(|^\s*import\s|\brequire\s*\(", "imports code: a module is one file and loads nothing else"),
    (r"\binnerHTML\b|\bdangerouslySetInnerHTML\b", "writes HTML: descriptors are text only"),
];

static BLOCKED: LazyLock<Vec<(Regex, &'static str)>> =
    LazyLock::new(|| NOT_IN_A_WORKER.iter().filter_map(|(re, why)| Some((Regex::new(&format!("(?m){re}")).ok()?, *why))).collect());
static COMPONENT: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r#"[{,]\s*c\s*:\s*['"`]([A-Za-z]\w*)['"`]"#).ok());
static CALL: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r#"\bwisp\s*\.\s*call\s*\(\s*(['"`]([^'"`]*)['"`])?"#).ok());
static API: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?:^|[^\w.$])wisp\s*\.\s*([A-Za-z_$][\w$]*)").ok());
static RENDER: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\brender\s*\(").ok());
static TAKEN_APART: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\}\s*=\s*(?:self\.)?wisp\b").ok());

fn caps(re: &LazyLock<Option<Regex>>) -> Option<&Regex> {
    LazyLock::force(re).as_ref()
}

/// The module's code with its comments and string contents blanked (same length, newlines kept): what it *does*,
/// not what its text says (`'Open the document.'` is not a use of `document`, nor `'wisp.plugins'` of wisp's API).
pub fn code_only(text: &str) -> String {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum At {
        Code,
        Line,
        Block,
        Str(char),
    }
    let mut at = At::Code;
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    let blank = |c: char| if c == '\n' { '\n' } else { ' ' };
    while let Some(c) = it.next() {
        match at {
            At::Code => match c {
                '/' if it.peek() == Some(&'/') => at = At::Line,
                '/' if it.peek() == Some(&'*') => at = At::Block,
                '\'' | '"' | '`' => {
                    at = At::Str(c);
                    out.push(c);
                    continue;
                }
                _ => {}
            },
            At::Line if c == '\n' => at = At::Code,
            At::Block if c == '*' && it.peek() == Some(&'/') => {
                out.push(' ');
                it.next();
                out.push(' ');
                at = At::Code;
                continue;
            }
            At::Str(_) if c == '\\' => {
                out.push(' ');
                if let Some(n) = it.next() {
                    out.push(blank(n));
                }
                continue;
            }
            At::Str(q) if c == q => {
                at = At::Code;
                out.push(c);
                continue;
            }
            _ => {}
        }
        out.push(if at == At::Code { c } else { blank(c) });
    }
    out
}

/// What its code can't do in its Worker, and the wisp API it reaches for that isn't there.
fn code_problems(path: &str, code: &str, r: &mut Report) {
    for (re, why) in BLOCKED.iter() {
        if re.is_match(code) {
            r.problems.push(format!("{path} {why}"));
        }
    }
    let api = &kit().api;
    if let Some(re) = caps(&API) {
        let mut seen: Vec<&str> = Vec::new();
        for name in re.captures_iter(code).filter_map(|c| c.get(1)).map(|m| m.as_str()) {
            if !api.iter().any(|a| a == name) && !seen.contains(&name) {
                seen.push(name);
                let have = api.iter().map(|a| format!("wisp.{a}")).collect::<Vec<_>>().join(", ");
                r.problems.push(format!("{path} uses wisp.{name}: its wisp has only {have}"));
            }
        }
    }
    if !caps(&RENDER).is_some_and(|re| re.is_match(code)) {
        r.problems.push(format!("{path} never calls wisp.render: it shows nothing"));
    }
    if caps(&TAKEN_APART).is_some_and(|re| re.is_match(code)) {
        r.notes.push(format!(
            "{path} takes wisp apart (`const {{ call }} = wisp`): the check reads only wisp.call('…') calls, so it can't see the others"
        ));
    }
}

/// The kit components it names that the kit hasn't.
fn components(path: &str, text: &str, r: &mut Report) {
    let Some(re) = caps(&COMPONENT) else { return };
    let mut seen: Vec<&str> = Vec::new();
    for name in re.captures_iter(text).filter_map(|c| c.get(1)).map(|m| m.as_str()) {
        if !kit().components.contains_key(name) && !seen.contains(&name) {
            seen.push(name);
            let have = kit().components.keys().map(String::as_str).collect::<Vec<_>>().join(", ");
            r.problems.push(format!("{path} names `{name}`, which isn't a kit component, so it's dropped (the kit: {have})"));
        }
    }
}

/// Each `wisp.call('<id>')` against the commands wisp has, its own and its permissions.
fn calls(path: &str, text: &str, m: &Manifest, commands: &[CommandInfo], r: &mut Report) {
    let Some(re) = caps(&CALL) else { return };
    let own: Vec<String> = m.commands().into_iter().map(|c| c.id).collect();
    let mut seen: Vec<String> = Vec::new();
    for c in re.captures_iter(text) {
        let Some(id) = c.get(2).map(|m| m.as_str().to_owned()).filter(|id| !id.contains("${")) else {
            r.notes.push(format!(
                "{path} calls a command named at run time: the check can't see which (each is checked against its permissions when it runs)"
            ));
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        if own.contains(&id) {
            r.does.push(format!("calls its own command {id}"));
            continue;
        }
        match commands.iter().find(|x| x.id == id) {
            None => r.problems.push(format!("{path} calls {id}, which isn't a command wisp has (wisp_plugin_schema lists them)")),
            Some(cmd) if !m.permissions.iter().any(|g| perm::covers(g, &cmd.permission)) => {
                r.problems.push(format!("{path} calls {id}, which needs \"{}\": add it to permissions", cmd.permission));
            }
            Some(cmd) => {
                let what = cmd.title.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
                r.does.push(format!("calls {id}{what}{}", if cmd.read_only { ", which only reads" } else { ", which changes things" }));
            }
        }
    }
}

/// Everything wrong with a module, and the commands it calls.
fn module(path: &str, text: &str, m: &Manifest, commands: &[CommandInfo], r: &mut Report) {
    let limit = kit().limits.module;
    if text.len() as u64 > limit {
        r.problems.push(format!("{path} is {} bytes: a module is {limit} bytes ({} KB) at most", text.len(), limit / 1024));
    }
    code_problems(path, &code_only(text), r);
    components(path, text, r);
    calls(path, text, m, commands, r);
}

fn ui(m: &Manifest, files: &BTreeMap<String, String>, commands: &[CommandInfo], r: &mut Report) {
    let list = m.contributes.get("ui").and_then(Value::as_array).cloned().unwrap_or_default();
    let places = kit().places.keys().map(String::as_str).collect::<Vec<_>>().join(", ");
    for (i, x) in list.iter().enumerate() {
        let at = format!("contributes.ui[{i}]");
        let place = place_of(x);
        let Some(p) = kit().places.get(&place) else {
            r.problems.push(format!("{at}.attachTo: {place:?} isn't where an untrusted plugin may show (only {places})"));
            continue;
        };
        let component = x.get("component").and_then(Value::as_str).unwrap_or_default();
        let Some(path) = crate::module_path(component) else {
            let why = if x.get("kit").is_some() && component.is_empty() {
                "a kit descriptor in the manifest isn't drawn for an untrusted plugin: give a component module (\"./ui.js#default\") that calls wisp.render"
            } else {
                "component must be a .js module in the plugin's folder (\"./ui.js#default\")"
            };
            r.problems.push(format!("{at}: {why}"));
            continue;
        };
        let title = x.get("title").and_then(Value::as_str).map(|t| format!(" “{t}”")).unwrap_or_default();
        r.does.push(format!("shows {}{title}, drawn from {path}", p.words));
        if !p.drawn {
            r.notes.push(format!(
                "{at}: wisp doesn't draw {} for plugins yet (only a pane in Settings → Advanced); it shows once it does",
                p.words
            ));
        }
        match files.get(&path) {
            None => r.problems.push(format!("{at}: {path} isn't given: pass its text in files[\"{path}\"]")),
            Some(text) => module(&path, text, m, commands, r),
        }
    }
}

/// Every permission in words: what it lets the plugin run.
fn permissions(m: &Manifest, commands: &[CommandInfo], r: &mut Report) {
    for g in &m.permissions {
        let n = commands.iter().filter(|c| perm::covers(g, &c.permission)).count();
        if n == 0 {
            r.notes.push(format!("permission \"{g}\" lets it run none of wisp's commands"));
        } else {
            r.does.push(format!("may run {n} command{} with \"{g}\"", if n == 1 { "" } else { "s" }));
        }
    }
}

fn rest(m: &Manifest, r: &mut Report) {
    if let Some(exec) = m.exec() {
        r.does.push(format!(
            "runs its own process `{}` in its folder, with an emptied environment, every call checked against its permissions",
            exec.join(" ")
        ));
    } else if m.server.as_ref().is_some_and(|s| s.get("builtin").is_some()) {
        r.problems.push("server.builtin is for wisp's own crates: a plugin of yours runs {\"exec\": [\"<program>\", …]}".into());
    }
    for c in m.commands() {
        r.does.push(format!("adds the command {} ({})", c.id, c.title));
    }
    if m.exec().is_none() && !m.commands().is_empty() {
        r.notes.push("it has no server, so nothing answers its commands: give it {\"exec\": [\"<program>\", …]} or leave them out".into());
    }
    for s in m.settings() {
        r.does.push(format!("adds the setting {} ({})", s.key, s.ty));
    }
    if m.trust.is_some() {
        r.notes.push("trust is ignored on install: it is untrusted until the user trusts it in Settings → Plugins".into());
    }
}

/// The check. `manifest`: the plugin's `wisp-plugin.json` as JSON; `files`: its other files by path (`ui.js`);
/// `commands`: the commands wisp has (the catalogue).
pub fn check(manifest: &Value, files: &BTreeMap<String, String>, commands: &[CommandInfo]) -> Report {
    let mut r = Report { name: manifest.get("id").and_then(Value::as_str).unwrap_or("the plugin").to_owned(), ..Report::default() };
    if !manifest.is_object() {
        r.problems.push("manifest must be the whole wisp-plugin.json, as a JSON object".into());
        return r;
    }
    r.problems.extend(
        Manifest::check(manifest).into_iter().map(|e| if e.path.is_empty() { e.message } else { format!("{}: {}", e.path, e.message) }),
    );
    if !r.name.starts_with("user.") {
        r.problems.push(format!("id: {} isn't a plugin of yours: name it user.<something> (other ids are wisp's own)", r.name));
    }
    // the rest reads what it can: keys the checker refused are left out, so one typo doesn't hide every other problem
    let mut known = manifest.clone();
    if let Some(o) = known.as_object_mut() {
        o.retain(|k, _| wisp_kernel::manifest::KEYS.contains(&k.as_str()));
    }
    if let Ok(m) = serde_json::from_value::<Manifest>(known) {
        if let Some(n) = m.name.as_deref() {
            r.name = format!("{n} ({})", m.id);
        }
        ui(&m, files, commands, &mut r);
        permissions(&m, commands, &mut r);
        rest(&m, &mut r);
        if m.exec().is_none()
            && m.contributes
                .values()
                .all(|v| v.as_array().is_some_and(Vec::is_empty) || v.as_object().is_some_and(serde_json::Map::is_empty))
        {
            r.problems.push("it does nothing: no UI, no server and no contributions".into());
        }
    }
    r.ok = r.problems.is_empty();
    r
}
