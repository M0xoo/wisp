//! A task topic's full snapshot, read as its window (v1 #788, `wisp_runtime_core::turn_window`): the task's
//! row, its queue, setup and watch, every turn (the older ones stubbed), and the events of only the turns
//! sent whole. Before, a first look read the topic from the change feed: every event the task ever had
//! (each append carries its rows), tens of MB for a long task. The stubbing happens before the event read,
//! so an older turn's events are never read from disk.
//!
//! A change to a turn the window sends as a stub is sent as that stub ([`live`], [`delta`]): a client holding
//! the stub would fail the turn's diff (its paths are gone from the stub) and re-download the whole window.
//!
//! Every kind on a task's topic is wisp.runtime's (`schema.rs`: `session`, `turn`, `event`, `queue_item`,
//! `task_setup`, `watch`, `watch_page`); a kind another plugin put on `session:<id>` would need adding here.
use serde_json::{Map, Value};
use wisp_runtime_core::turn_window::{View, WHOLE_TURNS, all_topic, stub_row, turn_topic, turns_topic, view_of, whole_from};
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

/// The kinds whose committed changes [`live`] may send another way.
pub const LIVE_KINDS: &[&str] = &["turn"];

/// The kinds [`read`] answers for on a task's topic.
pub const READ_KINDS: &[&str] = &["session", "turn", "event"];

/// The idx a task's turn needs to be sent whole on its window: the [`WHOLE_TURNS`]-th latest's (`None`: every
/// turn goes whole). Reads one indexed row.
fn whole_idx(r: &Reader<'_>, session: &str) -> Result<Option<i64>> {
    let q = Query::new().select(&["idx"]).eq("session_id", session).desc("idx").offset(WHOLE_TURNS as u64 - 1).limit(1);
    Ok(r.query("turn", &q)?.first().and_then(|t| t.get("idx")).and_then(Value::as_i64))
}

fn stubbed(idx: Option<i64>, whole: Option<i64>) -> bool {
    matches!((idx, whole), (Some(i), Some(w)) if i < w)
}

/// A committed upsert or patch of `entity` `id` on `topic`, as the topic sends it: `Ok(None)` sends it as
/// committed. A turn the window sends as a stub goes as its stub row (an upsert) on the window, then whole on
/// `/all`, `/turns` and `/turn/<id>`, which sort after the window in a flush: a client that opened the turn
/// (or holds every turn) ends the frame with it whole, one that holds the stub with the stub, and neither
/// gets a diff its copy can't take. The running turn (always whole) costs two indexed reads of two columns.
pub fn live(r: &Reader<'_>, topic: &str, entity: &str, id: &str) -> Result<Option<Rows>> {
    let Some(View::Window { session }) = view_of(topic) else { return Ok(None) };
    if entity != "turn" || !r.defines("turn") {
        return Ok(None);
    }
    let Some(whole) = whole_idx(r, session)? else { return Ok(None) }; // a short task: every turn whole
    let at = r.query("turn", &Query::new().select(&["idx", "session_id"]).eq("id", id).limit(1))?;
    let Some(t) = at.first().filter(|t| t.get("session_id").and_then(Value::as_str) == Some(session)) else { return Ok(None) };
    if !stubbed(t.get("idx").and_then(Value::as_i64), Some(whole)) {
        return Ok(None);
    }
    let Some(row) = r.get("turn", id)? else { return Ok(None) };
    let stub = stub_row(&row);
    let mut out = vec![(topic.to_owned(), id.to_owned(), stub)];
    for t in [all_topic(session), turn_topic(session, id), turns_topic(session)] {
        out.push((t, id.to_owned(), row.clone()));
    }
    Ok(Some(out))
}

/// A resume of `topic` (the rows changed since the client's cursor, as they are now): on a window, the turns
/// it sends as stubs go as stubs, so a resumed client never holds an older turn whole without its events.
pub fn delta(r: &Reader<'_>, topic: &str, rows: &mut [(String, Map<String, Value>)]) -> Result<()> {
    let Some(View::Window { session }) = view_of(topic) else { return Ok(()) };
    if !r.defines("turn") || !rows.iter().any(|(e, _)| e == "turn") {
        return Ok(());
    }
    let whole = whole_idx(r, session)?;
    for (e, v) in rows.iter_mut() {
        if e == "turn" && stubbed(v.get("idx").and_then(Value::as_i64), whole) {
            *v = stub_row(v);
        }
    }
    Ok(())
}
