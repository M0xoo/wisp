//! A harness's events as a turn's transcript and head (v1 runner.js `#onEvent`, `stepOf`, `stepOutput`,
//! `clipOutput`). Each event becomes at most one appended step plus an update of the turn's head (resume
//! id, changes, blocked actions, background tasks), applied in the same transaction (plan §4.1: the log is
//! append-only, the head is its projection). O(1) per event except a change to a file the turn already
//! touched (linear in the turn's changed files, as v1).

use serde_json::Value;
use wisp_runtime_api::harness::{HarnessEvent, HarnessStats};
use wisp_runtime_api::model::{Activity, ChangeOp, Edit, FileChange, Mode, ToolKind};

/// An agent message is kept whole up to this (UTF-16 units, as v1 counted).
pub const MAX_TEXT: usize = 20_000;
/// A tool call's output: its start and end past this.
pub const MAX_OUTPUT: usize = 2_000;

/// The calls whose output the transcript shows: a read returns the file and an edit a confirmation.
pub fn shows_output(kind: ToolKind) -> bool {
    matches!(kind, ToolKind::Run | ToolKind::Search | ToolKind::Web | ToolKind::Tool | ToolKind::Agent)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 units (never splitting a character).
fn head16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// The last `n` UTF-16 units.
fn tail16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > n {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

/// v1 `clipOutput`: whole when short, else its first and last lines (the end of a test run or a build
/// is what tells how it went).
pub fn clip_output(text: &str) -> String {
    let out = text.trim_end();
    if utf16_len(out) <= MAX_OUTPUT {
        return out.to_owned();
    }
    let mut head = head16(out, 600);
    let mut tail = tail16(out, 1300);
    if let Some(i) = head.rfind('\n') {
        head = &head[..i];
    }
    if let Some(i) = tail.find('\n') {
        tail = &tail[i + 1..];
    }
    let cut = &out[head.len()..out.len() - tail.len()];
    let lines = cut.matches('\n').count();
    let what = if lines > 1 { format!("{lines} lines") } else { format!("{} characters", utf16_len(cut)) };
    format!("{head}\n… {what} cut …\n{tail}")
}

/// A blocked action the turn's permissions refused (the card after the turn offers to retry it).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BlockedAction {
    pub tool: String,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

/// What of a turn's refusals wisp can still allow (v1 #777): a run in Full auto was already allowed everything wisp
/// can allow, so what its harness still refused was its own safety check (Claude Code's on a heredoc it can't parse),
/// which no rule lifts. Nothing to retry then; the card still says what was refused.
#[must_use]
pub fn allowable(mode: Mode, blocked: &[BlockedAction]) -> &[BlockedAction] {
    if mode == Mode::Auto { &[] } else { blocked }
}

/// What a running turn knows besides its log: the projection its events update.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Head {
    /// the harness conversation to resume
    pub resume_id: Option<String>,
    /// the last agent message
    pub text: Option<String>,
    pub changes: Vec<FileChange>,
    pub blocked: Vec<BlockedAction>,
    /// background tasks the CLI says are still running
    pub background: Vec<String>,
    /// a result that left background tasks running: the best we have if nothing follows
    pub interim: Option<(String, Option<HarnessStats>)>,
    pub tools: Option<Vec<Value>>,
    pub cli: Option<Value>,
    /// the calls that read a .env file: their `tool_output` is flagged `env` (ADR-0050)
    pub env_calls: Vec<String>,
    /// the values of the .env files this turn's calls printed, so its thinking and tool errors that quote one are
    /// flagged where (`hide`). In memory only: never written, never logged.
    pub env_values: EnvValues,
}

/// .env values a turn saw. Its `Debug` says how many, never what.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct EnvValues(pub Vec<String>);

impl std::fmt::Debug for EnvValues {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EnvValues({} hidden)", self.0.len())
    }
}

impl EnvValues {
    fn add(&mut self, text: &str) {
        for v in wisp_envmask::env_values(text) {
            if !self.0.contains(&v) {
                self.0.push(v);
            }
        }
    }
}

