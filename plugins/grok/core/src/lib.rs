//! wisp.grok core (sans-IO): `grok --output-format streaming-messages-json`'s parser (v1
//! adapters/grok.js; Claude Code's stream-json shape with grok's tool names), its tool sentences, the
//! argv and the agent definition that brings wisp's MCP server in. A headless run refuses what needs
//! approval and names it on stderr: those become `blocked`.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::paths::resolve;
use wisp_harness_kit::protocol::{ASK_TIMEOUT_MS, crew_tool_label, exit_text, wisp_tool_label};
use wisp_harness_kit::{
    Change, Edit, Exit, HarnessEvent, IoStep, LineParser, Out, Re, RunPaths, Stats, Tool, ToolKind, TurnResult, clip, clip_value, flatten,
    json_line, rel_value,
};

static REFUSED: Re = Re::new(r"permission required: (\S+) ?(.*?) was not run\b");
static WORKFLOW: Re = Re::new(r" \(workflow .*\)$");
static MODEL_LINE: Re = Re::new(r"(?m)^\s+[*-]\s+([\w.\-/:]+)");
static DEFAULT_LINE: Re = Re::new(r"(?m)^\s+\*\s+([\w.\-/:]+)");
const EFFORT_ORDER: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Default)]
pub struct GrokArgs<'a> {
    pub prompt_file: &'a str,
    pub mode: &'a str,
    pub rules: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub resume_id: Option<&'a str>,
    /// the agent definition's path, when the run has MCP servers
    pub agent_file: Option<&'a str>,
}

pub fn args(a: &GrokArgs<'_>) -> Vec<String> {
    let pm = match a.mode {
        "plan" => "plan",
        "auto" => "bypassPermissions",
        _ => "acceptEdits",
    };
    let mut out: Vec<String> = [
        "--prompt-file",
        a.prompt_file,
        "--output-format",
        "streaming-messages-json",
        "--permission-mode",
        pm,
        "--rules",
        a.rules,
        "--disallowed-tools",
        "ask_user_question",
        "--no-auto-update",
    ]
    .map(str::to_owned)
    .to_vec();
    if !a.model.is_empty() {
        out.extend(["--model".into(), a.model.into()]);
    }
    if !a.effort.is_empty() {
        out.extend(["--reasoning-effort".into(), a.effort.into()]);
    }
    if let Some(r) = a.resume_id.filter(|r| !r.is_empty()) {
        out.extend(["--resume".into(), r.into()]);
    }
    if let Some(f) = a.agent_file {
        out.extend(["--agent".into(), f.into()]);
    }
    out
}

/// An agent definition that keeps grok's stock prompt (`prompt_mode: full`) and adds the servers.
pub fn agent_definition(mcp_servers: &BTreeMap<String, Value>) -> String {
    let servers: Vec<Value> = mcp_servers
        .iter()
        .map(|(name, srv)| {
            let mut s = if let Some(url) = srv["url"].as_str() {
                json!({ "name": name, "url": url, "headers": srv.get("headers").cloned().unwrap_or_else(|| json!({})) })
            } else {
                json!({ "name": name, "command": srv["command"], "args": srv.get("args").filter(|a| !a.is_null()).cloned().unwrap_or_else(|| json!([])), "env": srv.get("env").filter(|e| !e.is_null()).cloned().unwrap_or_else(|| json!({})) })
            };
            if let Some(o) = s.as_object_mut() {
                o.insert("tool_timeout_sec".into(), json!(ASK_TIMEOUT_MS / 1000));
                o.insert("startup_timeout_sec".into(), json!(60));
            }
            s
        })
        .collect();
    // YAML is a superset of JSON: the values need no escaping of their own
    format!(
        "---\nname: wisp\ndescription: A task launched by wisp\nprompt_mode: full\nagents_md: true\nmcpServers: {}\n---\n",
        Value::Array(servers)
    )
}

/// `grok models`: "  * grok-4.7 (default)" / "  - grok-4.6" lines; the `*` one is the default.
pub fn model_ids(out: &str) -> (Vec<String>, Option<String>) {
    let ids = MODEL_LINE
        .get()
        .map(|re| re.captures_iter(out).filter_map(|c| c.get(1).map(|m| m.as_str().to_owned())).collect())
        .unwrap_or_default();
    (ids, DEFAULT_LINE.group(out, 1).map(str::to_owned))
}

