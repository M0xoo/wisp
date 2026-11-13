//! A task seen live from the terminal (ADR-0022): the rows of its topic (`session:<id>`: the session,
//! its turns, the event log) in, what to print out. Activity lines as the run goes, the answer drawn
//! with the block renderers when a turn ends, and the question or approval it waits on. Sans-IO: the
//! host feeds sync's snapshots and ops in and does the reading and writing.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;
use wisp_cli_api::Style;
use wisp_protocol::{Change, EntityOp, Row, apply_patch};

use crate::blocks::Renderers;
use crate::term::{self, DIM, GREEN, RED, YELLOW, paint};

/// How many steps of a turn already running when you attach are shown (the rest are counted).
pub const BACKLOG: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Out {
    /// an activity or status line
    Line(String),
    /// the answer of a turn, drawn
    Answer(Vec<String>),
    /// the task waits on the user: a question or an approval, with its choices
    Ask { id: String, question: String, options: Vec<String> },
    /// the question was answered (here or elsewhere)
    Answered,
    /// no turn is running any more: the task's state (`review`, `done`, `error`, `waiting`)
    Idle { state: String },
}

#[derive(Debug, Default)]
pub struct View {
    task: String,
    /// (entity, id) → the row's value
    rows: BTreeMap<(String, String), Value>,
    shown_seq: i64,
    answered: HashSet<String>,
    ask: Option<String>,
    idle: Option<String>,
    started: bool,
    /// launched from this terminal just now: every step from the start, not the backlog of an attach
    fresh: bool,
    session: Value,
}

fn st<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn body(v: &Value) -> &Value {
    v.get("body").unwrap_or(v)
}

/// A store row as one object: its columns (`state`, `title`, `seq`) with its JSON `body` over them.
fn merged(v: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(o) = v.as_object() {
        for (k, x) in o.iter().filter(|(k, _)| *k != "body" && *k != "summary") {
            out.insert(k.clone(), x.clone());
        }
    }
    if let Some(b) = v.get("body").and_then(Value::as_object) {
        for (k, x) in b {
            out.entry(k.clone()).or_insert_with(|| x.clone());
        }
    }
    Value::Object(out)
}

/// `text` with the task's folder taken off its paths (`/Users/me/proj/src/a.ts` → `src/a.ts`; macOS
/// reports `/tmp` as `/private/tmp`).
fn relative(text: &str, cwd: &str) -> String {
    if cwd.len() < 2 {
        return text.to_owned();
    }
    let dir = format!("{}/", cwd.trim_end_matches('/'));
    text.replace(&format!("/private{dir}"), "").replace(&dir, "")
}

/// One step of a turn as the GUI's activity line says it, its paths relative to the task's folder.
pub fn activity(a: &Value, s: &Style, cwd: &str) -> Option<String> {
    let w = s.width.saturating_sub(4);
    let line = match st(a, "kind") {
        "tool" => {
            let file = relative(st(a, "file"), cwd);
            let label = relative(if st(a, "label").is_empty() { st(a, "tool") } else { st(a, "label") }, cwd);
            let txt = if file.is_empty() || label.contains(&file) { label } else { format!("{label} {}", paint(s, DIM, &file)) };
            format!("  {} {}", paint(s, DIM, "▸"), term::truncate(&txt, w))
        }
        "text" => {
            let t = st(a, "text").lines().find(|l| !l.trim().is_empty())?.trim();
            format!("  {} {}", paint(s, DIM, "┆"), paint(s, DIM, &term::truncate(t, w)))
        }
        "thinking" => format!("  {}", paint(s, DIM, "… thinking")),
        "tool_error" => format!("  {} {}", paint(s, RED, "✗"), term::truncate(&format!("{}: {}", st(a, "name"), st(a, "text")), w)),
        "blocked" => format!("  {} {}", paint(s, RED, "⊘"), term::truncate(&format!("{}: {}", st(a, "tool"), st(a, "detail")), w)),
        "notice" => format!("  {} {}", paint(s, YELLOW, "!"), term::truncate(st(a, "text"), w)),
        _ => return None,
    };
    Some(line)
}

