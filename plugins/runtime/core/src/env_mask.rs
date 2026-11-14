//! .env values as a task's turns and events leave the server (ADR-0050, v1 `maskTurn`/`maskStep`): a step's output
//! when it read a .env file, a turn's captured edits to one, a code or diff block about one, and the same blocks
//! inside the answer's raw text. Every function works on the JSON one row (or one patch op) carries, with nothing
//! else to look at: a `tool_output` says it is a .env file's text with its `env` flag, which the turn machine sets
//! when the call it answers named one. The stored rows are never touched; Reveal reads them (`unmasked`).
//! Pure: no IO, no clock.

use serde_json::{Map, Value};
use wisp_envmask::{
    env_values, is_env_file, mask_block, mask_edit, mask_spans, mask_text, names_env_file, quote_spans, reads_env_file, value_spans,
};

use crate::blocks::parse::json_end;

const OPEN: &str = "```wisp";
const RUNTIME: &str = "wisp.runtime";

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// One step (an event row's `body`, or a `Step` as `runtime.activity` returns it) masked in place; true when it
/// changed. A tool step's `output` when it read a .env file, a `tool_output` flagged `env`, an answer text's wisp
/// blocks.
pub fn mask_step(step: &mut Value) -> bool {
    mask_step_in(step, &Calls::default())
}

/// The calls a batch of steps shows: the ones that read a .env file, and every one seen. A `tool_output` from before
/// ADR-0050 (no `env` flag) is decided by its call when the batch has it, else by its text (`looks_like_env`).
/// `values`: what those .env outputs say, so a thinking or an error in the batch that quotes one is masked even
/// when its row has no `hide` (one from before it, or one the turn machine couldn't flag).
#[derive(Default)]
struct Calls {
    env: std::collections::HashSet<String>,
    seen: std::collections::HashSet<String>,
    values: Vec<String>,
}

impl Calls {
    fn of<'a>(steps: impl Iterator<Item = &'a Value> + Clone) -> Self {
        let mut c = Self::default();
        for st in steps.clone().filter(|x| !matches!(s(x, "kind"), Some("tool_output" | "output"))) {
            let Some(id) = s(st, "callId").or_else(|| s(st, "call")) else {
                if reads_env_file(s(st, "file"), s(st, "detail"), s(st, "label")) {
                    c.add(s(st, "output"));
                }
                continue;
            };
            if reads_env_file(s(st, "file"), s(st, "detail"), s(st, "label")) {
                c.env.insert(id.to_owned());
                c.add(s(st, "output"));
            }
            c.seen.insert(id.to_owned());
        }
        for st in steps.filter(|x| matches!(s(x, "kind"), Some("tool_output" | "output"))) {
            if c.output_is_env(st) {
                c.add(s(st, "text").or_else(|| s(st, "output")));
            }
        }
        c
    }

    fn add(&mut self, text: Option<&str>) {
        for v in text.map(env_values).into_iter().flatten() {
            if !self.values.contains(&v) {
                self.values.push(v);
            }
        }
    }

    /// A `tool_output` is a .env file's text: its flag says, else its call in the batch, else its text.
    fn output_is_env(&self, step: &Value) -> bool {
        let call = s(step, "callId").or_else(|| s(step, "call")).unwrap_or_default();
        match step.get("env").and_then(Value::as_bool) {
            Some(flag) => flag,
            None if self.seen.contains(call) => self.env.contains(call),
            // a row from before the flag, its call out of sight: its text decides
            None => s(step, "text").or_else(|| s(step, "output")).is_some_and(looks_like_env),
        }
    }
}

/// Every line but blanks and comments reads `KEY=value`: a .env file's text, whoever printed it.
fn looks_like_env(text: &str) -> bool {
    let mut any = false;
    for l in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let Some((k, _)) = l.split_once('=') else { return false };
        let k = k.trim().trim_start_matches("export ").trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || k.starts_with(|c: char| c.is_ascii_digit()) {
            return false;
        }
        any = true;
    }
    any
}

/// A batch of steps (a page, a snapshot's event rows' bodies), each masked; a `tool_output` from before ADR-0050
/// finds its call in the batch.
pub fn mask_steps<'a>(steps: impl IntoIterator<Item = &'a mut Value>) -> bool {
    let mut all: Vec<&'a mut Value> = steps.into_iter().collect();
    let calls = Calls::of(all.iter().map(|v| &**v));
    all.iter_mut().fold(false, |c, st| mask_step_in(st, &calls) | c)
}