/// A cached model's reasoning levels, in grok's order.
pub fn efforts_of(list: &Value) -> Option<Vec<String>> {
    let l = list.as_array()?;
    let rank = |id: &str| EFFORT_ORDER.iter().position(|e| *e == id).unwrap_or(EFFORT_ORDER.len());
    let mut ids: Vec<String> = l.iter().filter_map(|e| e["id"].as_str().filter(|s| !s.is_empty()).map(str::to_owned)).collect();
    ids.sort_by_key(|id| rank(id));
    Some(ids)
}

fn describe_mcp(tool: &str, input: &Value) -> Tool {
    let bare = tool.strip_prefix("wisp__");
    match bare {
        Some("ask_user") => Tool::new(ToolKind::Wait, "Waiting for your answer"),
        Some("delegate") => {
            let mut who: Vec<String> = Vec::new();
            for x in js::arr(&input["tasks"]) {
                let n = if x["subagent"].is_null() { String::new() } else { js::string(&x["subagent"]) };
                if !who.contains(&n) {
                    who.push(n);
                }
            }
            let who = who.join(", ");
            Tool::new(ToolKind::Agent, format!("Delegating to {}", clip(if who.is_empty() { "subagents" } else { &who }, 60)))
        }
        Some("subagent_results") => Tool::new(ToolKind::Agent, "Waiting on subagents"),
        _ => bare.and_then(|b| wisp_tool_label(b, input)).or_else(|| crew_tool_label(bare.unwrap_or(tool), input)).unwrap_or_else(|| {
            Tool::new(
                ToolKind::Tool,
                if tool.is_empty() {
                    "Using an integration".into()
                } else {
                    format!("Using {}", tool.split("__").collect::<Vec<_>>().join(" · "))
                },
            )
        }),
    }
}

fn t(kind: ToolKind, label: impl Into<String>) -> Tool {
    Tool::new(kind, label)
}

pub fn describe_tool(name: &str, i: &Value, paths: &RunPaths) -> Tool {
    let f = rel_value(js::or(js::or(js::or(&i["target_file"], &i["file_path"]), &i["path"]), &i["target_directory"]), paths);
    match name {
        "read_file" => t(ToolKind::Read, format!("Reading {f}")).file(f),
        "search_replace" => t(ToolKind::Edit, format!("Editing {f}")).file(f),
        "write" => t(ToolKind::Edit, format!("Writing {f}")).file(f),
        "run_terminal_command" | "run_terminal_cmd" => {
            let said = if truthy(&i["description"]) { Some(js::string(&i["description"])) } else { None };
            let (label, title) = wisp_harness_kit::run_label(&js::str(&i["command"]), paths, said.as_deref());
            let mut x = t(ToolKind::Run, label);
            x.title = title; // the whole one, when the label was cut (v1 #780)
            if !i["command"].is_null() {
                x.detail = Some(js::string(&i["command"]));
            }
            x
        }
        "grep" => t(ToolKind::Search, format!("Searching for “{}”", clip_value(&i["pattern"], 40))),
        "list_dir" => {
            // grok passes absolute paths, also for the project root itself
            let root = truthy(&i["target_directory"])
                && resolve(&paths.cwd, &js::string(&i["target_directory"])).trim_end_matches('/') == paths.cwd.trim_end_matches('/');
            t(ToolKind::Search, format!("Listing {}", if root || f.is_empty() { "." } else { &f }))
        }
        "web_search" => t(ToolKind::Web, format!("Searching the web: {}", clip_value(&i["query"], 50))),
        "web_fetch" => t(ToolKind::Web, format!("Reading {}", clip_value(&i["url"], 60))),
        "spawn_subagent" | "task" => t(ToolKind::Agent, format!("Delegating: {}", clip_value(js::or(&i["description"], &i["prompt"]), 60))),
        "todo_write" => {
            let active = js::arr(&i["todos"]).iter().find(|x| x["status"] == "in_progress" && truthy(&x["content"]));
            t(ToolKind::Plan, active.map_or_else(|| "Planning".to_owned(), |x| clip_value(&x["content"], 80)))
        }
        "enter_plan_mode" | "exit_plan_mode" => t(ToolKind::Plan, "Planning"),
        "search_tool" => t(ToolKind::Search, format!("Looking up tools: {}", clip_value(&i["query"], 50))),
        "use_tool" => describe_mcp(&js::str(&i["tool_name"]), if i["tool_input"].is_object() { &i["tool_input"] } else { &Value::Null }),
        _ => t(ToolKind::Tool, format!("Using {}", name.replace('_', " "))),
    }
}

