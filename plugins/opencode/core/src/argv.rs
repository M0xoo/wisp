//! `opencode run --format json …` for one run, and the inline config it carries (v1 opencode.js
//! `run()`): wisp's MCP server, the grants the user allowed, a capped run's asks, merged over the
//! user's own `OPENCODE_CONFIG_CONTENT`.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use wisp_harness_kit::Re;
use wisp_harness_kit::protocol::ASK_TIMEOUT_MS;

static MAJOR: Re = Re::new(r"(?:^|\s)v?(\d+)\.\d+");
static ANSI: Re = Re::new(r"\x1b\[[0-9;]*m");
static CREDS: Re = Re::new(r"(\d+) credentials?");
static ENV_KEYS: Re = Re::new(r"[1-9]\d* environment variables?");

/// opencode 2 changed `run`: lowercase log levels, and the effort rides on the model (`model#high`).
pub fn major_version(version: &str) -> u64 {
    MAJOR.group(version, 1).and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// `opencode auth list`: a provider signed in, or a key in the environment. None: output we don't know.
pub fn has_key(out: &str) -> Option<bool> {
    let text = ANSI.replace_all(out, "");
    let n: u64 = CREDS.group(&text, 1)?.parse().ok()?;
    Some(n > 0 || ENV_KEYS.is_match(&text))
}

#[derive(Debug, Clone, Default)]
pub struct OpencodeArgs<'a> {
    /// `plan` | `edits` | `auto`
    pub mode: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub resume_id: Option<&'a str>,
    pub fork: bool,
    pub attachments: &'a [String],
    pub v2: bool,
}

pub fn args(a: &OpencodeArgs<'_>) -> Vec<String> {
    let mut out: Vec<String> =
        ["run", "--format", "json", "--print-logs", "--log-level", if a.v2 { "error" } else { "ERROR" }].map(str::to_owned).to_vec();
    let mut push = |x: &[&str]| out.extend(x.iter().map(|s| (*s).to_owned()));
    if a.mode == "plan" {
        push(&["--agent", "plan"]);
    }
    if a.mode == "auto" {
        push(&["--auto"]);
    }
    if !a.model.is_empty() {
        let m = if a.v2 && !a.effort.is_empty() { format!("{}#{}", a.model, a.effort) } else { a.model.to_owned() };
        push(&["--model", &m]);
        if !a.effort.is_empty() && !a.v2 {
            push(&["--variant", a.effort]);
        }
    }
    if let Some(r) = a.resume_id.filter(|r| !r.is_empty()) {
        push(&["--session", r]);
        if a.fork {
            push(&["--fork"]);
        }
    }
    for f in a.attachments {
        push(&["--file", f]);
    }
    out
}

/// A grant the user allowed after `run` rejected it: v1's `{permission, patterns}`, which travels as
/// its JSON string in the runtime's grants.
fn grant(g: &str) -> Option<(String, Vec<String>)> {
    let v: Value = serde_json::from_str(g).ok()?;
    let p = v["permission"].as_str()?.to_owned();
    let pats = v["patterns"].as_array()?.iter().map(wisp_harness_kit::js::string).collect();
    Some((p, pats))
}

/// One MCP server in opencode's terms: a URL is `remote`, a command `local`.
fn server(srv: &Value) -> Value {
    if let Some(url) = srv["url"].as_str() {
        return json!({ "type": "remote", "url": url, "headers": srv.get("headers").cloned().unwrap_or_else(|| json!({})), "enabled": true, "timeout": ASK_TIMEOUT_MS });
    }
    let mut command = vec![srv["command"].clone()];
    command.extend(srv["args"].as_array().cloned().unwrap_or_default());
    json!({ "type": "local", "command": command, "environment": srv.get("env").filter(|e| !e.is_null()).cloned().unwrap_or_else(|| json!({})), "enabled": true, "timeout": ASK_TIMEOUT_MS })
}

