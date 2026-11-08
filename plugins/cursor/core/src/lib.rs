//! wisp.cursor core (sans-IO): `cursor-agent -p --output-format stream-json`'s parser (v1
//! adapters/cursor.js), its tool sentences and argv. cursor-agent takes no MCP server by flag, so a
//! run has no ask tool: the protocol asks for a question block instead.

use serde_json::{Map, Value};
use wisp_harness_kit::commands::describe_command_value;
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::exit_text;
use wisp_harness_kit::{Change, Edit, Exit, HarnessEvent, IoStep, LineParser, Out, Re, RunPaths, Stats, Tool, ToolKind, TurnResult, clip, clip_value, json_line, rel_value};

static REFUSED: Re = Re::new(r"(?i)reject|denied|permission");
static IN_PROGRESS: Re = Re::new(r"(?i)in_?progress");
static LIST_MODEL: Re = Re::new(r"^([\w.\-\[\]=,]+) - (.+?)(?:\s+\((?:current|default)[^)]*\))?$");

/// `-p --output-format stream-json --trust …`; the prompt goes on stdin.
pub fn args(mode: &str, model: &str, resume_id: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--trust"].map(str::to_owned).to_vec();
    if mode == "plan" {
        a.extend(["--mode".into(), "plan".into()]);
    }
    if mode == "auto" {
        a.push("--force".into());
    }
    if !model.is_empty() {
        a.extend(["--model".into(), model.into()]);
    }
    if let Some(r) = resume_id.filter(|r| !r.is_empty()) {
        a.extend(["--resume".into(), r.into()]);
    }
    a
}

/// `--list-models`: "id - Label" lines, "(current, default)" on the active one; `auto` is Default.
pub fn list_models(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let c = LIST_MODEL.captures(js::trim(l))?;
            let id = c.get(1)?.as_str();
            (id != "auto").then(|| (id.to_owned(), c.get(2).map_or("", |m| m.as_str()).to_owned()))
        })
        .collect()
}

/// A protobuf oneof: `{ editToolCall: {...} }` or `{ case: 'editToolCall', value: {...} }`.
fn oneof(o: &Value) -> Option<(String, Value)> {
    let obj = o.as_object()?;
    if obj.contains_key("case") {
        return Some((js::string(&o["case"]), o["value"].clone()));
    }
    obj.iter().next().map(|(k, v)| (k.clone(), v.clone()))
}

fn tool_of(tc: &Value) -> Option<(String, Value)> {
    oneof(if tc["tool"].is_object() { &tc["tool"] } else { tc })
}

fn result_of(r: &Value) -> Option<(String, Value)> {
    oneof(if r["result"].is_object() && r["result"].get("case").is_some() { &r["result"] } else { r })
}