fn mask_step_in(step: &mut Value, calls: &Calls) -> bool {
    let kind = s(step, "kind").unwrap_or_default();
    if kind == "tool_output" || kind == "output" {
        if calls.output_is_env(step) {
            step.as_object_mut().map(|o| o.remove("hide"));
            return mask_field(step, &["text", "output"]);
        }
        // another command's output that quotes a value the task read
        return mask_quotes(step, &["text", "output"], &calls.values, value_spans);
    }
    // what an agent wrote itself: its thinking, a tool's error (v2's `text`, v1's `label`)
    if matches!(kind, "thinking" | "tool_error" | "error") {
        return mask_quotes(step, &["text", "label"], &calls.values, quote_spans);
    }
    if kind == "text" {
        let Some(m) = s(step, "text").and_then(mask_answer_text) else { return false };
        step["text"] = Value::String(m);
        return true;
    }
    // a v2 tool step, or a v1 activity item (`run`, `read`… with `output`) the importer kept as it was
    let mut changed = reads_env_file(s(step, "file"), s(step, "detail"), s(step, "label")) && mask_field(step, &["output"]);
    // its command line, label or title quoting a value (`curl -H "Bearer sk-…"`)
    changed |= mask_tool_quotes(step, &calls.values);
    changed
}

/// A tool step's fields masked where they quote a .env value: the ranges the turn machine flagged per field (`hide`,
/// dropped as it leaves), then the batch's values. An unreadable `hide` hides
/// every field it could name (fail closed).
fn mask_tool_quotes(step: &mut Value, values: &[String]) -> bool {
    const FIELDS: [&str; 5] = ["label", "detail", "title", "output", "rule"];
    let hide: std::collections::BTreeMap<String, Vec<[u32; 2]>> = match step.as_object_mut().and_then(|o| o.remove("hide")) {
        Some(h) => serde_json::from_value(h).unwrap_or_else(|_| FIELDS.iter().map(|k| ((*k).to_owned(), vec![[0, u32::MAX]])).collect()),
        None => std::collections::BTreeMap::new(),
    };
    let mut changed = !hide.is_empty();
    for k in FIELDS {
        let Some(t) = s(step, k) else { continue };
        let first = hide.get(k).map_or_else(|| t.to_owned(), |h| mask_spans(t, h));
        let m = mask_spans(&first, &value_spans(&first, values));
        if m != t {
            step[k] = Value::String(m);
            changed = true;
        }
    }
    changed
}

/// A thinking or error step's text masked where it quotes a .env value: the ranges the turn machine flagged
/// (`hide`, dropped as it leaves: they say where the text was masked, and fit it no more), then the batch's values and
/// any line shaped like a .env line.
fn mask_quotes(step: &mut Value, keys: &[&str], values: &[String], spans: fn(&str, &[String]) -> Vec<[u32; 2]>) -> bool {
    let hide: Vec<[u32; 2]> = match step.as_object_mut().and_then(|o| o.remove("hide")) {
        Some(h) => serde_json::from_value(h).unwrap_or_else(|_| vec![[0, u32::MAX]]), // unreadable: all of it (fail closed)
        None => Vec::new(),
    };
    let mut changed = !hide.is_empty();
    for (i, k) in keys.iter().enumerate() {
        let Some(t) = s(step, k) else { continue };
        // `hide` is about the first key (v2's `text`); a v1 row's `label` / `output` has none
        let first = if i == 0 && !hide.is_empty() { mask_spans(t, &hide) } else { t.to_owned() };
        let m = mask_spans(&first, &spans(&first, values));
        if m != t {
            step[*k] = Value::String(m);
            changed = true;
        }
    }
    changed
}

fn mask_field(v: &mut Value, keys: &[&str]) -> bool {
    let mut changed = false;
    for k in keys {
        if let Some(t) = s(v, k) {
            let m = mask_text(t);
            if m != t {
                v[*k] = Value::String(m);
                changed = true;
            }
        }
    }
    changed
}

/// Whether a tool call's `output` will be a .env file's text (the turn machine flags its `tool_output`).
pub fn call_reads_env(file: Option<&str>, detail: Option<&str>, label: Option<&str>) -> bool {
    reads_env_file(file, detail, label)
}

