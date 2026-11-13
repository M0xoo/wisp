//! What the harnesses already have in their own config, by name (v1 server/connectors.js `sources`):
//! skipped when a turn's servers are made (Codex would merge two definitions into one broken server,
//! Claude would list every tool twice), and offered for import in Settings. Sans-IO: the host reads
//! the files each [`HarnessMcp`] names and hands their texts in.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::{Map, Value};
use wisp_connectors_api::{Connector, ConnectorBody, FoundServer, HarnessMcp, SecretInput, Transport, Where};

use crate::codex_toml::codex_servers;
use crate::text::slug;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Claude,
    Codex,
    Copilot,
    Opencode,
    Cursor,
    /// takes servers per turn, keeps none of its own that wisp reads
    Bare,
}

/// v1's harnesses, as contributions to `connectors.harness@1` (until each harness plugin adds its own).
#[derive(Debug, Clone)]
pub struct Builtin {
    agent: &'static str,
    label: &'static str,
    per_turn: bool,
    kind: Kind,
}

/// In v1's order (the order a found server's `from` lists them in).
pub fn builtins() -> Vec<Builtin> {
    vec![
        Builtin { agent: "claude", label: "Claude Code", per_turn: true, kind: Kind::Claude },
        Builtin { agent: "codex", label: "Codex", per_turn: true, kind: Kind::Codex },
        Builtin { agent: "copilot", label: "Copilot", per_turn: true, kind: Kind::Copilot },
        Builtin { agent: "opencode", label: "OpenCode", per_turn: true, kind: Kind::Opencode },
        Builtin { agent: "cursor", label: "Cursor", per_turn: false, kind: Kind::Cursor },
        Builtin { agent: "grok", label: "Grok", per_turn: true, kind: Kind::Bare },
    ]
}

fn json(text: Option<&String>) -> Map<String, Value> {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| if let Value::Object(m) = v { Some(m) } else { None })
        .unwrap_or_default()
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

fn into_tree(m: Map<String, Value>) -> BTreeMap<String, Value> {
    m.into_iter().collect()
}

fn claude(texts: &[Option<String>], cwd: Option<&str>) -> BTreeMap<String, Value> {
    let user = json(texts.first().and_then(Option::as_ref));
    let mut out = into_tree(obj(user.get("mcpServers")));
    if let Some(cwd) = cwd {
        let projects = obj(user.get("projects"));
        out.extend(obj(obj(projects.get(cwd)).get("mcpServers")));
        out.extend(obj(json(texts.get(1).and_then(Option::as_ref)).get("mcpServers")));
    }
    out
}

fn codex(text: Option<&String>) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (name, mut s) in codex_servers(text.map_or("", String::as_str)) {
        let mut headers = obj(s.get("http_headers"));
        if let Some(Value::String(t)) = s.get("bearer_token").filter(|t| t.as_str().is_some_and(|t| !t.is_empty())) {
            headers.insert("Authorization".into(), Value::String(format!("Bearer {t}")));
        }
        s.insert("headers".into(), Value::Object(headers));
        out.insert(name, Value::Object(s));
    }
    out
}

fn opencode(text: Option<&String>) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (name, raw) in obj(json(text).get("mcp")) {
        let s = obj(Some(&raw));
        let entry = if s.get("type").and_then(Value::as_str) == Some("remote") {
            serde_json::json!({ "url": s.get("url"), "headers": s.get("headers") })
        } else {
            let cmd: Vec<String> = s.get("command").and_then(Value::as_array).map(|a| a.iter().map(as_text).collect()).unwrap_or_default();
            serde_json::json!({ "command": cmd.first(), "args": cmd.get(1..).unwrap_or_default(), "env": s.get("environment") })
        };
        out.insert(name, entry);
    }
    out
}

fn dir(w: &Where, var: &str, fallback: &[&str]) -> PathBuf {
    w.var(var).map_or_else(|| fallback.iter().fold(w.home.clone(), |p, s| p.join(s)), PathBuf::from)
}

