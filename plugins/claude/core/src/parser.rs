//! `claude -p --output-format stream-json`, line by line (v1 adapters/claude.js onJson + onClose), as
//! a sans-IO machine: stream-json in, v1's events out. The only IO it asks for is a Write's "before"
//! (`IoStep::WriteBefore`), which the driver runs in place.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use wisp_harness_kit::js::{self, num, number_or_zero, str, truthy};
use wisp_harness_kit::protocol::exit_text;
use wisp_harness_kit::{
    BillingKind, Exit, HarnessEvent, LineParser, Out, Re, RunPaths, TurnResult,
};

use crate::describe::{capture_change, describe_tool, detail_of, rule_of};
use crate::limits::claude_limits;
use crate::line::{Line, NULL, RateLimitInfo};
use crate::msg::{self, Msg};
use crate::result::{TurnState, is_final, result_event};
use crate::subagents::Tally;
use crate::usage::{
    Counted, Start, as_counted, cost_since, counted_from, model_usage_of, models_json, models_of,
};

/// What a run hands the parser besides its lines.
#[derive(Debug, Clone, Default)]
pub struct ClaudeOptions {
    pub paths: RunPaths,
    /// the last turn's stats.totals, on --resume
    pub prior: Option<Value>,
    /// a chat that ran elsewhere (bring-in)
    pub unknown_prior: bool,
}

static NONE_OR_OAUTH: Re = Re::new(r"(?i)^(?:none|oauth)$");

fn ev(e: HarnessEvent) -> Out {
    Out::Event(e)
}

/// The stream-json parser of one Claude Code process. Its flags are v1's, one per fact the stream
/// told it; a state enum would merge facts that change independently.
#[derive(Debug)]
#[allow(clippy::struct_excessive_bools)]
pub struct ClaudeParser {
    paths: RunPaths,
    prior: Option<Counted>,
    unknown_prior: bool,
    saw_result: bool,
    subagents: Tally,
    /// the last result's modelUsage (it adds up over the process)
    last_models: Value,
    /// where this process's counters started, once its first result says
    counted: Option<Start>,
    /// the next result's modelUsage can't be told from the conversation's
    unsplit: bool,
    /// this turn's last main-thread message ended with stop_reason "refusal" (per turn: a refusal
    /// the CLI retried past can still end in success)
    refused: bool,
    /// the words of an assistant message with error: 'authentication_failed'
    auth_failed: String,
    /// an empty result that came before our prompt was answered
    early: Option<TurnResult>,
    /// tool_use_id → name, to name failed results
    pending: HashMap<String, String>,
    /// background tasks still running (task_id, description), in order: while any are, the CLI
    /// stays up after its result
    background: Vec<(String, String)>,
    turn: TurnState,
}

impl ClaudeParser {
    pub fn new(o: ClaudeOptions) -> Self {
        Self {
            paths: o.paths,
            prior: o.prior.as_ref().and_then(as_counted),
            unknown_prior: o.unknown_prior,
            saw_result: false,
            subagents: Tally::default(),
            last_models: Value::Null,
            counted: None,
            unsplit: false,
            refused: false,
            auth_failed: String::new(),
            early: None,
            pending: HashMap::new(),
            background: Vec::new(),
            turn: TurnState::default(),
        }
    }

    fn set_background(&mut self, next: Vec<(String, String)>, out: &mut Vec<Out>) {
        let same = next.len() == self.background.len()
            && next.iter().zip(&self.background).all(|(a, b)| a.0 == b.0);
        self.background = next;
        if !same {
            out.push(ev(HarnessEvent::Background {
                tasks: self.background.iter().map(|(_, d)| d.clone()).collect(),
            }));
        }
    }

