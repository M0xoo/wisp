//! `codex exec --json …` for one run (v1 codex.js `run()`'s argv). The prompt goes on stdin.

use std::collections::BTreeMap;

use serde_json::Value;

/// A lean run (the retro) only reads its prompt and answers: none of codex's extras (v1 `LEAN_FEATURES`).
pub const LEAN_FEATURES: [&str; 8] =
    ["plugins", "apps", "multi_agent", "skill_search", "browser_use", "computer_use", "goals", "code_mode_host"];
/// The one-line base prompt a lean run gets instead of the coding agent's (v1 `LEAN_BASE`).
pub const LEAN_BASE: &str = "You answer in one message. Do not run tools, read files or edit anything.";
/// `ask_user` may wait a week (v1 `ASK_TIMEOUT_MS / 1000`).
pub const ASK_TIMEOUT_S: u64 = 7 * 24 * 3600;

/// What the argv depends on. `mode`: `plan` | `edits` | `auto`.
#[derive(Debug, Clone, Default)]
pub struct CodexArgs<'a> {
    pub mode: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    /// the task's other folders, writable like cwd
    pub dirs: &'a [String],
    pub resume_id: Option<&'a str>,
    pub fork: bool,
    pub capped: bool,
    /// a lean run: the base prompt file's path
    pub lean_base: Option<&'a str>,
    /// wisp's protocol as developer instructions (codex ≥ 0.53, not Windows, not set in config.toml)
    pub developer: Option<&'a str>,
    pub mcp_servers: Option<&'a BTreeMap<String, Value>>,
    /// image attachments (`-i`)
    pub images: &'a [String],
    /// the folders of the other attachments (`--add-dir`, new threads only)
    pub attachment_dirs: &'a [String],
}

/// v1's `toml`: arrays and inline tables, scalars as JSON.
pub fn toml(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(toml).collect::<Vec<_>>().join(",")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, x)| format!("{k}={}", toml(x))).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

fn s(v: &str) -> String {
    toml(&Value::String(v.to_owned()))
}

pub fn args(a: &CodexArgs<'_>) -> Vec<String> {
    let mut out: Vec<String> = ["exec", "--json", "--skip-git-repo-check"].map(str::to_owned).to_vec();
    let c = |out: &mut Vec<String>, kv: String| {
        out.push("-c".into());
        out.push(kv);
    };
    if let Some(base) = a.lean_base {
        for f in LEAN_FEATURES {
            c(&mut out, format!("features.{f}=false"));
        }
        c(&mut out, format!("model_instructions_file={}", s(base)));
    }
    if let Some(dev) = a.developer.map(str::trim).filter(|d| !d.is_empty()) {
        c(&mut out, format!("developer_instructions={}", s(dev)));
    }
    if a.mode == "auto" {
        out.push("--dangerously-bypass-approvals-and-sandbox".into());
    } else {
        c(&mut out, format!("sandbox_mode={}", s(if a.mode == "plan" { "read-only" } else { "workspace-write" })));
    }
    if a.capped && a.mode != "auto" {
        c(&mut out, "sandbox_workspace_write.network_access=false".into());
    }
    if !a.dirs.is_empty() && a.mode != "auto" {
        c(&mut out, format!("sandbox_workspace_write.writable_roots={}", toml(&Value::from(a.dirs.to_vec()))));
    }
    if !a.model.is_empty() {
        out.push("-m".into());
        out.push(a.model.into());
    }
    if !a.effort.is_empty() {
        c(&mut out, format!("model_reasoning_effort={}", s(a.effort)));
    }
    for (name, srv) in a.mcp_servers.into_iter().flatten() {
        let key = format!("mcp_servers.{name}");
        if let Some(url) = srv.get("url").and_then(Value::as_str) {
            // a streamable-HTTP server (wisp's own, in v2)
            c(&mut out, format!("{key}.url={}", s(url)));
            if let Some(h) = srv.get("headers").filter(|h| h.as_object().is_some_and(|o| !o.is_empty())) {
                c(&mut out, format!("{key}.http_headers={}", toml(h)));
            }
        } else {
            c(&mut out, format!("{key}.command={}", toml(srv.get("command").unwrap_or(&Value::Null))));
            c(&mut out, format!("{key}.args={}", toml(srv.get("args").filter(|x| !x.is_null()).unwrap_or(&Value::Array(Vec::new())))));
            if let Some(env) = srv.get("env").filter(|e| !e.is_null()) {
                c(&mut out, format!("{key}.env={}", toml(env)));
            }
        }
        c(&mut out, format!("{key}.tool_timeout_sec={ASK_TIMEOUT_S}"));
        // wisp's own tools need no approval: outside Full auto, exec's approval policy refuses every MCP call
        c(&mut out, format!("{key}.default_tools_approval_mode={}", s("approve")));
    }
    for img in a.images {
        out.push("-i".into());
        out.push(img.clone());
    }
    let resume = a.resume_id.filter(|r| !r.is_empty());
    if resume.is_none() {
        let mut seen = std::collections::BTreeSet::new();
        for d in a.dirs.iter().chain(a.attachment_dirs) {
            if seen.insert(d.clone()) {
                out.push("--add-dir".into());
                out.push(d.clone());
            }
        }
    }
    if let Some(r) = resume {
        out.push(if a.fork { "fork" } else { "resume" }.into());
        out.push(r.into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mcp_servers_go_through_config() {
        let mut m = BTreeMap::new();
        m.insert("wisp".to_owned(), json!({ "type": "http", "url": "http://127.0.0.1:1/api/mcp", "headers": { "x-wisp-token": "t" } }));
        m.insert("x".to_owned(), json!({ "command": "node", "args": ["s.js"], "env": { "A": "1" } }));
        let a = args(&CodexArgs { mode: "edits", mcp_servers: Some(&m), ..CodexArgs::default() }).join(" ");
        assert!(a.contains(r#"-c mcp_servers.wisp.url="http://127.0.0.1:1/api/mcp" -c mcp_servers.wisp.http_headers={x-wisp-token="t"} -c mcp_servers.wisp.tool_timeout_sec=604800 -c mcp_servers.wisp.default_tools_approval_mode="approve""#), "{a}");
        assert!(a.contains(r#"-c mcp_servers.x.command="node" -c mcp_servers.x.args=["s.js"] -c mcp_servers.x.env={A="1"}"#), "{a}");
    }

    #[test]
    fn developer_instructions_and_images() {
        let imgs = vec!["/up/a.png".to_owned()];
        let a =
            args(&CodexArgs { mode: "plan", developer: Some(" # You are running inside wisp\n"), images: &imgs, ..CodexArgs::default() });
        assert!(a.iter().any(|x| x == r##"developer_instructions="# You are running inside wisp""##));
        assert!(a.windows(2).any(|w| w == ["-i", "/up/a.png"]));
    }
}
