//! wisp.copilot core (sans-IO): `copilot --output-format json`'s parser (v1 adapters/copilot.js), its
//! tool sentences, the refused-permission cards with their `--allow-tool` rules, and the argv.
//! What v1 read from disk is left out: copilot's usage file (the turn reports its duration, not its
//! tokens) and whether `view` named a folder (it reads as a file unless the path ends in `/`).

mod describe;

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::{ASK_TIMEOUT_MS, exit_text};
use wisp_harness_kit::{Change, Edit, Exit, HarnessEvent, IoStep, LineParser, Out, Re, RunPaths, Stats, TurnResult, clip, json_line, rel_value};

pub use describe::{blocked_of, describe_mcp, describe_tool, model_ids, model_label};

static COULD_NOT: Re = Re::new(r"could-not-request");

#[derive(Debug, Clone, Default)]
pub struct CopilotArgs<'a> {
    pub mode: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub resume_id: Option<&'a str>,
    /// the id a new session is given up front
    pub session: &'a str,
    pub usage_file: &'a str,
    pub mcp_servers: Option<&'a BTreeMap<String, Value>>,
    /// `--allow-tool` rules the user allowed
    pub grants: &'a [String],
    pub delegating: bool,
    pub images: &'a [String],
    /// the task's other folders and the attachments' folders
    pub dirs: &'a [String],
}

/// One MCP server as copilot's `--additional-mcp-config` has it: a URL is `http`, a command `local`.
fn server(srv: &Value) -> Value {
    if let Some(url) = srv["url"].as_str() {
        return json!({ "type": "http", "url": url, "headers": srv.get("headers").cloned().unwrap_or_else(|| json!({})), "tools": ["*"], "timeout": ASK_TIMEOUT_MS });
    }
    json!({ "type": "local", "command": srv["command"], "args": srv.get("args").filter(|a| !a.is_null()).cloned().unwrap_or_else(|| json!([])), "env": srv.get("env").filter(|e| !e.is_null()).cloned().unwrap_or_else(|| json!({})), "tools": ["*"], "timeout": ASK_TIMEOUT_MS })
}

pub fn args(a: &CopilotArgs<'_>) -> Vec<String> {
    let mut out: Vec<String> = vec!["--output-format".into(), "json".into()];
    match a.mode {
        "plan" => out.extend(["--mode".into(), "plan".into()]),
        "auto" => out.push("--allow-all".into()),
        _ => out.push("--allow-tool=write".into()),
    }
    match a.resume_id.filter(|r| !r.is_empty()) {
        Some(r) => out.push(format!("--resume={r}")),
        None => out.extend(["--session-id".into(), a.session.into()]),
    }
    if !a.model.is_empty() {
        out.extend(["--model".into(), a.model.into()]);
    }
    if !a.effort.is_empty() {
        out.extend(["--reasoning-effort".into(), a.effort.into()]);
    }
    out.extend(["--no-ask-user".into(), "--usage-output-file".into(), a.usage_file.into()]);
    if let Some(m) = a.mcp_servers.filter(|m| !m.is_empty()) {
        let servers: Map<String, Value> = m.iter().map(|(k, v)| (k.clone(), server(v))).collect();
        out.extend(["--additional-mcp-config".into(), json!({ "mcpServers": servers }).to_string()]);
        // its permissions would refuse an MCP call outside Full auto: wisp's own tools need no asking
        out.extend(m.keys().map(|k| format!("--allow-tool={k}")));
    }
    for g in a.grants {
        // a rule list (the blocked card's) travels as its JSON
        match serde_json::from_str::<Value>(g) {
            Ok(Value::Array(l)) => out.extend(l.iter().filter_map(Value::as_str).filter(|r| !r.is_empty()).map(|r| format!("--allow-tool={r}"))),
            _ if !g.is_empty() => out.push(format!("--allow-tool={g}")),
            _ => {}
        }
    }
    if a.delegating {
        out.push("--excluded-tools=task".into());
    }
    for i in a.images {
        out.extend(["--attachment".into(), i.clone()]);
    }
    let mut seen = Vec::new();
    for d in a.dirs {
        if !seen.contains(d) {
            seen.push(d.clone());
            out.extend(["--add-dir".into(), d.clone()]);
        }
    }
    out
}