/// The `OPENCODE_CONFIG_CONTENT` for a run, over `inline` (the user's own); None: nothing to add.
pub fn config(
    inline: Option<&str>,
    mcp_servers: &BTreeMap<String, Value>,
    grants: &[String],
    mode: &str,
    delegating: bool,
    capped: bool,
) -> Option<String> {
    let allow: Vec<(String, Vec<String>)> = grants.iter().filter_map(|g| grant(g)).collect();
    if mcp_servers.is_empty() && allow.is_empty() && !capped {
        return None;
    }
    let inline: Map<String, Value> =
        inline.and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut permission: Map<String, Value> = match inline.get("permission") {
        Some(Value::Object(o)) => o.clone(),
        Some(v) if wisp_harness_kit::js::truthy(v) => Map::from_iter([("*".to_owned(), v.clone())]),
        _ => Map::new(),
    };
    // its built-in `task` subagents would bypass the user's team
    if delegating {
        permission.insert("task".into(), json!("deny"));
    }
    // capped: no sandbox, so commands and fetches wait for the user (Allow retries exactly that)
    if capped && mode != "auto" {
        permission.insert("bash".into(), json!("ask"));
        permission.insert("webfetch".into(), json!("ask"));
    }
    for (p, pats) in &allow {
        let mut m = match permission.get(p) {
            Some(Value::Object(o)) => o.clone(),
            Some(v) if wisp_harness_kit::js::truthy(v) => Map::from_iter([("*".to_owned(), v.clone())]),
            _ => Map::new(),
        };
        for x in pats {
            m.insert(x.clone(), json!("allow"));
        }
        permission.insert(p.clone(), Value::Object(m));
    }
    let mut out = inline.clone();
    if !mcp_servers.is_empty() {
        let mut mcp = inline.get("mcp").and_then(Value::as_object).cloned().unwrap_or_default();
        for (name, srv) in mcp_servers {
            mcp.insert(name.clone(), server(srv));
        }
        out.insert("mcp".into(), Value::Object(mcp));
        let mut exp = inline.get("experimental").and_then(Value::as_object).cloned().unwrap_or_default();
        exp.insert("mcp_timeout".into(), json!(ASK_TIMEOUT_MS));
        out.insert("experimental".into(), Value::Object(exp));
    }
    if !permission.is_empty() {
        out.insert("permission".into(), Value::Object(permission));
    }
    Some(Value::Object(out).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_keys() {
        for p in [&MAJOR, &ANSI, &CREDS, &ENV_KEYS] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        assert_eq!(major_version("2.0.1"), 2);
        assert_eq!(major_version("opencode v1.14.3"), 1);
        assert_eq!(has_key("┌  Credentials\n└  1 credentials"), Some(true));
        assert_eq!(has_key("└  0 credentials\n\n2 environment variables"), Some(true));
        assert_eq!(has_key("└  0 credentials"), Some(false));
        assert_eq!(has_key("what"), None);
    }

    #[test]
    fn v2_puts_the_effort_on_the_model() {
        let a = args(&OpencodeArgs { mode: "edits", model: "fake/m", effort: "high", v2: true, ..OpencodeArgs::default() });
        assert_eq!(a, ["run", "--format", "json", "--print-logs", "--log-level", "error", "--model", "fake/m#high"]);
    }

    #[test]
    fn the_inline_config_merges_over_the_users() {
        // v1 adapters.test.js "opencode: grants and wisp's server go in OPENCODE_CONFIG_CONTENT"
        let mut m = BTreeMap::new();
        m.insert("wisp".to_owned(), json!({ "type": "http", "url": "http://127.0.0.1:1/api/mcp", "headers": { "x-wisp-token": "t" } }));
        let g = vec![json!({ "permission": "bash", "patterns": ["npm publish"] }).to_string()];
        let c: Value = serde_json::from_str(
            &config(Some(r#"{"permission":{"bash":"ask"},"mcp":{"mine":{"type":"local"}},"theme":"x"}"#), &m, &g, "edits", true, false)
                .unwrap_or_default(),
        )
        .unwrap_or_default();
        assert_eq!(c["theme"], "x");
        assert_eq!(c["mcp"]["mine"]["type"], "local");
        assert_eq!(c["mcp"]["wisp"]["type"], "remote");
        assert_eq!(c["mcp"]["wisp"]["headers"]["x-wisp-token"], "t");
        assert_eq!(c["permission"]["bash"], json!({ "*": "ask", "npm publish": "allow" }));
        assert_eq!(c["permission"]["task"], "deny");
        assert!(config(None, &BTreeMap::new(), &[], "edits", false, false).is_none());
        let capped: Value =
            serde_json::from_str(&config(None, &BTreeMap::new(), &[], "edits", false, true).unwrap_or_default()).unwrap_or_default();
        assert_eq!(capped["permission"]["webfetch"], "ask");
    }
}
