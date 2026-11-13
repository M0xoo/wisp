//! What the TUI knows, from the sync stream: the task list (the runtime's list topic) in the GUI's sections, and the
//! open task's transcript (its topic: the session row, its turns and its event log), folded as the CLI's attach view
//! folds them.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use wisp_protocol::{Change, EntityOp, Row};

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// A row's fields, its `body`'s and its `summary`'s, as one object: the store keeps hot fields at the top, the
/// rest in `body`, and a list row's own view (camelCase: `status`, `preview`, `forLater`…) in `summary`. The top
/// wins over the body; the summary adds what neither has.
pub fn merged(v: &Value) -> Value {
    let mut out = Map::new();
    if let Some(o) = v.as_object() {
        for (k, x) in o {
            if k != "body" && k != "summary" {
                out.insert(k.clone(), x.clone());
            }
        }
    }
    for part in ["body", "summary"] {
        if let Some(b) = v.get(part).and_then(Value::as_object) {
            for (k, x) in b {
                out.entry(k.clone()).or_insert_with(|| x.clone());
            }
        }
    }
    Value::Object(out)
}

/// The sidebar's sections, as the GUI's list has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    NeedsYou,
    Running,
    /// saved for later (design/for-later.md): the GUI's "For later"
    Later,
    Done,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Self::NeedsYou => "Needs you",
            Self::Running => "Running",
            Self::Later => "For later",
            Self::Done => "Done",
        }
    }
    pub fn of(t: &Value) -> Self {
        match s(t, "state") {
            "waiting" | "asking" => Self::NeedsYou,
            "review" if t.get("unread").and_then(Value::as_bool) == Some(true) => Self::NeedsYou,
            "running" | "starting" | "queued" => Self::Running,
            _ if t.get("forLater").is_some_and(|l| !l.is_null() && l != &Value::Bool(false)) => Self::Later,
            _ => Self::Done,
        }
    }
}

/// The task list: each row as the server sent it (patches apply to it) and flat, as it's drawn ([`merged`]).
#[derive(Debug, Default)]
pub struct Tasks {
    pub rows: BTreeMap<String, Value>,
    raw: BTreeMap<String, Value>,
}

impl Tasks {
    /// The tasks in their sections, newest first in each; archived ones left out.
    pub fn ordered(&self) -> Vec<(Section, &String, &Value)> {
        let mut v: Vec<(Section, &String, &Value)> = self.rows.iter().filter(|(_, t)| t.get("archived").and_then(Value::as_bool) != Some(true)).map(|(id, t)| (Section::of(t), id, t)).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| updated(b.2).cmp(&updated(a.2))));
        v
    }

    pub fn fold(&mut self, rows: Option<Vec<Row>>, ops: Vec<EntityOp>) -> Vec<String> {
        let mut changed = Vec::new();
        if let Some(rows) = rows {
            self.raw.clear();
            for r in rows.into_iter().filter(|r| r.e == "session") {
                changed.push(r.id.clone());
                self.raw.insert(r.id, r.v);
            }
            self.rows = self.raw.iter().map(|(k, v)| (k.clone(), merged(v))).collect();
        }
        for op in ops.into_iter().filter(|o| o.e == "session") {
            changed.push(op.id.clone());
            match op.change {
                Change::Upsert { v } => {
                    self.raw.insert(op.id.clone(), v);
                }
                Change::Del => {
                    self.raw.remove(&op.id);
                }
                Change::Patch { ops } => {
                    if let Some(v) = self.raw.get_mut(&op.id) {
                        let _ = wisp_protocol::apply_patch(v, &ops);
                    }
                }
                Change::Append { .. } => {}
            }
            match self.raw.get(&op.id) {
                Some(v) => {
                    self.rows.insert(op.id, merged(v));
                }
                None => {
                    self.rows.remove(&op.id);
                }
            }
        }
        changed
    }
}

pub fn updated(t: &Value) -> i64 {
    t.get("updated_at").or_else(|| t.get("updatedAt")).and_then(Value::as_i64).unwrap_or(0)
}

/// A question waiting for an answer (an ask, or a tool approval with its allow / always / deny).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
}

/// A turn row the task's window sent as a stub (`body.stub`).
fn is_stub(v: &Value) -> bool {
    v.get("body").and_then(|b| b.get("stub")).and_then(Value::as_bool) == Some(true)
}

/// The open task, from its topic.
#[derive(Debug, Default)]
pub struct Transcript {
    pub task: String,
    rows: BTreeMap<(String, String), Value>,
    /// tool rows opened by the user, by their seq
    pub expanded: BTreeSet<i64>,
}

impl Transcript {
    pub fn new(task: &str) -> Self {
        Self { task: task.to_owned(), ..Self::default() }
    }

