//! What a task had and what it used (ADR-0029): at its first run, the skills wisp gave it (and the ones the
//! harness finds by itself, by hash), every MCP server (then, in the background, its version and tools from
//! `initialize` / `tools/list`, once per configuration), the harness, model, mode and permissions. What it
//! used is read from its activity when asked (`runtime.setup`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use wisp_runtime_api::harness::HarnessRun;
use wisp_runtime_api::model::{Activity, Session, Step};

use crate::schema::SETUP;

fn hash(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().take(8).fold(String::new(), |mut s, b| {
        let _ = std::fmt::Write::write_fmt(&mut s, format_args!("{b:02x}"));
        s
    })
}

/// Skills the harness picks up by itself: `<dir>/*/SKILL.md`, by name and hash.
pub fn skills_in(dir: &Path, from: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if let Ok(b) = std::fs::read(e.path().join("SKILL.md")) {
            out.push(json!({ "name": e.file_name().to_string_lossy(), "source": from, "hash": hash(&b), "outside": true }));
        }
    }
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

fn claude_config() -> PathBuf {
    std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()).map_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude"), PathBuf::from)
}

/// What a run had, as recorded at its first turn (MCP servers not yet probed).
pub fn available(s: &Session, run: &HarnessRun, harness: &str) -> Value {
    let brief = s.ext.get("wisp.runtime").and_then(|o| o.get("brief")).cloned().unwrap_or_default();
    let mut skills: Vec<Value> = brief.get("skills").and_then(Value::as_array).into_iter().flatten().map(|k| json!({ "name": k["name"], "source": "wisp", "hash": hash(k["body"].as_str().unwrap_or_default().as_bytes()), "outside": false })).collect();
    if harness == "claude" {
        skills.extend(skills_in(&claude_config().join("skills"), "~/.claude/skills"));
        skills.extend(skills_in(&Path::new(&run.cwd).join(".claude/skills"), ".claude/skills"));
    }
    let servers: Vec<Value> = run
        .mcp_servers
        .iter()
        .map(|(name, c)| {
            let at = c.get("url").and_then(Value::as_str).map_or_else(|| format!("{} {}", c["command"].as_str().unwrap_or_default(), c["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")).unwrap_or_default()).trim().to_owned(), str::to_owned);
            json!({ "name": name, "at": at, "probe": "pending" })
        })
        .collect();
    let mode = serde_json::to_value(run.mode).unwrap_or_default();
    json!({ "harness": harness, "model": run.model, "effort": run.effort, "mode": mode, "permissions": { "untrusted": run.untrusted, "grants": run.grants, "lean": run.lean }, "skills": skills, "mcpServers": servers })
}

/// A server's answers to `initialize` and `tools/list`: (version, tools), or why not.
fn read_probe(text: &str) -> Result<(String, Vec<String>), String> {
    let mut version = None;
    let mut tools = None;
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim().trim_start_matches("data:").trim()).ok()) {
        if let Some(info) = v.pointer("/result/serverInfo") {
            version = Some(info.get("version").and_then(Value::as_str).unwrap_or_default().to_owned());
        }
        if let Some(list) = v.pointer("/result/tools").and_then(Value::as_array) {
            tools = Some(list.iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect());
        }
    }
    match (version, tools) {
        (Some(v), t) => Ok((v, t.unwrap_or_default())),
        (None, _) => Err("it didn't answer initialize".into()),
    }
}

const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wisp","version":"2"}}}"#;
const INITIALIZED: &str = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
/// How long a server gets to answer `initialize` and `tools/list`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const LIST: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;

/// Probes already made, by the server's configuration (a server is asked once per process).
fn cache() -> &'static Mutex<HashMap<String, Value>> {
    static C: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    C.get_or_init(Mutex::default)
}

async fn probe(proc: &wisp_proc::Proc, net: Option<&wisp_kernel::services::NetService>, c: &Value) -> Value {
    let key = c.to_string();
    if let Some(v) = cache().lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
        return v.clone();
    }
    let got = if let Some(url) = c.get("url").and_then(Value::as_str) {
        match net {
            Some(n) => {
                let mut headers: Vec<(String, String)> = c.get("headers").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect();
                headers.push(("content-type".into(), "application/json".into()));
                headers.push(("accept".into(), "application/json, text/event-stream".into()));
                let body = format!("[{INIT},{INITIALIZED},{LIST}]");
                match n.fetch(wisp_kernel::services::NetRequest { method: "POST".into(), url: url.to_owned(), headers, body: body.into_bytes(), timeout_ms: 5000 }).await {
                    Ok(r) => {
                        let text = String::from_utf8_lossy(&r.body).replace("},{\"jsonrpc\"", "}\n{\"jsonrpc\"").trim_start_matches('[').trim_end_matches(']').to_owned();
                        read_probe(&text)
                    }
                    Err(e) => Err(e.message),
                }
            }
            None => Err("no network here to ask it".into()),
        }
    } else {
        let cmd = c.get("command").and_then(Value::as_str).unwrap_or_default();
        let args: Vec<String> = c.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(|a| a.as_str().map(str::to_owned)).collect();
        let mut env = wisp_proc::Env::default();
        for (k, v) in c.get("env").and_then(Value::as_object).into_iter().flatten() {
            if let Some(v) = v.as_str() {
                env.set.push((k.clone(), v.to_owned()));
            }
        }
        let opts = wisp_proc::ExecOpts { input: Some(format!("{INIT}\n{INITIALIZED}\n{LIST}\n").into_bytes()), timeout: Some(PROBE_TIMEOUT), env, max_output: 4 << 20, ..wisp_proc::ExecOpts::default() };
        match proc.exec(cmd, &args, opts).await {
            Ok(r) if r.timed_out => Err(format!("timed out after {} s", PROBE_TIMEOUT.as_secs())),
            Ok(r) => read_probe(&r.stdout_text()),
            Err(e) => Err(e.to_string()),
        }
    };
    let v = match got {
        Ok((version, tools)) => json!({ "probe": "ok", "version": version, "tools": tools }),
        Err(why) => json!({ "probe": "failed", "why": why }),
    };
    cache().lock().unwrap_or_else(PoisonError::into_inner).insert(key, v.clone());
    v
}