    /// The main thread's last request: what a reply reads back if the cache lapses. result.usage
    /// can't say: it sums every request of the turn. Each message's usage is one request.
    fn note_context(&mut self, msg: &Line, m: &Msg) {
        let Some(crate::msg::Lenient(u)) = &m.usage else {
            return;
        };
        if truthy(&msg.parent_tool_use_id) {
            return; // a subagent's context is its own
        }
        let n = |r| number_or_zero(&msg::value(r));
        let size =
            n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
        if size != 0.0 {
            self.turn.context_tokens = size; // 0: a <synthetic> message
            self.turn.compacted = false;
        }
        // The TTL the provider wrote with, read from the latest message that wrote any. Both: unknown.
        let cc = &u.cache_creation.0;
        let (h1, m5) = (
            msg::truthy(cc.ephemeral_1h_input_tokens),
            msg::truthy(cc.ephemeral_5m_input_tokens),
        );
        if h1 || m5 {
            self.turn.cache_ttl_ms = if h1 && m5 {
                0.0
            } else if h1 {
                3_600_000.0
            } else {
                300_000.0
            };
        }
    }

    fn assistant(&mut self, msg: &Line, out: &mut Vec<Out>) {
        let m = &msg.message.0;
        self.subagents.message(&msg.parent_tool_use_id, m);
        self.note_context(msg, m);
        let main = !truthy(&msg.parent_tool_use_id);
        if msg::truthy(m.stop_reason) && main {
            self.refused = msg::is(m.stop_reason, "refusal"); // a subagent's refusal isn't the turn's
        }
        if msg.error.as_str() == Some("authentication_failed") && main {
            let words = m.content.flatten();
            self.auth_failed = if words.is_empty() {
                "authentication_failed".into()
            } else {
                words
            };
        }
        for part in &m.content.parts {
            if msg::is(part.ty, "text") {
                let t = msg::text(part.text);
                if js::has_text(&t) {
                    out.push(ev(HarnessEvent::text(t.into_owned())));
                }
            } else if msg::is(part.ty, "thinking") {
                out.push(ev(HarnessEvent::Thinking {
                    text: msg::truthy(part.thinking).then(|| msg::text(part.thinking).into_owned()),
                }));
            } else if msg::is(part.ty, "tool_use") {
                self.tool_use(part, out);
            }
        }
    }

    fn tool_use(&mut self, part: &msg::Part, out: &mut Vec<Out>) {
        let (id, name) = (
            msg::text(part.id).into_owned(),
            msg::text(part.name).into_owned(),
        );
        let input = msg::value(part.input);
        let input = if input.is_object() { &input } else { &NULL };
        self.pending.insert(id.clone(), name.clone());
        self.subagents.call(&msg::value(part.id), &name, input);
        out.push(ev(HarnessEvent::Tool(
            describe_tool(&name, input, &self.paths).id(id),
        )));
        // Streamed before the call runs, and before any permission prompt for it (early).
        out.extend(capture_change(&name, input, &self.paths));
    }

    fn user(&mut self, msg: &Line, out: &mut Vec<Out>) {
        for part in &msg.message.0.content.parts {
            if !msg::is(part.ty, "tool_result") {
                continue;
            }
            let id = msg::text(part.tool_use_id).into_owned();
            self.subagents.result(&id, msg.tool_use_result.as_ref());
            let text = msg::flatten(part.content);
            out.push(ev(if msg::truthy(part.is_error) {
                HarnessEvent::ToolError {
                    name: self.pending.get(&id).cloned(),
                    text: js::head16(&text, 400).to_owned(),
                    id: Some(id),
                }
            } else {
                HarnessEvent::ToolOutput { id, text }
            }));
        }
    }

    fn init(&mut self, msg: &Line, out: &mut Vec<Out>) {
        // An API key (ANTHROPIC_API_KEY, apiKeyHelper…) bills API credit, not the plan. `none` is the
        // plan or a Console profile.
        if truthy(&msg.api_key_source) && !NONE_OR_OAUTH.is_match(&str(&msg.api_key_source)) {
            out.push(ev(HarnessEvent::Billing {
                kind: BillingKind::Api,
            }));
        }
        // The tools this run had: two accounts of the same harness can differ.
        if let Some(list) = msg.tools.as_array() {
            out.push(ev(HarnessEvent::Tools { list: list.clone() }));
        }
        if truthy(&msg.claude_code_version) {
            out.push(ev(HarnessEvent::Cli {
                version: Some(js::string(&msg.claude_code_version)),
                catalog: None,
                models: None,
            }));
        }
        self.subagents.init(&msg.tools);
    }

