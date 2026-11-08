//! wisp.antigravity core (sans-IO): `agy --input-format stream-json --output-format stream-json`'s
//! parser (v1 adapters/antigravity.js: one init, step_update events, one result per turn), its tool
//! sentences, the argv and the stdin `user` event. agy takes no MCP server or system prompt by flag:
//! no ask tool, and the protocol goes ahead of the first message.

// Docs quote agy's own JSON keys and PascalCase parameters as prose.
#![allow(clippy::doc_markdown)]

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use wisp_harness_kit::commands::describe_command_value;
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::exit_text;
use wisp_harness_kit::{Exit, HarnessEvent, IoStep, LineParser, Out, Re, RunPaths, Stats, Tool, ToolKind, TurnResult, clip, clip_value, json_line, rel_value};

/// Headless runs give up after --print-timeout (5m by default); wisp tasks routinely take longer.
pub const PRINT_TIMEOUT: &str = "24h";
static EDIT_TOOL: Re = Re::new(r"(?i)write|replace|edit|delete");
static PERMISSION: Re = Re::new(r"(?i)PERMISSION");
static EFFORT_SUFFIX: Re = Re::new(r"-(low|medium|high)$");
static MODEL_LINE: Re = Re::new(r"^([\w.\-]+)(?:\t|\s{2,})\s*(.+)$");

pub fn args(mode: &str, model: &str, effort: &str, resume_id: Option<&str>, attachment_dirs: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", PRINT_TIMEOUT].map(str::to_owned).to_vec();
    match mode {
        "plan" => a.extend(["--mode".into(), "plan".into()]),
        "auto" => a.push("--dangerously-skip-permissions".into()),
        _ => a.extend(["--mode".into(), "accept-edits".into()]),
    }
    if !model.is_empty() {
        a.extend(["--model".into(), model.into()]);
    }
    if !effort.is_empty() {
        a.extend(["--effort".into(), effort.into()]);
    }
    if let Some(r) = resume_id.filter(|r| !r.is_empty()) {
        a.extend(["--conversation".into(), r.into()]);
    }
    let mut seen = Vec::new();
    for d in attachment_dirs {
        if !seen.contains(d) {
            seen.push(d.clone());
            a.extend(["--add-dir".into(), d.clone()]);
        }
    }
    a
}

/// The prompt as agy's one stdin `user` event.
pub fn stdin_event(content: &str) -> String {
    format!("{}\n", json!({ "event": "user", "message": { "content": content } }))
}

/// `agy models`: "slug<TAB>Label" (or space-padded) lines; slugs with the effort baked in get no selector.
pub fn list_models(out: &str) -> Vec<(String, String, bool)> {
    out.lines()
        .filter_map(|l| {
            let c = MODEL_LINE.captures(js::trim(l))?;
            let id = c.get(1)?.as_str().to_owned();
            let baked = EFFORT_SUFFIX.is_match(&id);
            Some((id, js::trim(c.get(2).map_or("", |m| m.as_str())).to_owned(), baked))
        })
        .collect()
}

/// Tool parameters are PascalCase (TargetFile, AbsolutePath, CommandLine, …).
fn file_of(p: &Value) -> Option<&Value> {
    ["TargetFile", "AbsolutePath", "FilePath", "File", "Path", "path", "file_path"].into_iter().map(|k| &p[k]).find(|v| !v.is_null() && v.as_str() != Some(""))
}