pub async fn save(store: &wisp_store::Store, id: &str, body: Value) {
    let id = id.to_owned();
    let _ = store
        .write(move |w| {
            let mut r = wisp_store::Row::new();
            r.insert("id".into(), json!(id));
            r.insert("body".into(), body);
            w.upsert(SETUP.kind, r).map(|_| ())
        })
        .await;
}

pub async fn load(store: &wisp_store::Store, id: &str) -> Option<Value> {
    let id = id.to_owned();
    store.read_async(move |r| r.get(SETUP.kind, id.as_str())).await.ok().flatten().and_then(|r| r.get("body").cloned())
}

/// Records `available` now, then probes its MCP servers and records them again (the run doesn't wait).
pub fn record(store: wisp_store::Store, proc: Arc<wisp_proc::Proc>, net: Option<wisp_kernel::services::NetService>, id: String, available: Value, servers: Vec<(String, Value)>, spawn: &dyn Fn(wisp_kernel::BoxFuture<'static, ()>)) {
    spawn(Box::pin(async move {
        save(&store, &id, available.clone()).await;
        let mut a = available;
        let mut list = Vec::new();
        for (name, cfg) in servers {
            let mut entry = a["mcpServers"].as_array().and_then(|l| l.iter().find(|s| s["name"] == name.as_str()).cloned()).unwrap_or_else(|| json!({ "name": name }));
            if let (Some(e), Value::Object(p)) = (entry.as_object_mut(), probe(&proc, net.as_ref(), &cfg).await) {
                e.extend(p);
            }
            list.push(entry);
        }
        a["mcpServers"] = Value::Array(list);
        save(&store, &id, a).await;
    }));
}

/// What a task used, from its activity.
pub fn used(steps: &[Step]) -> Value {
    let (mut skills, mut mcp, mut builtin): (Map<String, Value>, Map<String, Value>, Map<String, Value>) = (Map::new(), Map::new(), Map::new());
    let mut blocked = Vec::new();
    let bump = |m: &mut Map<String, Value>, k: &str| {
        let n = m.get(k).and_then(Value::as_u64).unwrap_or(0) + 1;
        m.insert(k.to_owned(), json!(n));
    };
    for s in steps {
        match &s.activity {
            Activity::Tool { tool, label, .. } => {
                if let Some(name) = label.strip_prefix("Using the ").and_then(|r| r.strip_suffix(" skill")) {
                    bump(&mut skills, name);
                } else if let Some((server, t)) = label.strip_prefix("Using ").and_then(|r| r.split_once(" · ")) {
                    bump(&mut mcp, &format!("{server} · {t}"));
                } else {
                    bump(&mut builtin, serde_json::to_value(tool).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default().as_str());
                }
            }
            Activity::Blocked { tool, detail, .. } => blocked.push(json!({ "tool": tool, "detail": detail })),
            _ => {}
        }
    }
    json!({ "skills": skills, "mcpTools": mcp, "builtin": builtin, "blocked": blocked })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_runtime_api::model::ToolKind;

    fn tool(kind: ToolKind, label: &str) -> Step {
        Step { seq: 0, t: 0, activity: Activity::Tool { tool: kind, label: label.into(), file: None, detail: None, call_id: None, output: None } }
    }

    #[test]
    fn used_is_read_from_the_transcript() {
        let steps = vec![
            tool(ToolKind::Tool, "Using the release-notes skill"),
            tool(ToolKind::Tool, "Using linear · create_issue"),
            tool(ToolKind::Tool, "Using linear · create_issue"),
            tool(ToolKind::Edit, "Editing math.js"),
            Step { seq: 1, t: 0, activity: Activity::Blocked { tool: "Bash".into(), detail: "rm -rf /".into(), rule: None } },
        ];
        let u = used(&steps);
        assert_eq!(u["skills"], json!({ "release-notes": 1 }));
        assert_eq!(u["mcpTools"], json!({ "linear · create_issue": 2 }));
        assert_eq!(u["builtin"], json!({ "edit": 1 }));
        assert_eq!(u["blocked"][0]["tool"], "Bash");
    }

    #[test]
    fn a_probe_reads_initialize_and_the_tool_list() {
        let text = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"x\",\"version\":\"1.4.0\"}}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"do_x\"}]}}";
        assert_eq!(read_probe(text), Ok(("1.4.0".into(), vec!["do_x".into()])));
        assert!(read_probe("nothing").is_err());
    }
}