/// A turn's answer: its presentation's blocks, else its text as markdown.
pub fn answer(turn: &Value, s: &Style, r: &Renderers) -> Vec<String> {
    let p = turn.get("presentation");
    let blocks = p.and_then(|p| p.get("blocks")).and_then(Value::as_array).filter(|b| !b.is_empty());
    let fallback = p.and_then(|p| p.get("fallback")).and_then(Value::as_bool) == Some(true);
    match blocks {
        Some(b) if !fallback => r.answer(b, s),
        _ => crate::md::render(s, st(turn, "text")),
    }
}

fn ended(status: &str) -> bool {
    matches!(status, "done" | "error" | "stopped")
}

impl View {
    pub fn new(task: impl Into<String>) -> Self {
        Self { task: task.into(), shown_seq: -1, ..Self::default() }
    }

    /// A task this terminal just started: its steps are shown from the first one.
    pub fn launched(task: impl Into<String>) -> Self {
        Self { fresh: true, ..Self::new(task) }
    }

    pub fn session(&self) -> Option<&Value> {
        Some(&self.session).filter(|s| !s.is_null())
    }

    /// The task's state (`running`, `waiting`, `review`, `done`, `error`).
    pub fn state(&self) -> &str {
        self.session().map_or("", |s| st(s, "state"))
    }

    pub fn title(&self) -> &str {
        self.session().map_or("", |s| st(s, "title"))
    }

    /// The pending question's options, for a typed number.
    pub fn options(&self) -> Vec<String> {
        self.pending().map(|(_, _, o)| o).unwrap_or_default()
    }

    fn pending(&self) -> Option<(String, String, Vec<String>)> {
        let ask = self.session()?.get("ext")?.get("wisp.runtime")?.get("ask")?;
        if ask.is_null() {
            return None;
        }
        let options = ask
            .get("options")
            .and_then(Value::as_array)
            .map(|o| o.iter().map(|x| x.as_str().map_or_else(|| st(x, "label").to_owned(), str::to_owned)).collect())
            .unwrap_or_default();
        let id = if st(ask, "id").is_empty() { st(ask, "question").to_owned() } else { st(ask, "id").to_owned() };
        Some((id, st(ask, "question").to_owned(), options))
    }

    /// The turns, oldest first, each as one object.
    fn turns(&self) -> Vec<Value> {
        let mut t: Vec<Value> = self.rows.iter().filter(|((e, _), _)| e == "turn").map(|(_, v)| merged(v)).collect();
        t.sort_by_key(|v| v.get("idx").and_then(Value::as_i64).unwrap_or(0));
        t
    }

    /// A first look (or a resubscribe): the rows replace what the view held.
    pub fn snapshot(&mut self, rows: Vec<Row>, s: &Style, r: &Renderers) -> Vec<Out> {
        self.rows.clear();
        for row in rows {
            self.rows.insert((row.e, row.id), row.v);
        }
        self.settle(s, r)
    }

    pub fn ops(&mut self, ops: Vec<EntityOp>, s: &Style, r: &Renderers) -> Vec<Out> {
        for op in ops {
            let key = (op.e, op.id);
            match op.change {
                Change::Upsert { v } => {
                    self.rows.insert(key, v);
                }
                Change::Del => {
                    self.rows.remove(&key);
                }
                Change::Patch { ops } => {
                    if let Some(v) = self.rows.get_mut(&key) {
                        let _ = apply_patch(v, &ops);
                    }
                }
                // an event log: `append` on the task's id carries the new rows, each with its own id
                Change::Append { v } => {
                    for item in v {
                        let id = item.get("id").map_or_else(
                            || item.get("seq").map(Value::to_string).unwrap_or_default(),
                            |i| i.as_str().map_or_else(|| i.to_string(), str::to_owned),
                        );
                        self.rows.insert((key.0.clone(), id), item);
                    }
                }
            }
        }
        self.settle(s, r)
    }