#[allow(clippy::many_single_char_names)] // v1 describeTool's own names
pub fn describe_tool(name: &str, p: &Value, paths: &RunPaths) -> Tool {
    let f = file_of(p).map_or_else(String::new, |v| rel_value(v, paths));
    let n = name.to_lowercase();
    let t = |k: ToolKind, l: String| Tool::new(k, l);
    if n == "run_command" {
        let mut x = t(ToolKind::Run, describe_command_value(&p["CommandLine"], paths));
        if !p["CommandLine"].is_null() {
            x.detail = Some(js::string(&p["CommandLine"]));
        }
        return x;
    }
    if EDIT_TOOL.is_match(&n) && !f.is_empty() {
        return t(ToolKind::Edit, format!("{} {f}", if n.contains("delete") { "Deleting" } else { "Editing" })).file(f);
    }
    if n.starts_with("view_") && !f.is_empty() {
        return t(ToolKind::Read, format!("Reading {f}")).file(f);
    }
    let or = |a: &str, b: &str| js::or(&p[a], &p[b]).clone();
    if n == "list_dir" {
        let d = rel_value(&p["DirectoryPath"], paths);
        return t(ToolKind::Search, format!("Listing {}", if d.is_empty() { "." } else { &d }));
    }
    if n == "find_by_name" {
        return t(ToolKind::Search, format!("Finding {}", clip_value(&p["Pattern"], 50)));
    }
    if n.contains("grep") {
        return t(ToolKind::Search, format!("Searching for “{}”", clip_value(&or("Query", "Pattern"), 40)));
    }
    if n.contains("codesearch") || n.contains("code_search") || n.contains("codebase") {
        return t(ToolKind::Search, format!("Searching the codebase: {}", clip_value(&or("Query", "query"), 50)));
    }
    if n.contains("search_web") || n.contains("web_search") {
        return t(ToolKind::Web, format!("Searching the web: {}", clip_value(&or("query", "Query"), 50)));
    }
    if n.contains("url") || n.contains("fetch") {
        return t(ToolKind::Web, format!("Reading {}", clip_value(&or("Url", "url"), 60)));
    }
    if n.contains("browser") {
        let task = or("Task", "TaskName");
        return t(ToolKind::Web, format!("Browsing: {}", if truthy(&task) { clip_value(&task, 60) } else { "browser".into() }));
    }
    if n.contains("task_boundary") || n.contains("todo") {
        let s = or("TaskStatus", "TaskName");
        return t(ToolKind::Plan, if truthy(&s) { clip_value(&s, 80) } else { "Planning".into() });
    }
    t(ToolKind::Tool, format!("Using {}", n.replace('_', " ")))
}

#[derive(Debug, Default)]
pub struct AgyParser {
    paths: RunPaths,
    text: HashMap<String, String>,
    shown: HashSet<String>,
    saw_result: bool,
    session: Option<String>,
}

impl AgyParser {
    pub fn new(paths: RunPaths) -> Self {
        Self { paths, ..Self::default() }
    }

    fn session_from(&mut self, id: &Value, out: &mut Vec<Out>) {
        if let Some(id) = id.as_str().filter(|s| !s.is_empty())
            && self.session.as_deref() != Some(id)
        {
            self.session = Some(id.to_owned());
            out.push(HarnessEvent::session(id).into());
        }
    }

    fn step(&mut self, s: &Value, out: &mut Vec<Out>) {
        self.session_from(&s["conversation_id"], out);
        let done = s["state"] == "DONE";
        let idx = js::string(&s["step_index"]);
        if s["step_type"] == "agent_response" {
            let t = self.text.entry(idx).or_default();
            t.push_str(&js::str(&s["text_delta"]));
            if done && js::has_text(t) {
                out.push(HarnessEvent::text(t.clone()).into());
            }
            return;
        }
        if truthy(&s["subagent_info"]) && !self.shown.contains(&idx) {
            self.shown.insert(idx);
            let sub = &s["subagent_info"]["subagents"][0];
            let who = if sub.is_object() { format!(" to {}", js::string(js::or(&sub["role"], &sub["type_name"]))) } else { String::new() };
            out.push(HarnessEvent::Tool(Tool::new(ToolKind::Agent, format!("Delegating{who}"))).into());
            return;
        }
        if s["step_type"] != "tool" {
            return;
        }
        let info = &s["tool_info"];
        let name = js::str(js::or(&s["tool_name"], &info["name"]));
        if name.is_empty() {
            return;
        }
        let empty = Value::Object(Map::new());
        let params = if info["parameters"].is_object() { &info["parameters"] } else { &empty };
        let file = file_of(params).map(|v| rel_value(v, &self.paths)).filter(|f| !f.is_empty());
        let editing = file.is_some() && EDIT_TOOL.is_match(&name);
        // announce once the arguments are known: on ACTIVE if it carries them, else on DONE
        let has_args = params.as_object().is_some_and(|o| !o.is_empty());
        if !self.shown.contains(&idx) && (done || has_args) {
            self.shown.insert(idx.clone());
            if editing && !done && let Some(f) = &file {
                out.push(Out::Io(IoStep::Remember { file: f.clone() }));
            }
            out.push(HarnessEvent::Tool(describe_tool(&name, params, &self.paths)).into());
        }
        if !done {
            return;
        }
        if truthy(&info["error"]) {
            let e = &info["error"];
            let why = [&e["message"], &e["type"]].into_iter().find(|v| truthy(v)).map_or_else(|| "failed".to_owned(), js::string);
            out.push(HarnessEvent::ToolError { name: Some(name.clone()), text: clip(&why, 400), id: None }.into());
            if PERMISSION.is_match(&js::str(&e["type"])) {
                let d = [&params["CommandLine"]].into_iter().find(|v| !v.is_null()).cloned().or_else(|| file_of(params).cloned()).or_else(|| Some(params["Url"].clone()).filter(|v| !v.is_null()));
                out.push(HarnessEvent::Blocked { tool: name, detail: d.map_or_else(String::new, |v| js::string(&v)), rule: None }.into());
            }
        } else if editing && let Some(f) = file {
            out.push(Out::Io(IoStep::Changed { file: f }));
        }
    }
}