    fn system(&mut self, msg: &Line, out: &mut Vec<Out>) {
        let sub = msg::text(msg.subtype);
        let sub = &*sub;
        if sub == "init" {
            return self.init(msg, out);
        }
        if sub == "compact_boundary" {
            let meta = if msg.compact_metadata.is_object() {
                msg.compact_metadata.clone()
            } else {
                json!({})
            };
            self.turn.context_tokens = 0.0;
            self.turn.compacted = true;
            self.turn.boundary = Some(meta);
            self.turn.unshrunk = None;
        }
        if sub == "status" && truthy(&msg.compact_result) {
            self.turn.unshrunk = (msg.compact_result.as_str() != Some("success"))
                .then(|| js::trim(&str(js::or(&msg.compact_error, &msg.error))).to_owned());
        }
        // A subagent started (claude 2.1.316 runs Agent calls in the background): its type.
        if sub == "task_started"
            && msg.task_type.as_str() == Some("local_agent")
            && truthy(&msg.tool_use_id)
        {
            self.subagents.call(
                &msg.tool_use_id,
                "Agent",
                &json!({ "subagent_type": msg.subagent_type }),
            );
        }
        let describe = |d: &Value| {
            if truthy(d) {
                str(d)
            } else {
                "Background task".into()
            }
        };
        // background_tasks_changed carries the full list; task_started/task_notification are the
        // per-task edges, kept for CLI versions that only send those (edge case 4).
        if sub == "background_tasks_changed" && msg.tasks.is_array() {
            let next = js::arr(&msg.tasks)
                .iter()
                .map(|t| (str(&t["task_id"]), describe(&t["description"])))
                .collect();
            self.set_background(next, out);
        } else if sub == "task_started" && truthy(&msg.is_backgrounded) && truthy(&msg.task_id) {
            let (id, d) = (str(&msg.task_id), describe(&msg.description));
            let mut next = self.background.clone();
            match next.iter_mut().find(|(k, _)| *k == id) {
                Some(slot) => slot.1 = d,
                None => next.push((id, d)),
            }
            self.set_background(next, out);
        } else if sub == "task_notification"
            && self.background.iter().any(|(k, _)| *k == str(&msg.task_id))
        {
            let id = str(&msg.task_id);
            let next = self
                .background
                .iter()
                .filter(|(k, _)| *k != id)
                .cloned()
                .collect();
            self.set_background(next, out);
        }
    }

    fn result(&mut self, msg: &Line, out: &mut Vec<Out>) {
        let mut e = result_event(msg, &self.auth_failed);
        if self.counted.is_none() {
            let start = counted_from(msg, self.prior.as_ref(), self.unknown_prior);
            self.last_models = start
                .counted()
                .and_then(|c| c.models.as_deref())
                .map_or(Value::Null, model_usage_of);
            // Restored, from a turn that left no models: this modelUsage is the whole conversation,
            // with nothing to take off. It's still the baseline for the next result and run.
            self.unsplit = start
                .counted()
                .is_some_and(|c| c.models.as_ref().is_none_or(Vec::is_empty));
            self.counted = Some(start);
        }
        let stats = e.stats.get_or_insert_with(Box::default);
        if let Some(start) = &self.counted
            && let Some(c) = start.counted()
        {
            stats.cost_usd = Some(js::json_num(cost_since(msg, c)));
            let spent = stats
                .cost_usd
                .as_ref()
                .and_then(num)
                .is_some_and(|x| x != 0.0);
            if matches!(start, Start::Baseline(_)) && !spent {
                stats.extra.insert("baseline".into(), Value::Bool(true)); // no measure of this run
            }
        }
        // What the next --resume starts from. Its presence says stats.models is this turn's alone.
        let mut totals = Map::new();
        if let Some(t) = &msg.total_cost_usd {
            totals.insert("costUsd".into(), t.clone());
        }
        if let Some(m) = models_of(msg.model_usage.as_ref(), &NULL) {
            totals.insert("models".into(), models_json(&m));
        }
        stats.extra.insert("totals".into(), Value::Object(totals));
        if is_final(&mut e, msg, &mut self.turn) {
            self.finish(msg, e, out);
        } else {
            self.early = Some(e);
        }
    }