    /// What changed since the last look, as lines and prompts.
    fn settle(&mut self, s: &Style, r: &Renderers) -> Vec<Out> {
        let mut out = Vec::new();
        let first = !self.started && !self.fresh;
        self.started = true;
        self.session = self.rows.get(&("session".to_owned(), self.task.clone())).map_or(Value::Null, merged);
        let turns: Vec<(String, Value)> = self.turns().into_iter().map(|t| (st(&t, "id").to_owned(), t)).collect();
        if first {
            // attaching: the finished turns were seen before; only the last one's answer is shown
            let last = turns.last().map(|(id, _)| id.clone());
            for (id, t) in &turns {
                if ended(st(t, "status")) && Some(id) != last.as_ref() {
                    self.answered.insert(id.clone());
                }
            }
        }
        let mut events: Vec<(i64, String, Value)> = self
            .rows
            .iter()
            .filter(|((e, _), _)| e == "event")
            .map(|(_, v)| (v.get("seq").and_then(Value::as_i64).unwrap_or(0), st(v, "turn_id").to_owned(), body(v).clone()))
            .filter(|(seq, turn, _)| *seq > self.shown_seq && !self.answered.contains(turn))
            .collect();
        events.sort_by_key(|e| e.0);
        let cwd = st(&self.session, "cwd").to_owned();
        let running: Option<String> = turns.iter().rev().find(|(_, t)| !ended(st(t, "status"))).map(|(id, _)| id.clone());
        if first && events.len() > BACKLOG {
            let skip = events.len() - BACKLOG;
            out.push(Out::Line(paint(s, DIM, &format!("  … {skip} earlier steps"))));
            events.drain(..skip);
        }
        for (seq, turn, a) in events {
            self.shown_seq = self.shown_seq.max(seq);
            // a finished turn's own steps were shown live; on a first look only the running turn's
            if first && Some(&turn) != running.as_ref() && running.is_some() {
                continue;
            }
            if let Some(line) = activity(&a, s, &cwd) {
                out.push(Out::Line(line));
            }
        }
        let mut answered_now = false;
        for (id, t) in &turns {
            if ended(st(t, "status")) && self.answered.insert(id.clone()) {
                answered_now = true;
                let lines = answer(t, s, r);
                if st(t, "status") == "stopped" {
                    out.push(Out::Line(paint(s, YELLOW, "  ◼ stopped")));
                }
                if !lines.is_empty() {
                    out.push(Out::Answer(lines));
                }
            }
        }
        match (self.pending(), self.ask.clone()) {
            (Some((id, question, options)), had) if had.as_ref() != Some(&id) => {
                self.ask = Some(id.clone());
                out.push(Out::Ask { id, question, options });
            }
            (None, Some(_)) => {
                self.ask = None;
                out.push(Out::Answered);
            }
            _ => {}
        }
        let state = self.state().to_owned();
        let busy = running.is_some() || state == "running" || state.is_empty();
        if busy {
            self.idle = None;
        } else if self.idle.as_deref() != Some(&state) || answered_now {
            // a whole turn may land in one batch: each answer ends in an idle again
            self.idle = Some(state.clone());
            out.push(Out::Idle { state });
        }
        out
    }
}