#[derive(Debug, Default)]
pub struct GrokParser {
    paths: RunPaths,
    pending: HashMap<String, (String, Value)>,
    session: Option<String>,
    saw_result: bool,
    error: Option<String>,
    carry: String,
}

impl GrokParser {
    pub fn new(paths: RunPaths) -> Self {
        Self { paths, ..Self::default() }
    }

    fn tool_result(&mut self, part: &Value, out: &mut Vec<Out>) {
        let id = js::str(&part["tool_use_id"]);
        let Some((name, input)) = self.pending.remove(&id) else { return };
        if truthy(&part["is_error"]) {
            out.push(HarnessEvent::ToolError { name: Some(name), text: clip(&flatten(&part["content"]), 400), id: None }.into());
            return;
        }
        let output = HarnessEvent::ToolOutput { id, text: flatten(&part["content"]) };
        let file = rel_value(&input["file_path"], &self.paths);
        if file.is_empty() || !(name == "search_replace" || name == "write") {
            out.push(output.into());
            return;
        }
        if name == "search_replace" && input["old_string"].as_str().is_some_and(|s| !s.is_empty()) {
            out.push(Out::Io(IoStep::Sync { file: file.clone() })); // keep the tracker current
            let after = input["new_string"].as_str().map_or_else(
                || if input["new_string"].is_null() { String::new() } else { js::string(&input["new_string"]) },
                str::to_owned,
            );
            out.push(
                HarnessEvent::Change(Change {
                    file,
                    op: "edit".into(),
                    edits: vec![Edit { before: js::str(&input["old_string"]), after }],
                    early: None,
                    before_file: None,
                })
                .into(),
            );
            return;
        }
        // a batch may be streamed after it ran: the tracker has the side before the write
        out.push(Out::Io(IoStep::ChangedElse { file, otherwise: Box::new(output) }));
    }
}