/// What one event asks of the host besides the head update.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// nothing else (the head changed, or nothing did)
    None,
    /// append this step to the log
    Append(Activity),
    /// the turn's result: end the turn
    Finish {
        text: String,
        is_error: bool,
        stopped: bool,
        stats: Option<HarnessStats>,
        auth_failed: bool,
        /// the API's own word for how it ended (`refusal`); empty when it said none
        stop_reason: String,
    },
    /// a result with background tasks still up: the turn stays open (the live line says so)
    Waiting(Activity),
    /// the account's usage windows (wisp.budget records them through `turn.limits`)
    Limits(Value),
    /// billed to an API key or a profile, not the plan
    Billing(String),
}

/// v1 `stepOf`: a tool call, a message or a failed call as a transcript step.
pub fn step_of(ev: &HarnessEvent) -> Option<Activity> {
    Some(match ev {
        HarnessEvent::Tool { kind, label, file, detail, id, output, title } => Activity::Tool {
            tool: *kind,
            label: label.clone(),
            title: title.clone(),
            file: file.clone(),
            detail: detail.clone(),
            call_id: id.clone(),
            output: output.as_deref().filter(|_| shows_output(*kind)).map(clip_output),
        },
        HarnessEvent::Text { text } => Activity::Text { text: head16(text, MAX_TEXT).to_owned() },
        HarnessEvent::ToolError { name, text, .. } => {
            Activity::ToolError { name: if name.is_empty() { "Tool".into() } else { name.clone() }, text: text.clone(), hide: Vec::new() }
        }
        HarnessEvent::Thinking { text } => Activity::Thinking { text: text.clone(), hide: Vec::new() },
        _ => return None,
    })
}

/// The live line while a turn waits on its background tasks.
pub fn waiting_step(tasks: &[String]) -> Activity {
    let label = match tasks {
        [] => "Background work finished, wrapping up".to_owned(),
        [one] => format!("Waiting on background task: {one}"),
        many => format!("Waiting on {} background tasks", many.len()),
    };
    Activity::Tool {
        tool: ToolKind::Background,
        label: head16(&label, 200).to_owned(),
        file: None,
        detail: None,
        call_id: None,
        output: None,
        title: None,
    }
}

fn record_change(head: &mut Head, file: &str, op: ChangeOp, edits: &[Edit]) {
    match head.changes.iter_mut().find(|c| c.file == file) {
        Some(c) => {
            if op == ChangeOp::Add && c.edits.is_empty() {
                c.op = ChangeOp::Add;
            }
            c.edits.extend_from_slice(edits);
        }
        None => head.changes.push(FileChange { file: file.to_owned(), op, edits: edits.to_vec() }),
    }
}

/// A call that names a .env file: its `tool_output` is flagged `env` (ADR-0050).
fn note_env_call(head: &mut Head, ev: &HarnessEvent) {
    if let HarnessEvent::Tool { file, detail, label, id: Some(id), .. } = ev
        && crate::env_mask::call_reads_env(file.as_deref(), detail.as_deref(), Some(label))
    {
        head.env_calls.push(id.clone());
    }
}

/// A step's text that quotes a .env value (ADR-0050): its thinking or a tool's error quoting a value of a .env file
/// this turn read, or a line shaped like one; all of an error from a call that read one. A tool call that printed a
/// .env file inline (its `output`) adds its values.
fn flag_quotes(head: &mut Head, ev: &HarnessEvent, mut a: Activity) -> Activity {
    match (&mut a, ev) {
        (_, HarnessEvent::Tool { file, detail, label, output: Some(out), .. })
            if crate::env_mask::call_reads_env(file.as_deref(), detail.as_deref(), Some(label)) =>
        {
            head.env_values.add(out);
        }
        (Activity::Thinking { text: Some(text), hide }, _) => *hide = wisp_envmask::quote_spans(text, &head.env_values.0),
        (Activity::ToolError { text, hide, .. }, HarnessEvent::ToolError { id, .. }) => {
            *hide = if id.as_ref().is_some_and(|id| head.env_calls.contains(id)) {
                wisp_envmask::text_spans(text)
            } else {
                wisp_envmask::quote_spans(text, &head.env_values.0)
            };
        }
        _ => {}
    }
    a
}