#[derive(Debug, Default)]
pub struct CopilotParser {
    paths: RunPaths,
    session: String,
    announced: Option<String>,
    calls: HashMap<String, (String, Value)>,
    asks: HashMap<String, Value>,
    last_text: String,
    error: Option<String>,
    ended: bool,
    started: Option<i64>,
}

impl CopilotParser {
    /// `session`: the resumed session, or the id a new one was given.
    pub fn new(paths: RunPaths, session: impl Into<String>) -> Self {
        Self { paths, session: session.into(), ..Self::default() }
    }

    fn announce(&mut self, id: &str, out: &mut Vec<Out>) {
        if !id.is_empty() && self.announced.as_deref() != Some(id) {
            self.announced = Some(id.to_owned());
            out.push(HarnessEvent::session(id).into());
        }
    }

    fn finish(&mut self, result: &Value, now: i64, out: &mut Vec<Out>) {
        if self.ended {
            return;
        }
        self.ended = true;
        let code = result["exitCode"].as_i64().unwrap_or(0);
        let ok = code == 0 && self.error.is_none();
        let text = if ok { self.last_text.clone() } else { self.error.clone().unwrap_or_else(|| exit_text("copilot", i32::try_from(code).ok(), None)) };
        #[allow(clippy::cast_precision_loss)]
        let ms = result["usage"]["sessionDurationMs"].as_f64().map_or_else(|| js::json_num((now - self.started.unwrap_or(now)) as f64), js::json_num);
        let mut stats = Map::new();
        stats.insert("durationMs".into(), ms);
        let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
        out.push(HarnessEvent::Result(TurnResult { text, is_error: !ok, stats, ..TurnResult::default() }).into());
    }

    fn complete(&mut self, d: &Value, out: &mut Vec<Out>) {
        let id = js::str(&d["toolCallId"]);
        let Some((name, a)) = self.calls.remove(&id) else { return };
        if d["success"] == false {
            let why = [&d["error"]["message"], &d["result"]["content"]].into_iter().find(|v| truthy(v)).map_or_else(|| "failed".to_owned(), js::string);
            out.push(HarnessEvent::ToolError { name: Some(name), text: clip(&why, 400), id: None }.into());
            return;
        }
        let output = truthy(&d["result"]["content"]).then(|| HarnessEvent::ToolOutput { id: id.clone(), text: js::string(&d["result"]["content"]) });
        let file = rel_value(&a["path"], &self.paths);
        if !file.is_empty() && (name == "edit" || name == "create") {
            if name == "edit" && a["old_str"].as_str().is_some_and(|s| !s.is_empty()) {
                out.push(Out::Io(IoStep::Sync { file: file.clone() })); // keep the tracker current
                let after = a["new_str"].as_str().map_or_else(|| if a["new_str"].is_null() { String::new() } else { js::string(&a["new_str"]) }, str::to_owned);
                out.push(HarnessEvent::Change(Change { file, op: "edit".into(), edits: vec![Edit { before: js::str(&a["old_str"]), after }], early: None, before_file: None }).into());
                return;
            }
            match output {
                Some(o) => out.push(Out::Io(IoStep::ChangedElse { file, otherwise: Box::new(o) })),
                None => out.push(Out::Io(IoStep::Changed { file })),
            }
            return;
        }
        if let Some(o) = output {
            out.push(o.into());
        }
    }
}