impl LineParser for AgyParser {
    fn line(&mut self, line: &str, _now_ms: i64, out: &mut Vec<Out>) {
        let Some(msg) = json_line(line) else { return };
        match js::str_ref(&msg["event"]) {
            "init" => self.session_from(&msg["conversation_id"], out),
            "step_update" => {
                let s = if msg["step_update"].is_object() { msg["step_update"].clone() } else { json!({}) };
                self.step(&s, out);
            }
            "result" => {
                let r = &msg["result"];
                self.session_from(&r["conversation_id"], out);
                self.saw_result = true;
                let ok = r["status"] == "SUCCESS";
                let text = if ok {
                    js::str(&r["response"])
                } else {
                    [&r["error"], &r["response"]].into_iter().find(|v| truthy(v)).map_or_else(|| format!("Antigravity ended with status {}", js::string(&r["status"])), js::string)
                };
                let mut stats = Map::new();
                if let Some(s) = r["duration_seconds"].as_f64() {
                    stats.insert("durationMs".into(), js::json_num((s * 1000.0).round()));
                }
                for (k, v) in [("inputTokens", &r["usage"]["input_tokens"]), ("outputTokens", &r["usage"]["output_tokens"])] {
                    if !v.is_null() {
                        stats.insert(k.into(), v.clone());
                    }
                }
                let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
                out.push(HarnessEvent::Result(TurnResult { text, is_error: !ok, stats, ..TurnResult::default() }).into());
            }
            _ => {}
        }
    }

    fn close(&mut self, exit: &Exit, _now_ms: i64, out: &mut Vec<Out>) {
        if self.saw_result {
            return;
        }
        let text = if exit.stderr.is_empty() { exit_text("agy", exit.code, exit.signal.as_deref()) } else { exit.stderr.clone() };
        out.push(HarnessEvent::Result(TurnResult { stopped: Some(exit.stopped), ..TurnResult::error(text) }).into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_words_and_models() {
        for p in [&EDIT_TOOL, &PERMISSION, &EFFORT_SUFFIX, &MODEL_LINE] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        let p = RunPaths::same("/w");
        assert_eq!(describe_tool("grep_search", &json!({ "Query": "add" }), &p).label, "Searching for “add”");
        assert_eq!(describe_tool("write_to_file", &json!({ "TargetFile": "/w/a.js" }), &p).label, "Editing a.js");
        assert_eq!(describe_tool("read_url_content", &json!({ "Url": "https://x.dev" }), &p).label, "Reading https://x.dev");
        // v1 adapters.test.js "antigravity: detect lists agy models"
        let m = list_models("Fetching models…\ngemini-3-pro-high\tGemini 3 Pro (High)\nclaude-sonnet-4-5   Claude Sonnet 4.5\n");
        assert_eq!(m, [("gemini-3-pro-high".to_owned(), "Gemini 3 Pro (High)".to_owned(), true), ("claude-sonnet-4-5".to_owned(), "Claude Sonnet 4.5".to_owned(), false)]);
        assert_eq!(stdin_event("hi"), "{\"event\":\"user\",\"message\":{\"content\":\"hi\"}}\n");
    }

    #[test]
    fn text_is_the_steps_deltas() {
        let mut p = AgyParser::new(RunPaths::same("/w"));
        let mut out = Vec::new();
        p.line(r#"{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"Fixed "}}"#, 0, &mut out);
        assert_eq!(out, Vec::<Out>::new());
        p.line(r#"{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"it."}}"#, 1, &mut out);
        assert!(matches!(out.last(), Some(Out::Event(HarnessEvent::Text { text })) if text == "Fixed it."));
    }
}