/// Applies one event to the head and says what else to do. `plain`: the turn asked for a plain answer
/// (wisp blocks off); `is_fallback`: whether a text is an answer that broke the protocol (the block
/// parser's `fallback`), passed in so this module stays independent of it.
pub fn apply(head: &mut Head, ev: &HarnessEvent, plain: bool, is_fallback: &dyn Fn(&str) -> bool) -> Effect {
    match ev {
        HarnessEvent::Session { id } => head.resume_id = Some(id.clone()),
        HarnessEvent::Text { text } => {
            head.text = Some(text.clone());
            return step_of(ev).map_or(Effect::None, Effect::Append);
        }
        HarnessEvent::Tool { .. } | HarnessEvent::ToolError { .. } | HarnessEvent::Thinking { .. } => {
            note_env_call(head, ev);
            return step_of(ev).map_or(Effect::None, |a| Effect::Append(flag_quotes(head, ev, a)));
        }
        HarnessEvent::ToolOutput { id, text } => {
            let env = head.env_calls.contains(id);
            if env {
                head.env_values.add(text);
            }
            return Effect::Append(Activity::ToolOutput { call_id: id.clone(), text: clip_output(text), env });
        }
        HarnessEvent::Change { file, op, edits, early, .. } => {
            if !*early || !head.changes.iter().any(|c| &c.file == file) {
                record_change(head, file, op.normalised(), edits);
            }
        }
        HarnessEvent::Blocked { tool, detail, rule } => {
            let item = BlockedAction { tool: tool.clone(), detail: detail.clone(), rule: rule.clone() };
            if !head.blocked.iter().any(|b| b.tool == item.tool && b.detail == item.detail) {
                head.blocked.push(item);
            }
        }
        HarnessEvent::Limits { .. } => {
            return Effect::Limits(serde_json::to_value(ev).unwrap_or(Value::Null));
        }
        HarnessEvent::Billing { kind } => {
            return Effect::Billing(serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default());
        }
        HarnessEvent::Tools { list } => head.tools = Some(list.clone()),
        HarnessEvent::Cli { .. } => head.cli = serde_json::to_value(ev).ok(),
        HarnessEvent::Background { tasks } => {
            head.background.clone_from(tasks);
            if head.interim.is_some() {
                return Effect::Waiting(waiting_step(tasks));
            }
        }
        HarnessEvent::Approval { .. } => {}
        HarnessEvent::Result { text, is_error, stopped, stats, auth_failed, background, background_agents, stop_reason, .. } => {
            // Its subagents are still at work: whatever it said, it isn't done; their reports come back into this run
            // and the answer after them ends the turn (v1 #775: a goal is checked on that one, not this).
            if background_agents.unwrap_or(0) > 0 && !*is_error && !*stopped {
                head.interim = Some((text.clone(), stats.clone()));
                return Effect::Waiting(waiting_step(&head.background));
            }
            // It ended its turn in plain text with background tasks still running ("I'll report once it's
            // done"): the CLI wakes it when they finish. A full presentation is a finished task that left
            // something up (a dev server).
            if background.unwrap_or(0) > 0 && !*is_error && !plain && is_fallback(text) {
                head.interim = Some((text.clone(), stats.clone()));
                return Effect::Waiting(waiting_step(&head.background));
            }
            head.interim = None;
            return Effect::Finish {
                text: text.clone(),
                is_error: *is_error,
                stopped: *stopped,
                stats: stats.clone(),
                auth_failed: *auth_failed,
                stop_reason: stop_reason.clone().unwrap_or_default(),
            };
        }
    }
    Effect::None
}

/// The run let go while the turn still ran: the interim result is the best we have, else an error.
pub fn exit_without_result(head: &mut Head) -> Effect {
    match head.interim.take() {
        Some((text, stats)) => {
            Effect::Finish { text, is_error: false, stopped: false, stats, auth_failed: false, stop_reason: String::new() }
        }
        None => Effect::Finish {
            text: "The agent exited without a result.".into(),
            is_error: true,
            stopped: false,
            stats: None,
            auth_failed: false,
            stop_reason: String::new(),
        },
    }
}
