//! `opencode run --format json`'s events as wisp events (v1 opencode.js `onJson`, `onStderr`,
//! `onClose`). opencode reports a tool once it ran, output and all. `run` answers every permission
//! prompt itself and says so on stderr ("permission requested: bash (npm publish); auto-rejecting"):
//! those become `blocked`. Rate-limited, it retries and prints nothing: once its error log has said so
//! for the grace, the parser asks for a stop (checked on each input: the parser has no timer).

use serde_json::{Map, Value, json};
use wisp_harness_kit::js::{self, truthy};
use wisp_harness_kit::protocol::exit_text;
use wisp_harness_kit::{
    Change, Edit, Exit, HarnessEvent, IoStep, LineParser, Out, Re, RunPaths, Stats, TurnResult, clip_value, json_line, rel_value,
};

use crate::describe::describe_tool;

pub const RATE_LIMIT_GRACE_MS: i64 = 60_000;

static RATE_LIMITED: Re = Re::new(r"(?i)Rate limit exceeded|Too Many Requests|status(?:Code)?[=: ]+429\b");
static REJECTED: Re = Re::new(r"permission requested: ([\w.-]+) \((.*?)\); auto-rejecting");
static ANSI: Re = Re::new(r"\x1b\[[0-9;]*m");
static LOGGED: Re = Re::new(r#"error\.error="((?:[^"\\]|\\.)*)""#);
static PATCH_PATH: Re = Re::new(r"(?m)^\*\*\* (?:Add|Update|Delete) File: (.+)$");

#[derive(Debug, Clone)]
pub struct OpencodeOptions {
    pub paths: RunPaths,
    /// the model, for the rate-limit message
    pub model: String,
    pub rate_limit_grace_ms: i64,
}

impl Default for OpencodeOptions {
    fn default() -> Self {
        Self { paths: RunPaths::default(), model: String::new(), rate_limit_grace_ms: RATE_LIMIT_GRACE_MS }
    }
}

#[derive(Debug)]
pub struct OpencodeParser {
    o: OpencodeOptions,
    session: Option<String>,
    /// the messageID of the latest assistant text (`Some(Null)`: one without an id)
    last_msg: Option<Value>,
    text: Vec<String>,
    error: Option<String>,
    tokens: (f64, f64),
    cost: f64,
    limit_at: Option<i64>,
    limited: bool,
    carry: String,
    started: Option<i64>,
}

impl OpencodeParser {
    pub fn new(o: OpencodeOptions) -> Self {
        Self {
            o,
            session: None,
            last_msg: None,
            text: Vec::new(),
            error: None,
            tokens: (0.0, 0.0),
            cost: 0.0,
            limit_at: None,
            limited: false,
            carry: String::new(),
            started: None,
        }
    }

    fn tick(&mut self, now: i64, out: &mut Vec<Out>) {
        self.started.get_or_insert(now);
        if let Some(at) = self.limit_at
            && !self.limited
            && now - at >= self.o.rate_limit_grace_ms
        {
            self.limited = true;
            out.push(Out::Stop);
        }
    }

    fn duration(&self, now: i64) -> Value {
        #[allow(clippy::cast_precision_loss)] // a turn is far shorter than 2^53 ms
        js::json_num((now - self.started.unwrap_or(now)) as f64)
    }

    fn tool_use(&self, part: &Value, out: &mut Vec<Out>) {
        let state = &part["state"];
        let input = if truthy(&state["input"]) { &state["input"] } else { &Value::Null };
        let empty = json!({});
        let input = if input.is_null() { &empty } else { input };
        let tool = js::str(&part["tool"]);
        let id = js::str(&part["callID"]);
        let mut t = describe_tool(&tool, input, &self.o.paths);
        t.id = Some(id.clone());
        let failed = state["status"] == "error";
        if !failed && let Some(o) = state["output"].as_str() {
            t.output = Some(o.to_owned());
        }
        out.push(HarnessEvent::Tool(t).into());
        if failed {
            let why = js::or(&state["error"], &state["output"]);
            out.push(HarnessEvent::ToolError { id: Some(id), name: Some(tool), text: clip_value(why, 400) }.into());
            return;
        }
        let meta = if truthy(&state["metadata"]) { &state["metadata"] } else { &empty };
        self.changes(&tool, input, meta, out);
        out.push(HarnessEvent::ToolOutput { id, text: String::new() }.into()); // the call is over
    }

    /// v1 `captureChanges`: edits carry old/new strings; anything else is diffed by the tracker.
    fn changes(&self, tool: &str, input: &Value, meta: &Value, out: &mut Vec<Out>) {
        let file_v = js::or(&input["filePath"], &input["path"]);
        let file = rel_value(file_v, &self.o.paths);
        let before = if input["oldString"].is_null() { &input["old_string"] } else { &input["oldString"] };
        if tool == "edit" && !file.is_empty() && before.is_string() {
            out.push(Out::Io(IoStep::Sync { file: file.clone() })); // keep the tracker current for later writes
            let after_v = if input["newString"].is_null() { &input["new_string"] } else { &input["newString"] };
            let after = after_v.as_str().map_or_else(|| if after_v.is_null() { String::new() } else { js::string(after_v) }, str::to_owned);
            out.push(
                HarnessEvent::Change(Change {
                    file,
                    op: "edit".into(),
                    edits: vec![Edit { before: js::str(before), after }],
                    early: None,
                    before_file: None,
                })
                .into(),
            );
            return;
        }
        let mut paths: Vec<String> = Vec::new();
        if matches!(tool, "write" | "edit" | "multiedit") && !file.is_empty() {
            paths.push(file);
        } else if matches!(tool, "patch" | "apply_patch") {
            let listed = js::arr(&meta["files"]).iter().filter_map(|x| {
                if let Some(s) = x.as_str() { Some(s.to_owned()) } else { js::or(&x["filePath"], &x["file"]).as_str().map(str::to_owned) }
            });
            let text = js::str(js::or(&input["patchText"], &input["patch"]));
            let named = PATCH_PATH
                .get()
                .map(|re| re.captures_iter(&text).filter_map(|c| c.get(1).map(|m| js::trim(m.as_str()).to_owned())).collect::<Vec<_>>())
                .unwrap_or_default();
            for p in listed.chain(named) {
                if !paths.contains(&p) {
                    paths.push(p);
                }
            }
            paths = paths.iter().map(|p| rel_value(&Value::String(p.clone()), &self.o.paths)).collect();
        }
        for file in paths {
            out.push(Out::Io(IoStep::Changed { file }));
        }
    }
}

impl LineParser for OpencodeParser {
    fn line(&mut self, line: &str, now_ms: i64, out: &mut Vec<Out>) {
        self.tick(now_ms, out);
        let Some(msg) = json_line(line) else { return };
        // anything coming through means a retry got an answer
        if msg["type"] != "error" {
            self.limit_at = None;
        }
        if let Some(sid) = msg["sessionID"].as_str().filter(|s| !s.is_empty())
            && self.session.as_deref() != Some(sid)
        {
            self.session = Some(sid.to_owned());
            out.push(HarnessEvent::session(sid).into());
        }
        let part = &msg["part"];
        match js::str_ref(&msg["type"]) {
            "text" => {
                let text = js::str(&part["text"]);
                if !js::has_text(&text) {
                    return;
                }
                if self.last_msg.as_ref() != Some(&part["messageID"]) {
                    self.last_msg = Some(part["messageID"].clone());
                    self.text.clear();
                }
                self.text.push(text.clone());
                out.push(HarnessEvent::text(text).into());
            }
            "reasoning" => out.push(HarnessEvent::Thinking { text: None }.into()),
            "tool_use" => self.tool_use(part, out),
            "step_finish" => {
                self.tokens.0 += js::number_or_zero(&part["tokens"]["input"]);
                self.tokens.1 += js::number_or_zero(&part["tokens"]["output"]);
                self.cost += js::number_or_zero(&part["cost"]);
            }
            "error" => {
                let e = &msg["error"];
                let m = [&e["data"]["message"], &e["message"], &e["name"]].into_iter().find(|v| truthy(v)).map(js::string);
                self.error = Some(m.unwrap_or_else(|| "opencode reported an error.".into()));
            }
            _ => {}
        }
    }

    fn stderr(&mut self, text: &str, now_ms: i64, out: &mut Vec<Out>) {
        self.tick(now_ms, out);
        // whole lines only: a chunk can end mid-line
        let all = format!("{}{text}", self.carry);
        let mut lines: Vec<&str> = all.split('\n').collect();
        lines.pop().unwrap_or("").clone_into(&mut self.carry);
        let joined = ANSI.replace_all(&lines.join("\n"), "").into_owned();
        if let Some(re) = REJECTED.get() {
            for c in re.captures_iter(&joined) {
                let permission = c.get(1).map_or("", |m| m.as_str()).to_owned();
                let patterns: Vec<String> =
                    c.get(2).map_or("", |m| m.as_str()).split(", ").filter(|p| !p.is_empty()).map(str::to_owned).collect();
                out.push(
                    HarnessEvent::Blocked {
                        tool: permission.clone(),
                        detail: patterns.join(", "),
                        rule: Some(json!({ "permission": permission, "patterns": patterns })),
                    }
                    .into(),
                );
            }
        }
        if self.limit_at.is_none() && !self.limited && RATE_LIMITED.is_match(text) {
            self.limit_at = Some(now_ms);
        }
    }

    fn close(&mut self, exit: &Exit, now_ms: i64, out: &mut Vec<Out>) {
        if self.limited {
            let which = if self.o.model.is_empty() { "opencode’s default model".to_owned() } else { format!("`{}`", self.o.model) };
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
            let secs = (self.o.rate_limit_grace_ms as f64 / 1000.0).round() as i64;
            let text = format!(
                "{which} is rate-limited right now: opencode kept retrying for {secs}s without an answer. Try again in a few minutes, pick another model, or connect your own provider with `opencode auth login`."
            );
            let mut stats = Map::new();
            stats.insert("durationMs".into(), self.duration(now_ms));
            out.push(
                HarnessEvent::Result(TurnResult {
                    stats: serde_json::from_value(Value::Object(stats)).ok().map(Box::new),
                    ..TurnResult::error(text)
                })
                .into(),
            );
            return;
        }
        let ok = exit.code == Some(0) && self.error.is_none();
        let text = if ok {
            self.text.join("\n")
        } else {
            let logged = LOGGED
                .get()
                .and_then(|re| re.captures_iter(&exit.stderr).last())
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_owned())
                .filter(|s| !s.is_empty());
            self.error
                .clone()
                .or(logged)
                .or_else(|| Some(exit.stderr.clone()).filter(|s| !s.is_empty()))
                .unwrap_or_else(|| exit_text("opencode", exit.code, exit.signal.as_deref()))
        };
        let mut stats = Map::new();
        stats.insert("durationMs".into(), self.duration(now_ms));
        if self.cost != 0.0 {
            stats.insert("costUsd".into(), js::json_num(self.cost));
        }
        stats.insert("inputTokens".into(), js::json_num(self.tokens.0));
        stats.insert("outputTokens".into(), js::json_num(self.tokens.1));
        let stats: Option<Box<Stats>> = serde_json::from_value(Value::Object(stats)).ok().map(Box::new);
        out.push(
            HarnessEvent::Result(TurnResult { text, is_error: !ok, stopped: Some(exit.stopped), stats, ..TurnResult::default() }).into(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for p in [&RATE_LIMITED, &REJECTED, &ANSI, &LOGGED, &PATCH_PATH] {
            assert!(p.compiles(), "{}", p.pattern());
        }
    }

    fn result(out: &[Out]) -> Option<&TurnResult> {
        out.iter().rev().find_map(|o| if let Out::Event(HarnessEvent::Result(r)) = o { Some(r) } else { None })
    }

    #[test]
    fn a_rate_limited_run_is_stopped_after_the_grace_and_says_what_to_do() {
        // v1 adapters.test.js "opencode: a rate-limited run is stopped and explained"
        let mut p = OpencodeParser::new(OpencodeOptions {
            model: "opencode/big-pickle".into(),
            rate_limit_grace_ms: 300,
            ..OpencodeOptions::default()
        });
        let mut out = Vec::new();
        p.stderr("level=ERROR error.error=\"AI_APICallError: Rate limit exceeded.\"\n", 0, &mut out);
        p.stderr("retrying\n", 100, &mut out);
        assert!(!out.iter().any(|o| matches!(o, Out::Stop)));
        p.stderr("retrying\n", 400, &mut out);
        assert!(out.iter().any(|o| matches!(o, Out::Stop)));
        p.close(&Exit { signal: Some("SIGTERM".into()), stopped: true, ..Exit::default() }, 410, &mut out);
        let r = result(&out).map(|r| r.text.clone()).unwrap_or_default();
        assert!(r.starts_with("`opencode/big-pickle` is rate-limited right now") && r.contains("0s"), "{r}");
    }

    #[test]
    fn a_retry_that_gets_through_clears_the_limit() {
        let mut p = OpencodeParser::new(OpencodeOptions { rate_limit_grace_ms: 300, ..OpencodeOptions::default() });
        let mut out = Vec::new();
        p.stderr("Too Many Requests\n", 0, &mut out);
        p.line(r#"{"sessionID":"s","type":"step_start","part":{}}"#, 100, &mut out);
        p.stderr("x\n", 1000, &mut out);
        assert!(!out.iter().any(|o| matches!(o, Out::Stop)));
    }

    #[test]
    fn refusals_on_stderr_are_blocked_with_their_rule() {
        let mut p = OpencodeParser::new(OpencodeOptions::default());
        let mut out = Vec::new();
        p.stderr("\x1b[93m! \x1b[0mpermission requested: bash (npm pub", 0, &mut out);
        assert_eq!(out, Vec::<Out>::new(), "half a line waits");
        p.stderr("lish, npm test); auto-rejecting\n", 1, &mut out);
        let Some(Out::Event(HarnessEvent::Blocked { tool, detail, rule })) = out.first() else { panic!("{out:?}") };
        assert_eq!((tool.as_str(), detail.as_str()), ("bash", "npm publish, npm test"));
        assert_eq!(rule.as_ref().map(|r| r["patterns"][1].clone()), Some(json!("npm test")));
    }
}
