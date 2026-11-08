//! `codex exec --json`'s JSONL (thread/turn/item events) as wisp events (v1 codex.js `onJson`,
//! `onItem`, `onClose`). The usage windows codex keeps in its session file are not read here: the
//! accounts plugin's live limits read them (v1 read them at the result, which is IO).

use serde_json::{Map, Value};
use wisp_harness_kit::protocol::{crew_tool_label, exit_text};
use wisp_harness_kit::{Exit, HarnessEvent, IoStep, LineParser, Out, RunPaths, Stats, Tool, ToolKind, TurnResult, clip, clip_value, describe_command, flatten, js, json_line, rel};

use crate::shell::unwrap_shell;
use crate::usage::turn_usage;

#[derive(Debug, Clone, Default)]
pub struct CodexOptions {
    pub paths: RunPaths,
    pub resume_id: Option<String>,
    pub fork: bool,
    /// the thread's counters after its last turn (`stats.totals`)
    pub prior: Option<Value>,
}

#[derive(Debug)]
pub struct CodexParser {
    o: CodexOptions,
    thread: String,
    last_message: String,
    failure: Option<String>,
    last_error: String,
    usage: Option<Value>,
    completed: bool,
    reported: bool,
    started: Option<i64>,
}

impl CodexParser {
    pub fn new(o: CodexOptions) -> Self {
        let thread = if o.fork { String::new() } else { o.resume_id.clone().unwrap_or_default() };
        Self { o, thread, last_message: String::new(), failure: None, last_error: String::new(), usage: None, completed: false, reported: false, started: None }
    }

    fn report(&mut self, ok: bool, stopped: bool, text: String, now: i64, out: &mut Vec<Out>) {
        self.reported = true;
        let mut stats = Map::new();
        #[allow(clippy::cast_precision_loss)] // a turn is far shorter than 2^53 ms
        stats.insert("durationMs".into(), js::json_num((now - self.started.unwrap_or(now)) as f64));
        stats.extend(turn_usage(self.usage.as_ref(), self.o.prior.as_ref(), &self.thread));
        let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
        let text = if ok { self.last_message.clone() } else { text };
        out.push(HarnessEvent::Result(TurnResult { text, is_error: !ok, stopped: Some(stopped), stats, ..TurnResult::default() }).into());
    }

    fn item(&mut self, item: &Value, phase: &str, out: &mut Vec<Out>) {
        let ty = js::str_ref(js::or(&item["type"], &item["item_type"]));
        let id = || js::str(&item["id"]);
        let mut ev = |e: HarnessEvent| out.push(e.into());
        match (phase, ty) {
            ("started", "command_execution") => {
                let label = describe_command(&unwrap_shell(&item["command"]), &self.o.paths);
                let mut t = Tool::new(ToolKind::Run, label).id(id());
                t.detail = Some(js::str(&item["command"]));
                ev(HarnessEvent::Tool(t));
            }
            ("started", "mcp_tool_call") => {
                let mut t = describe_mcp(item);
                t.id = Some(id());
                ev(HarnessEvent::Tool(t));
            }
            ("started", "web_search") => {
                let q = js::str(&item["query"]);
                ev(HarnessEvent::Tool(Tool::new(ToolKind::Web, if q.is_empty() { "Searching the web".into() } else { format!("Searching the web: {}", clip(&q, 50)) })));
            }
            ("updated" | "completed", "todo_list") => {
                if let Some(next) = js::arr(&item["items"]).iter().find(|t| !js::truthy(&t["completed"])) {
                    ev(HarnessEvent::Tool(Tool::new(ToolKind::Plan, clip_value(&next["text"], 80))));
                }
            }
            ("completed", "agent_message" | "assistant_message") => {
                let text = js::str(&item["text"]);
                if js::has_text(&text) {
                    self.last_message.clone_from(&text);
                    ev(HarnessEvent::text(text));
                }
            }
            ("completed", "reasoning") => ev(HarnessEvent::Thinking { text: None }),
            ("completed", "command_execution") => {
                let code = &item["exit_code"];
                let failed = item["status"] == "failed" || (!code.is_null() && code.as_f64() != Some(0.0));
                let output = js::str(&item["aggregated_output"]);
                if failed {
                    let text = if output.is_empty() { format!("exit {}", js::string(code)) } else { output };
                    ev(HarnessEvent::ToolError { name: Some(clip(&unwrap_shell(&item["command"]), 40)), text: clip(&text, 400), id: None });
                } else if !output.is_empty() {
                    ev(HarnessEvent::ToolOutput { id: id(), text: output });
                }
            }
            ("completed", "file_change") => {
                for c in js::arr(&item["changes"]) {
                    let f = rel(&js::str(&c["path"]), &self.o.paths);
                    let verb = match js::str_ref(&c["kind"]) {
                        "add" => "Writing",
                        "delete" => "Deleting",
                        _ => "Editing",
                    };
                    out.push(HarnessEvent::Tool(Tool::new(ToolKind::Edit, format!("{verb} {f}")).file(f.clone())).into());
                    out.push(Out::Io(IoStep::Changed { file: f }));
                }
                if item["status"] == "failed" {
                    out.push(HarnessEvent::ToolError { name: Some("apply_patch".into()), text: "The patch did not apply.".into(), id: None }.into());
                }
            }
            ("completed", "mcp_tool_call") => {
                if item["status"] == "failed" {
                    let msg = js::str(&item["error"]["message"]);
                    let name = format!("{}.{}", js::str(&item["server"]), js::str(&item["tool"]));
                    ev(HarnessEvent::ToolError { name: Some(name), text: clip(if msg.is_empty() { "failed" } else { &msg }, 400), id: None });
                } else if js::truthy(&item["result"]["content"]) {
                    ev(HarnessEvent::ToolOutput { id: id(), text: flatten(&item["result"]["content"]) });
                }
            }
            _ => {}
        }
    }
}