/// A captured change (`{file, op, edits:[{before, after}]}`) to a .env file, masked in place.
pub fn mask_change(c: &mut Value) -> bool {
    if !s(c, "file").is_some_and(is_env_file) {
        return false;
    }
    let mut changed = false;
    for e in c.get_mut("edits").and_then(Value::as_array_mut).into_iter().flatten() {
        let (b, a) = (s(e, "before").unwrap_or_default(), s(e, "after").unwrap_or_default());
        let (mb, ma) = mask_edit(b, a);
        if mb != b || ma != a {
            e["before"] = Value::String(mb);
            e["after"] = Value::String(ma);
            changed = true;
        }
    }
    if let Some(f) = s(c, "beforeFile") {
        c["beforeFile"] = Value::String(mask_text(f));
        changed = true;
    }
    if changed {
        c["masked"] = Value::Bool(true);
    }
    changed
}

/// An answer block masked in place (with `masked: true`, so a page knows Reveal has something to ask for).
pub fn mask_one_block(b: &mut Value) -> bool {
    let Some(mut m) = mask_block(b) else { return false };
    if m == *b {
        return false;
    }
    m["masked"] = Value::Bool(true);
    *b = m;
    true
}

fn mask_blocks(blocks: &mut Value) -> bool {
    let mut changed = false;
    for b in blocks.as_array_mut().into_iter().flatten() {
        changed |= mask_one_block(b);
    }
    changed
}

fn mask_changes(list: &mut Value) -> bool {
    let mut changed = false;
    for c in list.as_array_mut().into_iter().flatten() {
        changed |= mask_change(c);
    }
    changed
}

fn mask_ext(ext: &mut Value, known: Known<'_>) -> bool {
    ext.get_mut(RUNTIME).is_some_and(|r| mask_runtime_slot(r, known))
}

/// wisp.runtime's slot on a turn: its captured changes, and the calls its permissions refused (`blocked`).
fn mask_runtime_slot(r: &mut Value, known: Known<'_>) -> bool {
    let changed = r.get_mut("changes").is_some_and(mask_changes);
    r.get_mut("blocked").is_some_and(|l| mask_blocked(l, known)) | changed
}

fn mask_blocked(list: &mut Value, known: Known<'_>) -> bool {
    let mut changed = false;
    for b in list.as_array_mut().into_iter().flatten() {
        changed |= mask_blocked_known(b, known);
    }
    changed
}

/// The .env values the task's turns read (`env_known`), when the caller has them; `None`: unknown (a patch, which
/// can't say whose turn it is, or a task whose stored reads aren't loaded yet).
pub type Known<'a> = Option<&'a [String]>;

/// One refused call of a turn's `blocked` list (`{tool, detail, rule, hide}`) masked where its command line or rule
/// quotes a .env value the task read, its task's values unknown (see [`mask_blocked_known`]).
pub fn mask_blocked_one(b: &mut Value) -> bool {
    mask_blocked_known(b, None)
}

/// One refused call masked: the ranges the turn machine flagged (`hide`, dropped as it leaves), then `known`. An
/// unreadable `hide` hides its detail and rule whole. An item with no `hide` at all was stored before ranges existed
/// (the turn machine writes `hide: {}` when nothing matched): masked against `known` and every `KEY=value` line, as a
/// tool step with no ranges is; with `known` unknown too, its detail and rule are hidden whole (fail closed).
pub fn mask_blocked_known(b: &mut Value, known: Known<'_>) -> bool {
    const FIELDS: [&str; 2] = ["detail", "rule"];
    let whole = || FIELDS.iter().map(|k| ((*k).to_owned(), vec![[0, u32::MAX]])).collect();
    let (hide, old): (std::collections::BTreeMap<String, Vec<[u32; 2]>>, bool) = match b.as_object_mut().and_then(|o| o.remove("hide")) {
        Some(h) => (serde_json::from_value(h).unwrap_or_else(|_| whole()), false),
        None if known.is_none() && FIELDS.iter().any(|k| s(b, k).is_some_and(|t| !t.is_empty())) => (whole(), true),
        None => (std::collections::BTreeMap::new(), true),
    };
    let values = known.unwrap_or_default();
    let mut changed = !old || !hide.is_empty();
    for k in FIELDS {
        let Some(t) = s(b, k) else { continue };
        let first = hide.get(k).map_or_else(|| t.to_owned(), |h| mask_spans(t, h));
        let mut m = mask_spans(&first, &value_spans(&first, values));
        if old {
            m = mask_spans(&m, &quote_spans(&m, values));
        }
        if m != t {
            b[k] = Value::String(m);
            changed = true;
        }
    }
    changed
}