impl LineParser for CopilotParser {
    fn line(&mut self, line: &str, now_ms: i64, out: &mut Vec<Out>) {
        self.started.get_or_insert(now_ms);
        let Some(msg) = json_line(line) else { return };
        let session = self.session.clone();
        self.announce(&session, out); // it's up: this session exists now
        if msg["type"] == "result" {
            self.announce(&js::str(&msg["sessionId"]), out);
            self.finish(&msg, now_ms, out);
            return;
        }
        let d = &msg["data"];
        // subagents' events carry their agent id: only the main conversation is shown
        if truthy(&msg["agentId"]) || truthy(&d["parentToolCallId"]) {
            return;
        }
        match js::str_ref(&msg["type"]) {
            "assistant.message" => {
                let c = js::str(&d["content"]);
                if js::has_text(&c) {
                    self.last_text.clone_from(&c);
                    out.push(HarnessEvent::text(c).into());
                }
            }
            "assistant.reasoning" => out.push(HarnessEvent::Thinking { text: None }.into()),
            "tool.execution_start" => {
                let name = js::str(&d["toolName"]);
                let a = if d["arguments"].is_object() { d["arguments"].clone() } else { json!({}) };
                if (name == "edit" || name == "create") && truthy(&a["path"]) {
                    out.push(Out::Io(IoStep::Remember { file: rel_value(&a["path"], &self.paths) }));
                }
                let mut t = if truthy(&d["mcpServerName"]) {
                    let tool = if truthy(&d["mcpToolName"]) { js::string(&d["mcpToolName"]) } else { name.clone() };
                    describe_mcp(&js::string(&d["mcpServerName"]), &tool, &a)
                } else {
                    describe_tool(&name, &a, &self.paths)
                };
                t.id = Some(js::str(&d["toolCallId"]));
                self.calls.insert(js::str(&d["toolCallId"]), (name, a));
                out.push(HarnessEvent::Tool(t).into());
            }
            "tool.execution_complete" => self.complete(d, out),
            "permission.requested" => {
                let ask = if d["permissionRequest"].is_object() { d["permissionRequest"].clone() } else { json!({}) };
                self.asks.insert(js::str(&d["requestId"]), ask);
            }
            "permission.completed" => {
                // refused because nobody could be asked: the card retries with it allowed
                if let Some(ask) = self.asks.remove(&js::str(&d["requestId"]))
                    && COULD_NOT.is_match(&js::str(&d["result"]["kind"]))
                {
                    out.push(blocked_of(&ask, &self.paths).into());
                }
            }
            "session.warning" => {
                let m = js::str(&d["message"]);
                if d["warningType"] == "mcp" && m.contains("'wisp'") {
                    out.push(HarnessEvent::ToolError { name: Some("wisp".into()), text: format!("{m} Copilot can't reach wisp's ask_user, so it can't ask you mid-run."), id: None }.into());
                }
            }
            // model_call errors are single requests copilot retries itself
            "session.error" if d["errorType"] != "model_call" => {
                let m = [&d["message"], &d["errorType"]].into_iter().find(|v| truthy(v)).map(js::string);
                self.error = Some(m.unwrap_or_else(|| "Copilot reported an error.".into()));
            }
            _ => {}
        }
    }

    fn close(&mut self, exit: &Exit, _now_ms: i64, out: &mut Vec<Out>) {
        if self.ended {
            return;
        }
        self.ended = true;
        let text = self.error.clone().or_else(|| Some(exit.stderr.clone()).filter(|s| !s.is_empty())).unwrap_or_else(|| exit_text("copilot", exit.code, exit.signal.as_deref()));
        out.push(HarnessEvent::Result(TurnResult { stopped: Some(exit.stopped), ..TurnResult::error(text) }).into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_become_allow_tool_rules() {
        // v1 adapters.test.js "copilot: Allow retries with exactly that rule"
        let g = vec![json!(["shell(npm publish)", "shell(git push)"]).to_string(), "url(x.dev)".into()];
        let a = args(&CopilotArgs { mode: "edits", session: "s", usage_file: "u", grants: &g, delegating: true, ..CopilotArgs::default() });
        assert!(a.ends_with(&["--allow-tool=shell(npm publish)".to_owned(), "--allow-tool=shell(git push)".to_owned(), "--allow-tool=url(x.dev)".to_owned(), "--excluded-tools=task".to_owned()]));
        assert!(COULD_NOT.compiles());
    }

    #[test]
    fn wisps_http_server_goes_in_the_mcp_config() {
        let mut m = BTreeMap::new();
        m.insert("wisp".to_owned(), json!({ "type": "http", "url": "http://x/api/mcp", "headers": { "x-wisp-token": "t" } }));
        let a = args(&CopilotArgs { mode: "auto", session: "s", usage_file: "u", mcp_servers: Some(&m), ..CopilotArgs::default() });
        let at = a.iter().position(|x| x == "--additional-mcp-config").unwrap_or(0);
        let cfg: Value = serde_json::from_str(&a[at + 1]).unwrap_or_default();
        assert_eq!(cfg["mcpServers"]["wisp"]["type"], "http");
        assert!(a.iter().any(|x| x == "--allow-tool=wisp") && a.iter().any(|x| x == "--allow-all"));
    }
}
