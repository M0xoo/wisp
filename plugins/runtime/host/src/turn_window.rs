//! A task topic's full snapshot, read as its window (v1 #788, `wisp_runtime_core::turn_window`): the task's
//! row, its queue, setup and watch, every turn (the older ones stubbed), and the events of only the turns
//! sent whole. Before, a first look read the topic from the change feed: every event the task ever had
//! (each append carries its rows), tens of MB for a long task. The stubbing happens before the event read,
//! so an older turn's events are never read from disk.
//!
//! Every kind on a task's topic is wisp.runtime's (`schema.rs`: `session`, `turn`, `event`, `queue_item`,
//! `task_setup`, `watch`, `watch_page`); a kind another plugin put on `session:<id>` would need adding here.
use serde_json::{Map, Value};
use wisp_runtime_core::turn_window::{View, stub_row, view_of, whole_from};
use wisp_store::{Query, Reader, Result, Row};

/// `(kind, id, value)`, as `wisp_api::v2_store::TopicReader` takes them.
pub type Rows = Vec<(String, String, Map<String, Value>)>;

/// Whether `topic` is a task topic this reads.
pub fn matches(topic: &str) -> bool {
    view_of(topic).is_some()
}

fn id_of(v: &Row) -> String {
    match v.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn push(out: &mut Rows, kind: &str, rows: Vec<Row>) {
    out.extend(rows.into_iter().map(|v| (kind.to_owned(), id_of(&v), v)));
}

fn by_session(r: &Reader<'_>, kind: &str, session: &str, order: &str) -> Result<Vec<Row>> {
    if !r.defines(kind) {
        return Ok(Vec::new());
    }
    r.query(kind, &Query::new().eq("session_id", session).asc(order))
}

/// The topic's rows. A topic that isn't a task's reads empty.
pub fn read(r: &Reader<'_>, topic: &str) -> Result<Rows> {
    let mut out = Rows::new();
    let Some(view) = view_of(topic) else { return Ok(out) };
    if !r.defines("turn") {
        return Ok(out); // runtime is off: its kinds aren't loaded
    }
    match view {
        View::Window { session } => window(r, session, true, &mut out)?,
        View::All { session } => window(r, session, false, &mut out)?,
        View::Turn { session, turn } => {
            let Some(row) = r.get("turn", turn)?.filter(|t| t.get("session_id").and_then(Value::as_str) == Some(session)) else {
                return Ok(out); // another task's turn, or a gone one
            };
            push(&mut out, "turn", vec![row]);
            push(&mut out, "event", r.query("event", &Query::new().eq("turn_id", turn).asc("seq"))?);
        }
        View::Turns { session } => push(&mut out, "turn", by_session(r, "turn", session, "idx")?),
    }
    Ok(out)
}

/// `stubbed`: older turns as stubs (the window); otherwise every turn whole (`/all`).
fn window(r: &Reader<'_>, session: &str, stubbed: bool, out: &mut Rows) -> Result<()> {
    if let Some(s) = r.get("session", session)? {
        push(out, "session", vec![s]);
    }
    let turns = by_session(r, "turn", session, "idx")?;
    let from = if stubbed { whole_from(turns.len()) } else { 0 };
    let whole: Vec<Value> = turns[from..].iter().filter_map(|t| t.get("id").cloned()).collect();
    for (i, t) in turns.into_iter().enumerate() {
        let t = if i < from { stub_row(&t) } else { t };
        push(out, "turn", vec![t]);
    }
    if !whole.is_empty() {
        push(out, "event", r.query("event", &Query::new().any_of("turn_id", whole).asc("seq"))?);
    }
    push(out, "queue_item", by_session(r, "queue_item", session, "pos")?);
    for kind in ["task_setup", "watch", "watch_page"] {
        if r.defines(kind)
            && let Some(row) = r.get(kind, session)?
        {
            push(out, kind, vec![row]);
        }
    }
    Ok(())
}