#[allow(clippy::many_single_char_names)] // v1 describeTool's own names
pub fn describe_tool(name: &str, a: &Value, paths: &RunPaths) -> Tool {
    let f = rel_value(&a["path"], paths);
    let t = Tool::new;
    match name {
        "readToolCall" => t(ToolKind::Read, format!("Reading {f}")).file(f),
        "editToolCall" => t(ToolKind::Edit, format!("Editing {f}")).file(f),
        "deleteToolCall" => t(ToolKind::Edit, format!("Deleting {f}")).file(f),
        "shellToolCall" => {
            let label = if truthy(&a["description"]) { clip_value(&a["description"], 80) } else { describe_command_value(&a["command"], paths) };
            let mut x = t(ToolKind::Run, label);
            if !a["command"].is_null() {
                x.detail = Some(js::string(&a["command"]));
            }
            x
        }
        "grepToolCall" => t(ToolKind::Search, format!("Searching for “{}”", clip_value(&a["pattern"], 40))),
        "globToolCall" => t(ToolKind::Search, format!("Finding {}", clip_value(js::or(&a["globPattern"], &a["pattern"]), 50))),
        "lsToolCall" => t(ToolKind::Search, format!("Listing {}", if f.is_empty() { "." } else { &f })),
        "semSearchToolCall" => t(ToolKind::Search, format!("Searching the codebase: {}", clip_value(&a["query"], 50))),
        "webSearchToolCall" => t(ToolKind::Web, format!("Searching the web: {}", clip_value(js::or(&a["searchTerm"], &a["query"]), 50))),
        "webFetchToolCall" | "fetchToolCall" => t(ToolKind::Web, format!("Reading {}", clip_value(&a["url"], 60))),
        "taskToolCall" => t(ToolKind::Agent, format!("Delegating: {}", clip_value(js::or(&a["description"], &a["prompt"]), 60))),
        "updateTodosToolCall" => {
            let active = js::arr(&a["todos"]).iter().find(|x| IN_PROGRESS.is_match(&js::string(&x["status"])));
            t(ToolKind::Plan, active.map_or_else(|| "Planning".to_owned(), |x| clip_value(&x["content"], 80)))
        }
        "mcpToolCall" => {
            let p = if truthy(&a["providerIdentifier"]) { js::string(&a["providerIdentifier"]) } else { "mcp".into() };
            let n = if truthy(&a["toolName"]) { js::string(&a["toolName"]) } else { "tool".into() };
            t(ToolKind::Tool, format!("Using {p} · {n}"))
        }
        _ => {
            let base = name.strip_suffix("ToolCall").unwrap_or(name);
            let mut words = String::new();
            for ch in base.chars() {
                if ch.is_ascii_uppercase() {
                    words.push(' ');
                }
                words.push(ch.to_ascii_lowercase());
            }
            t(ToolKind::Tool, format!("Using {words}"))
        }
    }
}

#[derive(Debug, Default)]
pub struct CursorParser {
    paths: RunPaths,
    session: Option<String>,
    saw_result: bool,
}

impl CursorParser {
    pub fn new(paths: RunPaths) -> Self {
        Self { paths, ..Self::default() }
    }

    fn completed(&self, msg: &Value, name: &str, args: &Value, body: &Value, out: &mut Vec<Out>) {
        let (outcome, value) = result_of(&body["result"]).unwrap_or_default();
        let short = name.strip_suffix("ToolCall").unwrap_or(name).to_owned();
        if !outcome.is_empty() && outcome != "success" {
            let why = [&value["error"], &value["message"], &value["reason"], &value["stderr"]].into_iter().find(|v| truthy(v)).map_or_else(|| outcome.clone(), js::string);
            out.push(HarnessEvent::ToolError { name: Some(short.clone()), text: clip(&why, 400), id: None }.into());
            if REFUSED.is_match(&outcome) {
                let d = [&args["command"], &args["path"], &args["url"]].into_iter().find(|v| !v.is_null()).map_or_else(String::new, js::string);
                out.push(HarnessEvent::Blocked { tool: short, detail: d, rule: None }.into());
            }
        } else if name == "editToolCall" || name == "deleteToolCall" {
            let file_v = if truthy(&args["path"]) { &args["path"] } else { &value["path"] };
            let file = rel_value(file_v, &self.paths);
            if file.is_empty() {
                return;
            }
            if let Some(after) = value["afterFullFileContent"].as_str() {
                out.push(Out::Io(IoStep::Sync { file: file.clone() })); // keep the snapshot current
                let before = &value["beforeFullFileContent"];
                let op = if before.is_null() { "create" } else { "write" };
                out.push(HarnessEvent::Change(Change { file, op: op.into(), edits: vec![Edit { before: js::str(before), after: after.to_owned() }], early: None, before_file: None }).into());
            } else {
                out.push(Out::Io(IoStep::Changed { file }));
            }
        } else {
            let parts: Vec<&str> = [&value["stdout"], &value["stderr"]].into_iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).collect();
            let text = if parts.is_empty() { value["content"].as_str().unwrap_or("").to_owned() } else { parts.join("\n") };
            if !text.is_empty() {
                out.push(HarnessEvent::ToolOutput { id: js::str(&msg["call_id"]), text }.into());
            }
        }
    }
}