    /// A first look at one of the task's two topics: `session:<id>`, a window whose older turns are stubs
    /// (v1 #788), or `session:<id>/all`, every turn whole. A window keeps the whole turns (and their events)
    /// the other brought, so a resync of the window never empties the older turns.
    pub fn snapshot(&mut self, rows: Vec<Row>) {
        let held = std::mem::take(&mut self.rows);
        for r in rows {
            self.rows.insert((r.e, r.id), r.v);
        }
        let stubs: BTreeSet<String> = self.rows.iter().filter(|((e, _), v)| e == "turn" && is_stub(v)).map(|((_, id), _)| id.clone()).collect();
        if stubs.is_empty() {
            return;
        }
        for ((e, id), v) in held {
            let keep = match e.as_str() {
                "turn" => stubs.contains(&id) && !is_stub(&v),
                "event" => v.get("turn_id").and_then(Value::as_str).is_some_and(|t| stubs.contains(t)),
                _ => false,
            };
            if keep {
                self.rows.insert((e, id), v);
            }
        }
    }

    pub fn ops(&mut self, ops: Vec<EntityOp>) {
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
                        let _ = wisp_protocol::apply_patch(v, &ops);
                    }
                }
                // an event log: `append` carries the new rows, each with its own id
                Change::Append { v } => {
                    for item in v {
                        let id = item.get("id").map_or_else(|| item.get("seq").map(Value::to_string).unwrap_or_default(), |i| i.as_str().map_or_else(|| i.to_string(), str::to_owned));
                        self.rows.insert((key.0.clone(), id), item);
                    }
                }
            }
        }
    }

    pub fn session(&self) -> Value {
        self.rows.get(&("session".to_owned(), self.task.clone())).map_or(Value::Null, merged)
    }

    /// Oldest first.
    pub fn turns(&self) -> Vec<Value> {
        let mut t: Vec<Value> = self.rows.iter().filter(|((e, _), _)| e == "turn").map(|(_, v)| merged(v)).collect();
        t.sort_by_key(|v| v.get("idx").and_then(Value::as_i64).unwrap_or(0));
        t
    }

    /// A turn's steps, in order: `(seq, step)`.
    pub fn events(&self, turn: &str) -> Vec<(i64, Value)> {
        let mut e: Vec<(i64, Value)> = self
            .rows
            .iter()
            .filter(|((e, _), v)| e == "event" && s(v, "turn_id") == turn)
            .map(|(_, v)| (v.get("seq").and_then(Value::as_i64).unwrap_or(0), v.get("body").filter(|b| b.is_object()).cloned().unwrap_or_else(|| v.clone())))
            .collect();
        e.sort_by_key(|x| x.0);
        e
    }

    pub fn running(&self) -> Option<Value> {
        self.turns().into_iter().rev().find(|t| !matches!(s(t, "status"), "done" | "error" | "stopped"))
    }

    pub fn ask(&self) -> Option<Ask> {
        let session = self.session();
        let ask = session.get("ext")?.get("wisp.runtime")?.get("ask")?;
        if ask.is_null() {
            return None;
        }
        let options = ask.get("options").and_then(Value::as_array).map(|o| o.iter().map(|x| x.as_str().map_or_else(|| s(x, "label").to_owned(), str::to_owned)).collect()).unwrap_or_default();
        Some(Ask { id: if s(ask, "id").is_empty() { s(ask, "question").to_owned() } else { s(ask, "id").to_owned() }, question: s(ask, "question").to_owned(), options })
    }

    /// Follow-ups waiting while a turn runs: `(item id, text)`.
    pub fn queue(&self) -> Vec<(String, String)> {
        self.session().get("queue").and_then(Value::as_array).into_iter().flatten().map(|q| (s(q, "id").to_owned(), s(q, "text").to_owned())).collect()
    }

    /// Toggles a tool row open or closed.
    pub fn toggle(&mut self, seq: i64) {
        if !self.expanded.remove(&seq) {
            self.expanded.insert(seq);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;
    use wisp_protocol::{PatchOp, Topic};

    use super::*;

    /// The list topic's rows as the server sends them: hot columns at the top, `cwd` in `body`, the list's own
    /// fields in `summary`. The sidebar reads all three, and a patch to the summary moves a task between sections.
    #[test]
    fn a_list_row_reads_its_body_and_summary() {
        let mut t = Tasks::default();
        let raw = json!({ "id": "s1", "title": "Fix", "state": "review", "updated_at": 5, "body": { "cwd": "/w/api", "state": "ignored" }, "summary": { "status": "blocked", "forLater": { "at": 9 } } });
        t.fold(Some(vec![Row { e: "session".into(), id: "s1".into(), v: raw }]), Vec::new());
        let row = &t.rows["s1"];
        assert_eq!((s(row, "cwd"), s(row, "status"), s(row, "state")), ("/w/api", "blocked", "review"), "the top wins over the body");
        assert_eq!(Section::of(row), Section::Later);
        let op = EntityOp { topic: Topic::parse("list").unwrap(), e: "session".into(), id: "s1".into(), change: Change::Patch { ops: vec![PatchOp::Replace { path: "/summary/forLater".into(), value: Value::Null }] } };
        assert_eq!(t.fold(None, vec![op]), vec!["s1".to_owned()]);
        assert_eq!(Section::of(&t.rows["s1"]), Section::Done, "unsaved: back with the rest");
        let del = EntityOp { topic: Topic::parse("list").unwrap(), e: "session".into(), id: "s1".into(), change: Change::Del };
        t.fold(None, vec![del]);
        assert!(t.rows.is_empty());
    }
}