impl HarnessMcp for Builtin {
    fn agent(&self) -> &str {
        self.agent
    }
    fn label(&self) -> &str {
        self.label
    }
    fn per_turn(&self) -> bool {
        self.per_turn
    }
    fn files(&self, w: &Where, cwd: Option<&str>) -> Vec<PathBuf> {
        match self.kind {
            Kind::Claude => {
                let user =
                    w.var("CLAUDE_CONFIG_DIR").map_or_else(|| w.home.join(".claude.json"), |d| PathBuf::from(d).join(".claude.json"));
                std::iter::once(user).chain(cwd.map(|c| PathBuf::from(c).join(".mcp.json"))).collect()
            }
            Kind::Codex => vec![dir(w, "CODEX_HOME", &[".codex"]).join("config.toml")],
            Kind::Copilot => vec![dir(w, "COPILOT_HOME", &[".copilot"]).join("mcp-config.json")],
            Kind::Opencode => vec![dir(w, "XDG_CONFIG_HOME", &[".config"]).join("opencode").join("opencode.json")],
            Kind::Cursor => vec![w.home.join(".cursor").join("mcp.json")],
            Kind::Bare => Vec::new(),
        }
    }
    fn servers(&self, texts: &[Option<String>], cwd: Option<&str>) -> BTreeMap<String, Value> {
        let first = texts.first().and_then(Option::as_ref);
        match self.kind {
            Kind::Claude => claude(texts, cwd),
            Kind::Codex => codex(first),
            Kind::Copilot | Kind::Cursor => into_tree(obj(json(first).get("mcpServers"))),
            Kind::Opencode => opencode(first),
            Kind::Bare => BTreeMap::new(),
        }
    }
}

/// One harness's servers, as read.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub agent: String,
    pub label: String,
    pub servers: BTreeMap<String, Value>,
}

/// harness id → the server names its own config already has.
pub fn own_names(sources: &[Source]) -> BTreeMap<String, BTreeSet<String>> {
    sources.iter().map(|s| (s.agent.clone(), s.servers.keys().cloned().collect())).collect()
}

/// `String(v ?? '')`
fn as_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    obj(v).into_iter().map(|(k, v)| (k, as_text(&v))).collect()
}

/// A found server with its secret values, for the import itself (never sent to the page).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub from: Vec<String>,
    pub transport: Transport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    /// env (local) or headers (remote), with values
    pub secrets: BTreeMap<String, String>,
}

impl Found {
    /// What the page sees: key names only.
    pub fn public(&self) -> FoundServer {
        let keys = Some(self.secrets.keys().cloned().collect());
        let local = self.transport == Transport::Local;
        FoundServer {
            name: self.name.clone(),
            from: self.from.clone(),
            transport: self.transport,
            command: local.then(|| self.command.clone()),
            args: local.then(|| self.args.clone()),
            url: (!local).then(|| self.url.clone()),
            env: if local { keys.clone() } else { None },
            headers: if local { None } else { keys },
        }
    }

    /// The body that imports it, values and all.
    pub fn body(&self) -> ConnectorBody {
        let secrets = Some(SecretInput::Map(self.secrets.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect()));
        let local = self.transport == Transport::Local;
        ConnectorBody {
            name: Some(self.name.clone()),
            transport: Some(if local { "local" } else { "remote" }.into()),
            command: local.then(|| self.command.clone()),
            args: local.then(|| self.args.clone()),
            url: (!local).then(|| self.url.clone()),
            env: if local { secrets.clone() } else { None },
            headers: if local { None } else { secrets },
            enabled: None,
        }
    }
}

/// `{url | serverUrl, headers}` is remote, `{command, args, env}` local; anything else is skipped.
fn shape(name: String, label: &str, raw: &Value) -> Option<Found> {
    let s = obj(Some(raw));
    let url = ["url", "serverUrl"].iter().find_map(|k| s.get(*k).and_then(Value::as_str).filter(|u| !u.is_empty()));
    let base = Found {
        name,
        from: vec![label.to_owned()],
        transport: Transport::Remote,
        command: String::new(),
        args: Vec::new(),
        url: String::new(),
        secrets: BTreeMap::new(),
    };
    if let Some(url) = url {
        return Some(Found { url: url.to_owned(), secrets: str_map(s.get("headers")), ..base });
    }
    let command = s.get("command").and_then(Value::as_str).filter(|c| !c.is_empty())?;
    let args = s.get("args").and_then(Value::as_array).map(|a| a.iter().map(as_text).collect()).unwrap_or_default();
    Some(Found { transport: Transport::Local, command: command.to_owned(), args, secrets: str_map(s.get("env")), ..base })
}

/// Servers in the harnesses' own configs that aren't connectors yet: one entry per name (slugged),
/// listing every config it's in. `wisp` is never offered (it's wisp's own server).
pub fn found(sources: &[Source], list: &[Connector]) -> Vec<Found> {
    let have: BTreeSet<&str> = list.iter().map(|c| c.name.as_str()).collect();
    let mut out: Vec<Found> = Vec::new();
    for src in sources {
        for (raw, s) in &src.servers {
            let name = slug(raw);
            if name.is_empty() || name == "wisp" || have.contains(name.as_str()) {
                continue;
            }
            let Some(f) = shape(name, &src.label, s) else { continue };
            if let Some(was) = out.iter_mut().find(|x| x.name == f.name) {
                if !was.from.contains(&src.label) {
                    was.from.push(src.label.clone());
                }
                continue;
            }
            out.push(f);
        }
    }
    out
}