impl LineParser for GrokParser {
    fn line(&mut self, line: &str, _now_ms: i64, out: &mut Vec<Out>) {
        let Some(msg) = json_line(line) else { return };
        if let Some(sid) = msg["session_id"].as_str().filter(|s| !s.is_empty())
            && self.session.as_deref() != Some(sid)
        {
            self.session = Some(sid.to_owned());
            out.push(HarnessEvent::session(sid).into());
        }
        // subagent traffic carries its parent's tool id: only the main conversation is shown
        if truthy(&msg["parent_tool_use_id"]) {
            return;
        }
        match js::str_ref(&msg["type"]) {
            "assistant" => {
                for part in js::arr(&msg["message"]["content"]) {
                    match js::str_ref(&part["type"]) {
                        "text" if js::has_text(js::str_ref(&part["text"])) => out.push(HarnessEvent::text(js::str(&part["text"])).into()),
                        "thinking" => out.push(HarnessEvent::Thinking { text: None }.into()),
                        "server_tool_use" => out.push(
                            HarnessEvent::Tool(Tool::new(
                                ToolKind::Web,
                                format!("Searching the web: {}", clip_value(&part["input"]["query"], 50)),
                            ))
                            .into(),
                        ),
                        "tool_use" => {
                            let input = if part["input"].is_object() { part["input"].clone() } else { json!({}) };
                            let name = js::str(&part["name"]);
                            let id = js::str(&part["id"]);
                            if name == "write" && truthy(&input["file_path"]) {
                                out.push(Out::Io(IoStep::Remember { file: rel_value(&input["file_path"], &self.paths) }));
                            }
                            // streamed once answered: "waiting" would land after "You answered"
                            let ask = name == "use_tool" && input["tool_name"] == "wisp__ask_user";
                            if !ask {
                                let mut tool = describe_tool(&name, &input, &self.paths);
                                tool.id = Some(id.clone());
                                out.push(HarnessEvent::Tool(tool).into());
                            }
                            self.pending.insert(id, (name, input));
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                for part in js::arr(&msg["message"]["content"]) {
                    if part["type"] == "tool_result" {
                        self.tool_result(part, out);
                    }
                }
            }
            "result" => {
                self.saw_result = true;
                let failed = truthy(&msg["is_error"]);
                let text = if failed {
                    let errs = js::arr(&msg["errors"]).iter().map(js::string).collect::<Vec<_>>().join("\n");
                    if !errs.is_empty() {
                        errs
                    } else if truthy(&msg["result"]) {
                        js::string(&msg["result"])
                    } else {
                        format!("grok stopped: {}", js::string(&msg["subtype"]))
                    }
                } else {
                    js::str(&msg["result"])
                };
                let sub = js::str(&msg["subtype"]);
                let mut stats = Map::new();
                if truthy(&msg["total_cost_usd"]) {
                    stats.insert("costUsd".into(), msg["total_cost_usd"].clone()); // 0 means "not reported"
                }
                for (k, v) in [
                    ("durationMs", &msg["duration_ms"]),
                    ("turns", &msg["num_turns"]),
                    ("inputTokens", &msg["usage"]["input_tokens"]),
                    ("outputTokens", &msg["usage"]["output_tokens"]),
                ] {
                    if !v.is_null() {
                        stats.insert(k.into(), v.clone());
                    }
                }
                let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
                out.push(
                    HarnessEvent::Result(TurnResult {
                        text,
                        is_error: failed || (!sub.is_empty() && sub != "success"),
                        stats,
                        ..TurnResult::default()
                    })
                    .into(),
                );
            }
            "error" => {
                self.error = Some(if truthy(&msg["message"]) { js::string(&msg["message"]) } else { "grok reported an error.".into() });
            }
            _ => {}
        }
    }

    fn stderr(&mut self, text: &str, _now_ms: i64, out: &mut Vec<Out>) {
        let all = format!("{}{text}", self.carry);
        let mut lines: Vec<&str> = all.split('\n').collect();
        lines.pop().unwrap_or("").clone_into(&mut self.carry);
        let joined = lines.join("\n");
        if let Some(re) = REFUSED.get() {
            for c in re.captures_iter(&joined) {
                let detail = c.get(2).map_or("", |m| m.as_str());
                out.push(
                    HarnessEvent::Blocked {
                        tool: c.get(1).map_or("", |m| m.as_str()).to_owned(),
                        detail: WORKFLOW.replace(detail, "").into_owned(),
                        rule: None,
                    }
                    .into(),
                );
            }
        }
    }

    fn close(&mut self, exit: &Exit, _now_ms: i64, out: &mut Vec<Out>) {
        if self.saw_result {
            return;
        }
        let text = self
            .error
            .clone()
            .or_else(|| Some(exit.stderr.clone()).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| exit_text("grok", exit.code, exit.signal.as_deref()));
        out.push(HarnessEvent::Result(TurnResult { stopped: Some(exit.stopped), ..TurnResult::error(text) }).into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile_and_models_list() {
        for p in [&REFUSED, &WORKFLOW, &MODEL_LINE, &DEFAULT_LINE] {
            assert!(p.compiles(), "{}", p.pattern());
        }
        let (ids, def) = model_ids("Models:\n  * grok-4.7 (default)\n  - grok-4.6\n");
        assert_eq!((ids, def.as_deref()), (vec!["grok-4.7".to_owned(), "grok-4.6".to_owned()], Some("grok-4.7")));
        // v1 adapters.test.js: grok-9's levels from its catalog, in order
        assert_eq!(
            efforts_of(&json!([{ "id": "xhigh" }, { "id": "high" }, { "id": "low" }])),
            Some(vec!["low".to_owned(), "high".to_owned(), "xhigh".to_owned()])
        );
    }

    #[test]
    fn a_refusal_split_over_two_writes_is_one_card() {
        let mut p = GrokParser::new(RunPaths::same("/w"));
        let mut out = Vec::new();
        p.stderr("permission required: Edit calc.py was not ", 0, &mut out);
        assert_eq!(out, Vec::<Out>::new());
        p.stderr("run, as a headless run cannot ask for approval (workflow x)\n", 1, &mut out);
        let Some(Out::Event(HarnessEvent::Blocked { tool, detail, .. })) = out.first() else { panic!("{out:?}") };
        assert_eq!((tool.as_str(), detail.as_str()), ("Edit", "calc.py"));
    }

    #[test]
    fn the_agent_definition_brings_wisp_in() {
        let mut m = BTreeMap::new();
        m.insert("wisp".to_owned(), json!({ "command": "node", "args": ["mcp.mjs"] }));
        let d = agent_definition(&m);
        assert!(d.starts_with("---\nname: wisp\n") && d.contains("\"tool_timeout_sec\":604800") && d.contains("prompt_mode: full"));
    }
}