    fn finish(&mut self, msg: &Line, mut e: TurnResult, out: &mut Vec<Out>) {
        self.saw_result = true;
        // modelUsage adds up over the process: this result's part is what's new since the last.
        let models = if self.unsplit {
            None
        } else {
            models_of(msg.model_usage.as_ref(), &self.last_models)
        };
        self.unsplit = false;
        if let Some(mu) = &msg.model_usage {
            self.last_models = Value::Object(mu.0.iter().cloned().collect());
        }
        let stats = e.stats.get_or_insert_with(Box::default);
        if let Some(m) = &models {
            stats.extra.insert("models".into(), models_json(m));
        }
        if let Some(rows) = self
            .subagents
            .take(models.as_deref(), &msg.usage["output_tokens"])
        {
            stats.extra.insert("subagents".into(), rows);
        }
        // Refused tool calls (no approve tool here, or the user said no): the card offers a retry.
        for d in js::arr(&msg.permission_denials) {
            let input = if d["tool_input"].is_object() {
                &d["tool_input"]
            } else {
                &NULL
            };
            let tool = str(&d["tool_name"]);
            out.push(ev(HarnessEvent::Blocked {
                detail: detail_of(&tool, input, &self.paths),
                rule: Some(rule_of(&tool, input)),
                tool,
            }));
        }
        // The result's own stop_reason, when it has one, says.
        if self.refused && !truthy(&msg.stop_reason) {
            e.stop_reason = Some("refusal".into());
        }
        self.refused = false;
        e.background = Some(self.background.len() as u64); // > 0: another turn and result follow
        out.push(ev(HarnessEvent::Result(e)));
    }
}

impl LineParser for ClaudeParser {
    fn line(&mut self, line: &str, _now_ms: i64, out: &mut Vec<Out>) {
        let Some(msg) = Line::parse(line) else { return };
        if truthy(&msg.session_id) {
            out.push(ev(HarnessEvent::session(str(&msg.session_id))));
        }
        match &*msg::text(msg.ty) {
            "assistant" => self.assistant(&msg, out),
            "user" => self.user(&msg, out),
            // How much of the account's 5-hour and weekly windows is gone.
            "rate_limit_event" => out.extend(
                msg.rate_limit_info
                    .as_deref()
                    .and_then(RateLimitInfo::parse)
                    .and_then(|i| claude_limits(&i))
                    .map(|l| ev(HarnessEvent::Limits(l))),
            ),
            "system" => self.system(&msg, out),
            "result" => self.result(&msg, out),
            _ => {}
        }
    }

    fn close(&mut self, exit: &Exit, _now_ms: i64, out: &mut Vec<Out>) {
        if self.saw_result {
            return;
        }
        // Stopped after the early result: the user stopped a turn that never answered.
        if let Some(early) = self.early.take().filter(|_| !exit.stop_requested) {
            out.push(ev(HarnessEvent::Result(early)));
            return;
        }
        let text = if exit.stderr.is_empty() {
            exit_text("claude", exit.code, exit.signal.as_deref())
        } else {
            exit.stderr.clone()
        };
        out.push(ev(HarnessEvent::Result(TurnResult {
            stopped: Some(exit.stopped),
            ..TurnResult::error(text)
        })));
    }
}