/// Every string in `v` as `••••`: a patch op too deep in a refused call to say where its value is (fail closed).
fn hide_strings(v: &mut Value) -> bool {
    match v {
        Value::String(t) if !t.is_empty() => {
            wisp_envmask::DOTS.clone_into(t);
            true
        }
        Value::Array(a) => a.iter_mut().fold(false, |c, x| hide_strings(x) | c),
        Value::Object(o) => o.values_mut().fold(false, |c, x| hide_strings(x) | c),
        _ => false,
    }
}

/// A turn (its `body`, or a `Turn` as `runtime.turns` returns it) masked in place: its blocks, its captured
/// changes, the blocks inside its raw answer text.
pub fn mask_turn(t: &mut Value) -> bool {
    mask_turn_known(t, None)
}

/// [`mask_turn`] with what the turn's task read (`known`), for its refused calls stored before ranges existed.
pub fn mask_turn_known(t: &mut Value, known: Known<'_>) -> bool {
    let mut changed = t.get_mut("presentation").and_then(|p| p.get_mut("blocks")).is_some_and(mask_blocks);
    changed |= t.get_mut("ext").is_some_and(|e| mask_ext(e, known));
    changed |= t.get_mut("changes").is_some_and(mask_changes); // the older place (and v1's)
    if let Some(m) = s(t, "text").and_then(mask_answer_text) {
        t["text"] = Value::String(m);
        changed = true;
    }
    changed
}

/// The answer's raw text with each wisp block's .env code and diff blocks masked, or `None` when it has none.
/// A block whose JSON doesn't parse but names a .env file is hidden whole: what it would show can't be told apart.
pub fn mask_answer_text(text: &str) -> Option<String> {
    if !text.contains(OPEN) || !text.contains(".env") {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    let mut changed = false;
    while let Some(p) = text[from..].find(OPEN).map(|p| from + p) {
        let Some(nl) = text[p..].find('\n').map(|n| p + n + 1) else { break };
        let end = json_end(&text[nl..]).map_or_else(|| close_of(text, nl), |e| nl + e);
        out.push_str(&text[from..nl]);
        let raw = &text[nl..end];
        match fence_masked(raw) {
            Some(m) => {
                out.push_str(&m);
                changed = true;
            }
            None => out.push_str(raw),
        }
        from = end;
    }
    out.push_str(&text[from..]);
    changed.then_some(out)
}

/// Where a broken block's body ends: its closing fence, or the text's end.
fn close_of(text: &str, body: usize) -> usize {
    text[body..].find("\n```").map_or(text.len(), |i| body + i)
}

fn fence_masked(raw: &str) -> Option<String> {
    match serde_json::from_str::<Value>(raw.trim()) {
        Ok(mut v) => {
            let changed = match &mut v {
                Value::Array(_) => mask_blocks(&mut v),
                Value::Object(o) => o.get_mut("blocks").is_some_and(mask_blocks),
                _ => false,
            };
            changed.then(|| serde_json::to_string(&v).unwrap_or_default())
        }
        Err(_) if names_env_file(raw) => Some(mask_text(raw)),
        Err(_) => None,
    }
}

/// A `turn` or `event` row (the store's columns: `body`, and a turn's `answer`) masked in place.
pub fn mask_row(entity: &str, row: &mut Value) -> bool {
    mask_row_known(entity, row, None)
}

/// [`mask_row`] with what the row's task read (`known`; a `turn` row names its task in `session_id`).
pub fn mask_row_known(entity: &str, row: &mut Value, known: Known<'_>) -> bool {
    match entity {
        "turn" => {
            let mut changed = row.get_mut("body").is_some_and(|b| mask_turn_known(b, known));
            if let Some(m) = s(row, "answer").and_then(mask_answer_text) {
                row["answer"] = Value::String(m);
                changed = true;
            }
            changed
        }
        "event" => row.get_mut("body").is_some_and(mask_step),
        _ => false,
    }
}

/// One patch op's value on a `turn` or `event` row, masked by where it lands (`path`, a JSON pointer). A value at
/// a level that names its own file (a block, a change, a step) is masked by the rules; anything deeper under one,
/// which can't say what file it belongs to, has every string masked.
pub fn mask_patch(entity: &str, path: &str, v: &mut Value) -> bool {
    let segs: Vec<String> = path.split('/').skip(1).map(|x| x.replace("~1", "/").replace("~0", "~")).collect();
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    match (entity, segs.as_slice()) {
        (_, []) => mask_row(entity, v),
        ("turn", ["body"]) => mask_turn(v),
        ("turn", ["answer"] | ["body", "text"]) => v.as_str().and_then(mask_answer_text).map(|m| *v = Value::String(m)).is_some(),
        ("turn", ["body", "presentation"]) => v.get_mut("blocks").is_some_and(mask_blocks),
        ("turn", ["body", "presentation", "blocks"]) => mask_blocks(v),
        ("turn", ["body", "presentation", "blocks", _]) => mask_one_block(v),
        ("turn", ["body", "ext"]) => mask_ext(v, None),
        ("turn", ["body", "ext", RUNTIME]) => mask_runtime_slot(v, None),
        ("turn", ["body", "ext", RUNTIME, "blocked"]) => mask_blocked(v, None),
        ("turn", ["body", "ext", RUNTIME, "blocked", _]) => mask_blocked_one(v),
        ("turn", ["body", "ext", RUNTIME, "blocked", _, k]) if *k != "hide" && *k != "tool" => hide_strings(v),
        ("turn", ["body", "ext", RUNTIME, "changes"] | ["body", "changes"]) => mask_changes(v),
        ("turn", ["body", "ext", RUNTIME, "changes", _] | ["body", "changes", _]) => mask_change(v),
        ("turn", ["body", "presentation", "blocks", _, ..] | ["body", "ext", RUNTIME, "changes", ..] | ["body", "changes", ..]) => {
            mask_strings(v)
        }
        ("event", ["body"]) => mask_step(v),
        ("event", ["body", "output" | "text", ..]) => mask_strings(v),
        _ => false,
    }
}

fn mask_strings(v: &mut Value) -> bool {
    match v {
        Value::String(t) => {
            let m = mask_text(t);
            let changed = m != *t;
            *t = m;
            changed
        }
        Value::Array(a) => a.iter_mut().fold(false, |c, x| mask_strings(x) | c),
        Value::Object(o) => o.values_mut().fold(false, |c, x| mask_strings(x) | c),
        _ => false,
    }
}

/// What Reveal asks for: one masked item of one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// a step's output (`seq`, the event's per-session seq)
    Step(u64),
    /// the turn's answer block at this index
    Block(usize),
    /// the turn's captured change to this file
    Change(String),
}