impl LineParser for CodexParser {
    fn line(&mut self, line: &str, now_ms: i64, out: &mut Vec<Out>) {
        self.started.get_or_insert(now_ms);
        let Some(msg) = json_line(line) else { return };
        match js::str_ref(&msg["type"]) {
            "thread.started" => {
                let id = js::str(&msg["thread_id"]);
                if !id.is_empty() {
                    self.thread.clone_from(&id);
                    out.push(HarnessEvent::session(id).into());
                }
            }
            t @ ("item.started" | "item.updated" | "item.completed") => {
                if msg["item"].is_object() {
                    self.item(&msg["item"], &t[5..], out);
                }
            }
            "turn.completed" => {
                self.completed = true;
                self.usage = Some(msg["usage"].clone()).filter(|u| !u.is_null());
                // the answer is in: show it now (codex takes ~0.4 s more to stop its MCP servers)
                if self.failure.is_none() {
                    self.report(true, false, String::new(), now_ms, out);
                }
            }
            "turn.failed" => {
                let m = js::str(&msg["error"]["message"]);
                self.failure = Some(if m.is_empty() { "The turn failed.".into() } else { m });
            }
            "error" => {
                // "Reconnecting... n/5" is transient; keep the last one in case the turn dies
                let m = js::str(&msg["message"]);
                if !m.is_empty() {
                    self.last_error = m;
                }
            }
            _ => {}
        }
    }

    fn close(&mut self, exit: &Exit, now_ms: i64, out: &mut Vec<Out>) {
        if self.reported {
            return;
        }
        let ok = self.completed && self.failure.is_none() && exit.code == Some(0);
        let text = self
            .failure
            .clone()
            .or_else(|| Some(self.last_error.clone()).filter(|e| !e.is_empty()))
            .or_else(|| Some(exit.stderr.clone()).filter(|e| !e.is_empty()))
            .unwrap_or_else(|| exit_text("codex", exit.code, exit.signal.as_deref()));
        self.report(ok, exit.stopped, text, now_ms, out);
    }
}

/// v1 codex.js `describeMcp`: wisp's own tools in words, any other as `Using server · tool`.
pub fn describe_mcp(item: &Value) -> Tool {
    let (server, tool) = (js::str(&item["server"]), js::str(&item["tool"]));
    if server == "wisp" {
        let known = match tool.as_str() {
            "ask_user" => Some((ToolKind::Wait, "Waiting for your answer")),
            "delegate" | "subagent_results" => Some((ToolKind::Agent, "Waiting on subagents")),
            "wisp_tag" => Some((ToolKind::Tool, "Tagging the task")),
            "wisp_pr" => Some((ToolKind::Tool, "Attaching a PR")),
            "wisp_save" => Some((ToolKind::Tool, "Saving to My Stuff")),
            "wisp_stuff" => Some((ToolKind::Tool, "Looking in My Stuff")),
            "wisp_blocks" => Some((ToolKind::Tool, "Reading block formats")),
            "wisp_stats" => Some((ToolKind::Tool, "Reading wisp stats")),
            "wisp_sessions" => Some((ToolKind::Tool, "Listing wisp tasks")),
            "wisp_session" => Some((ToolKind::Tool, "Reading a wisp task")),
            _ => None,
        };
        if let Some((k, l)) = known {
            return Tool::new(k, l);
        }
        if let Some(t) = crew_tool_label(&tool, &item["arguments"]) {
            return t;
        }
    }
    Tool::new(ToolKind::Tool, format!("Using {server} · {tool}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mcp_calls_in_words() {
        assert_eq!(describe_mcp(&json!({ "server": "wisp", "tool": "ask_user" })).label, "Waiting for your answer");
        assert_eq!(describe_mcp(&json!({ "server": "gh", "tool": "search" })).label, "Using gh · search");
    }

    #[test]
    fn a_failed_turn_says_why() {
        let mut p = CodexParser::new(CodexOptions::default());
        let mut out = Vec::new();
        p.line(r#"{"type":"error","message":"Reconnecting... 1/5"}"#, 0, &mut out);
        p.line(r#"{"type":"turn.failed","error":{"message":"quota"}}"#, 1, &mut out);
        p.close(&Exit { code: Some(1), ..Exit::default() }, 2, &mut out);
        let Some(Out::Event(HarnessEvent::Result(r))) = out.last() else { panic!("result") };
        assert!(r.is_error);
        assert_eq!(r.text, "quota");
    }
}
