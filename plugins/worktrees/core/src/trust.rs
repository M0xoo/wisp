//! Project trust (v1 server/project-trust.js). A repo can make the agent run its own programs: Claude
//! Code runs the hooks in `.claude/settings.json` (and `.local`) and starts the servers in `.mcp.json`,
//! unasked, whatever the mode; wisp runs the repo's worktree setup. So before the first run in a repo,
//! and again when one of those changes, the turn is held and the card lists them. What was trusted is
//! kept per repo (its main checkout, so worktrees share it) as one hash per item: a new or changed item
//! asks again, one that's gone doesn't matter. Full auto never asks; `projectAsk: off` stops it.
//! Ids are v1's byte for byte (sha256 of the JSON array, 24 hex), so an imported trust file still holds.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use wisp_worktrees_api::{Pending, TrustItem, TrustKind};

/// Claude Code settings keys whose value is a program it runs (besides hooks).
pub const HELPERS: &[&str] = &["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper"];
pub const SETTINGS_FILES: &[&str] = &[".claude/settings.json", ".claude/settings.local.json"];
pub const MCP_FILE: &str = ".mcp.json";

fn kind_name(k: TrustKind) -> &'static str {
    match k {
        TrustKind::Hook => "hook",
        TrustKind::Command => "command",
        TrustKind::Plugin => "plugin",
        TrustKind::Mcp => "mcp",
        TrustKind::Setup => "setup",
    }
}

/// `sha256(JSON.stringify([kind, file, name, command, extra || null]))[..24]`.
pub fn item_id(kind: TrustKind, file: Option<&str>, name: &str, command: &str, extra: Option<&[String]>) -> String {
    let arr = Value::Array(vec![
        Value::from(kind_name(kind)),
        file.map_or(Value::Null, Value::from),
        Value::from(name),
        Value::from(command),
        extra.map_or(Value::Null, |e| Value::Array(e.iter().map(|s| Value::from(s.as_str())).collect())),
    ]);
    let hex: String = Sha256::digest(arr.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    hex[..24].to_owned()
}

pub fn item(kind: TrustKind, file: Option<&str>, name: &str, command: &str, extra: Option<Vec<String>>) -> TrustItem {
    let id = item_id(kind, file, name, command, extra.as_deref());
    TrustItem { kind, file: file.map(str::to_owned), name: name.to_owned(), command: command.to_owned(), extra, id }
}

fn parse(text: Option<&str>) -> Option<Value> {
    serde_json::from_str::<Value>(text?.trim_start_matches('\u{feff}')).ok().filter(Value::is_object)
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// What Claude Code would run from one settings file: each hook, the helper programs, the status line,
/// the plugins it enables. `rel`: the file as the card names it.
pub fn settings_items(text: Option<&str>, rel: &str) -> Vec<TrustItem> {
    let Some(json) = parse(text) else { return Vec::new() };
    let mut out = Vec::new();
    for (event, groups) in json.get("hooks").and_then(Value::as_object).into_iter().flatten() {
        for g in groups.as_array().into_iter().flatten() {
            let matcher = str_of(g, "matcher").filter(|m| !m.is_empty());
            let name = matcher.map_or_else(|| event.clone(), |m| format!("{event} ({m})"));
            for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                let command = str_of(h, "command").or_else(|| str_of(h, "prompt")).or_else(|| str_of(h, "url")).map_or_else(|| h.to_string(), str::to_owned);
                out.push(item(TrustKind::Hook, Some(rel), &name, &command, None));
            }
        }
    }
    for k in HELPERS {
        if let Some(c) = str_of(&json, k).filter(|c| !c.trim().is_empty()) {
            out.push(item(TrustKind::Command, Some(rel), k, c, None));
        }
    }
    if let Some(c) = json.get("statusLine").and_then(|s| str_of(s, "command")) {
        out.push(item(TrustKind::Command, Some(rel), "statusLine", c, None));
    }
    for (name, on) in json.get("enabledPlugins").and_then(Value::as_object).into_iter().flatten() {
        if truthy(on) {
            out.push(item(TrustKind::Plugin, Some(rel), name, &format!("plugin {name}"), None));
        }
    }
    out
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Each server in `.mcp.json`: its command line (or URL), and the names of the env it is given.
pub fn mcp_items(text: Option<&str>, rel: &str) -> Vec<TrustItem> {
    let Some(json) = parse(text) else { return Vec::new() };
    let mut out = Vec::new();
    for (name, s) in json.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
        if !s.is_object() {
            continue;
        }
        let command = match (str_of(s, "command"), str_of(s, "url")) {
            (Some(c), _) => std::iter::once(c).chain(s.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)).collect::<Vec<_>>().join(" "),
            (None, Some(u)) => u.to_owned(),
            (None, None) => s.to_string(),
        };
        let extra = s.get("env").and_then(Value::as_object).map(|e| e.keys().cloned().collect::<Vec<_>>());
        out.push(item(TrustKind::Mcp, Some(rel), name, &command, extra));
    }
    out
}

/// The setup steps a new worktree would run, as the card lists them.
pub fn setup_items(file: Option<&str>, commands: &[String]) -> Vec<TrustItem> {
    commands.iter().enumerate().map(|(i, c)| item(TrustKind::Setup, file, &format!("step {}", i + 1), c, None)).collect()
}

/// Does trust ask at all? Not with `projectAsk: off`, and never in Full auto.
pub fn asks(project_ask: Option<&str>, mode: &str) -> bool {
    project_ask != Some("off") && mode != "auto"
}

/// `to` relative to `from` with '/' (both absolute, normalised): `../../.claude/settings.json`.
pub fn relative(from: &str, to: &str) -> String {
    let a: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let ups = std::iter::repeat_n("..", a.len() - common);
    ups.chain(b[common..].iter().copied()).collect::<Vec<_>>().join("/")
}

/// The folders whose Claude files count for a run in `at` inside checkout `top`: both, once, never home.
pub fn claude_dirs<'a>(at: &'a str, top: &'a str, home: &str) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for d in [at, top] {
        if d != home && !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedRepo {
    pub ids: Vec<String>,
    #[serde(default)]
    pub at: i64,
}

/// What was trusted, per repo key. v1's `project-trust.json` `{ repos: {...} }` imports as is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustState {
    pub repos: BTreeMap<String, TrustedRepo>,
}

impl TrustState {
    pub fn trusted(&self, key: &str, id: &str) -> bool {
        self.repos.get(key).is_some_and(|r| r.ids.iter().any(|x| x == id))
    }

    /// The items not trusted yet (each once), or None. `changed`: something here was trusted before.
    pub fn untrusted(&self, key: &str, items: Vec<TrustItem>) -> Option<Pending> {
        let mut seen = std::collections::HashSet::new();
        let open: Vec<TrustItem> = items.into_iter().filter(|x| seen.insert(x.id.clone()) && !self.trusted(key, &x.id)).collect();
        let changed = self.repos.get(key).is_some_and(|r| !r.ids.is_empty());
        (!open.is_empty()).then(|| Pending { key: key.to_owned(), items: open, changed })
    }

    pub fn trust(&mut self, key: &str, ids: &[String], now: i64) {
        let r = self.repos.entry(key.to_owned()).or_default();
        for id in ids {
            if !r.ids.contains(id) {
                r.ids.push(id.clone());
            }
        }
        r.at = now;
    }
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod tests;