/// A turn's block or change as it is, for Reveal; `None` when it doesn't exist or isn't about a .env file (Reveal
/// shows masked items only: it is no way round anything else).
pub fn unmasked_of_turn(turn: &Value, item: &Item) -> Option<Value> {
    match item {
        Item::Block(i) => {
            let b = turn.pointer("/presentation/blocks")?.get(*i)?;
            mask_block(b).is_some().then(|| b.clone())
        }
        Item::Change(file) => {
            let all = turn.pointer("/ext/wisp.runtime/changes").or_else(|| turn.get("changes"))?;
            let c = all.as_array()?.iter().find(|c| s(c, "file") == Some(file.as_str()))?;
            if !is_env_file(file) {
                return None;
            }
            let mut c = c.clone();
            if let Some(o) = c.as_object_mut() {
                o.remove("beforeFile"); // only rollback reads it (v1)
            }
            Some(c)
        }
        Item::Step(_) => None,
    }
}

/// A step's output as it is, for Reveal: the step itself when its output was masked. `steps` are the turn's steps
/// (`Step` JSON: `seq`, `kind`, …) in order, so a `tool_output` finds the call it answers.
pub fn unmasked_step(steps: &[Value], seq: u64) -> Option<Value> {
    let st = steps.iter().find(|x| x.get("seq").and_then(Value::as_u64) == Some(seq))?;
    let mut probe = st.clone();
    mask_step_in(&mut probe, &Calls::of(steps.iter())).then(|| st.clone())
}

/// Event rows (the store's columns, `body` the step) masked as one batch, so an output finds its call.
pub fn mask_event_rows<'a>(rows: impl IntoIterator<Item = &'a mut Value>) -> bool {
    mask_steps(rows.into_iter().filter_map(|r| r.get_mut("body")))
}

/// An object with only these keys of `v` (a reply that says no more than it must).
pub fn pick(v: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(x) = v.get(*k) {
            out.insert((*k).to_owned(), x.clone());
        }
    }
    Value::Object(out)
}