/// The one-line state of a task, as `wisp ls` and the notices say it.
pub fn state_line(s: &Style, state: &str) -> String {
    match state {
        "review" | "done" => paint(s, GREEN, &format!("✓ {state}")),
        "error" => paint(s, RED, "✗ failed"),
        "waiting" => paint(s, YELLOW, "? waiting for you"),
        "running" => paint(s, YELLOW, "◌ running"),
        other => other.to_owned(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(e: &str, id: &str, v: Value) -> Row {
        Row { e: e.into(), id: id.into(), v }
    }

    fn up(e: &str, id: &str, v: Value) -> EntityOp {
        EntityOp { topic: wisp_protocol::Topic::parse("session:S").unwrap(), e: e.into(), id: id.into(), change: Change::Upsert { v } }
    }

    fn lines(out: &[Out]) -> Vec<String> {
        out.iter()
            .flat_map(|o| match o {
                Out::Line(l) => vec![l.clone()],
                Out::Answer(a) => a.clone(),
                Out::Ask { question, .. } => vec![format!("ASK {question}")],
                Out::Answered => vec!["ANSWERED".into()],
                Out::Idle { state } => vec![format!("IDLE {state}")],
            })
            .collect()
    }

    #[allow(clippy::needless_pass_by_value)]
    fn session(state: &str, ask: Value) -> Value {
        // as the store writes it: columns, then the JSON body
        json!({ "id": "S", "state": state, "title": "fix", "body": { "cwd": "/w", "ext": { "wisp.runtime": { "ask": ask } } } })
    }

    #[test]
    fn a_run_streams_its_steps_then_its_answer_then_goes_idle() {
        let (s, r) = (Style::plain(60), Renderers::builtin());
        let mut v = View::new("S");
        let out = v.snapshot(
            vec![
                row("session", "S", session("running", Value::Null)),
                row("turn", "T1", json!({ "id": "T1", "idx": 0, "body": { "status": "running" } })),
            ],
            &s,
            &r,
        );
        assert_eq!(lines(&out), Vec::<String>::new());
        // the event log grows by `append` on the task's id, as the store sends it
        let ev = |seq: i64, b: Value| json!({ "id": seq + 6, "seq": seq, "turn_id": "T1", "body": b });
        let log = EntityOp {
            topic: wisp_protocol::Topic::parse("session:S").unwrap(),
            e: "event".into(),
            id: "S".into(),
            change: Change::Append {
                v: vec![
                    ev(1, json!({ "kind": "tool", "tool": "read", "label": "Read math.js", "file": "math.js" })),
                    ev(2, json!({ "kind": "thinking" })),
                ],
            },
        };
        let out = v.ops(vec![log], &s, &r);
        assert_eq!(lines(&out), ["  ▸ Read math.js", "  … thinking"]);
        let done = json!({ "id": "T1", "idx": 0, "body": { "status": "done", "presentation": { "v": 1, "blocks": [{ "type": "hero", "title": "Fixed add", "status": "done", "summary": "a + b" }] } } });
        let out = v.ops(vec![up("turn", "T1", done), up("session", "S", session("review", Value::Null))], &s, &r);
        assert_eq!(lines(&out), ["✓ Fixed add", "  a + b", "IDLE review"]);
        assert_eq!(v.ops(vec![], &s, &r), Vec::new(), "nothing twice");
        // a follow-up that ran start to end between two looks: its answer, then idle again
        let t2 = json!({ "id": "T2", "idx": 1, "body": { "status": "done", "text": "**again**" } });
        assert_eq!(lines(&v.ops(vec![up("turn", "T2", t2)], &s, &r)), ["again", "IDLE review"]);
    }

    #[test]
    fn a_question_is_asked_once_and_its_answer_noticed() {
        let (s, r) = (Style::plain(60), Renderers::builtin());
        let mut v = View::new("S");
        v.snapshot(vec![row("session", "S", session("running", Value::Null))], &s, &r);
        let out = v.ops(
            vec![up("session", "S", session("waiting", json!({ "id": "a1", "question": "Which branch?", "options": ["main", "dev"] })))],
            &s,
            &r,
        );
        assert_eq!(out[0], Out::Ask { id: "a1".into(), question: "Which branch?".into(), options: vec!["main".into(), "dev".into()] });
        assert_eq!(v.options(), ["main", "dev"]);
        let out = v.ops(vec![up("session", "S", session("running", Value::Null))], &s, &r);
        assert_eq!(lines(&out), ["ANSWERED"]);
    }

    #[test]
    fn attaching_later_shows_the_last_answer_and_a_short_backlog() {
        let (s, r) = (Style::plain(60), Renderers::builtin());
        let mut v = View::new("S");
        let mut rows = vec![row("session", "S", session("running", Value::Null))];
        rows.push(row("turn", "T0", json!({ "id": "T0", "idx": 0, "body": { "status": "done", "text": "old answer" } })));
        rows.push(row("turn", "T1", json!({ "id": "T1", "idx": 1, "body": { "status": "running" } })));
        for n in 0..20 {
            rows.push(row(
                "event",
                &n.to_string(),
                json!({ "seq": n, "turn_id": "T1", "body": { "kind": "tool", "label": format!("step {n}") } }),
            ));
        }
        let got = lines(&v.snapshot(rows, &s, &r));
        assert_eq!(got.first().map(String::as_str), Some("  … 8 earlier steps"));
        assert_eq!(got.len(), 1 + BACKLOG, "{got:?}");
        assert!(!got.iter().any(|l| l.contains("old answer")), "a finished turn before the running one isn't replayed");
    }
}