impl LineParser for CursorParser {
    fn line(&mut self, line: &str, _now_ms: i64, out: &mut Vec<Out>) {
        let Some(msg) = json_line(line) else { return };
        if let Some(sid) = msg["session_id"].as_str().filter(|s| !s.is_empty())
            && self.session.as_deref() != Some(sid)
        {
            self.session = Some(sid.to_owned());
            out.push(HarnessEvent::session(sid).into());
        }
        match js::str_ref(&msg["type"]) {
            "assistant" => {
                for part in js::arr(&msg["message"]["content"]) {
                    if part["type"] == "text" && js::has_text(js::str_ref(&part["text"])) {
                        out.push(HarnessEvent::text(js::str(&part["text"])).into());
                    }
                }
            }
            "thinking" if msg["subtype"] == "completed" => out.push(HarnessEvent::Thinking { text: None }.into()),
            "tool_call" => {
                let Some((name, body)) = tool_of(&msg["tool_call"]) else { return };
                if name.is_empty() {
                    return;
                }
                let args = if body["args"].is_object() { body["args"].clone() } else { Value::Object(Map::new()) };
                match js::str_ref(&msg["subtype"]) {
                    "started" => {
                        if (name == "editToolCall" || name == "deleteToolCall") && truthy(&args["path"]) {
                            out.push(Out::Io(IoStep::Remember { file: rel_value(&args["path"], &self.paths) }));
                        }
                        let mut t = describe_tool(&name, &args, &self.paths);
                        t.id = msg["call_id"].as_str().map(str::to_owned);
                        out.push(HarnessEvent::Tool(t).into());
                    }
                    "completed" => self.completed(&msg, &name, &args, &body, out),
                    _ => {}
                }
            }
            "result" => {
                self.saw_result = true;
                let usage = &msg["usage"];
                let mut stats = Map::new();
                for (k, v) in [("durationMs", &msg["duration_ms"]), ("inputTokens", js::or(&usage["inputTokens"], &usage["input_tokens"])), ("outputTokens", js::or(&usage["outputTokens"], &usage["output_tokens"]))] {
                    if !v.is_null() {
                        stats.insert(k.into(), v.clone());
                    }
                }
                let sub = js::str(&msg["subtype"]);
                let is_error = truthy(&msg["is_error"]) || (!sub.is_empty() && sub != "success");
                let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
                out.push(HarnessEvent::Result(TurnResult { text: js::str(&msg["result"]), is_error, stats, ..TurnResult::default() }).into());
            }
            _ => {}
        }
    }

    fn close(&mut self, exit: &Exit, _now_ms: i64, out: &mut Vec<Out>) {
        if self.saw_result {
            return;
        }
        let text = if exit.stderr.is_empty() { exit_text("cursor-agent", exit.code, exit.signal.as_deref()) } else { exit.stderr.clone() };
        out.push(HarnessEvent::Result(TurnResult { stopped: Some(exit.stopped), ..TurnResult::error(text) }).into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn patterns_and_words() {
        for p in [&REFUSED, &IN_PROGRESS, &LIST_MODEL] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        let p = RunPaths::same("/w");
        assert_eq!(describe_tool("semSearchToolCall", &json!({ "query": "auth" }), &p).label, "Searching the codebase: auth");
        assert_eq!(describe_tool("readLintsToolCall", &json!({}), &p).label, "Using read lints");
        assert_eq!(describe_tool("mcpToolCall", &json!({ "providerIdentifier": "gh", "toolName": "pr" }), &p).label, "Using gh · pr");
    }

    #[test]
    fn list_models_skips_auto() {
        // v1 adapters.test.js "cursor: detect lists --list-models"
        let m = list_models("auto - Auto\ngpt-5 - GPT-5  (current, default)\nsonnet-4.5-thinking - Sonnet 4.5 Thinking\n");
        assert_eq!(m, [("gpt-5".to_owned(), "GPT-5".to_owned()), ("sonnet-4.5-thinking".to_owned(), "Sonnet 4.5 Thinking".to_owned())]);
    }

    #[test]
    fn oneofs_both_ways() {
        assert_eq!(tool_of(&json!({ "tool": { "case": "readToolCall", "value": { "args": {} } } })).map(|x| x.0).as_deref(), Some("readToolCall"));
        assert_eq!(result_of(&json!({ "result": { "case": "success", "value": {} } })).map(|x| x.0).as_deref(), Some("success"));
    }
}
