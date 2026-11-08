//! Rows ↔ the api's types. A session's indexed fields are columns; the rest of it is `body` (JSON), and
//! its list row is kept in `summary`, written with the row so a list read decodes one small column. The
//! queue lives in its own table and is filled in by the repo.

use serde_json::{Map, Value, json};
use wisp_runtime_api::model::{Activity, QueueItem, Session, Step, Summary, Turn};
use wisp_runtime_core::upcast;
use wisp_store::Row;

use crate::error::Result;

const SESSION_COLS: &[(&str, &str)] = &[
    ("id", "id"),
    ("parent_id", "parentId"),
    ("title", "title"),
    ("state", "state"),
    ("agent", "agent"),
    ("archived", "archived"),
    ("unread", "unread"),
    ("created_at", "createdAt"),
    ("updated_at", "updatedAt"),
    ("rev", "rev"),
];

fn object(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn session_row(s: &Session, summary: &Summary) -> Result<Row> {
    let mut body = object(serde_json::to_value(s)?);
    body.remove("queue");
    let mut row = Map::new();
    for (col, key) in SESSION_COLS {
        row.insert((*col).to_owned(), body.remove(*key).unwrap_or(Value::Null));
    }
    row.insert("body".into(), Value::Object(body));
    row.insert("summary".into(), serde_json::to_value(summary)?);
    Ok(row)
}

pub fn session_of(row: Row, queue: Vec<QueueItem>) -> Result<Session> {
    let mut row = row;
    let mut body = object(row.remove("body").unwrap_or(Value::Null));
    for (col, key) in SESSION_COLS {
        if let Some(v) = row.remove(*col).filter(|v| !v.is_null()) {
            body.insert((*key).to_owned(), v);
        }
    }
    body.insert("queue".into(), serde_json::to_value(queue)?);
    Ok(serde_json::from_value(Value::Object(body))?)
}

pub fn summary_of(row: &Row) -> Option<Summary> {
    row.get("summary").and_then(|v| serde_json::from_value(v.clone()).ok())
}

pub fn turn_row(t: &Turn) -> Result<Row> {
    let mut row = Map::new();
    row.insert("id".into(), json!(t.id));
    row.insert("session_id".into(), json!(t.session_id));
    row.insert("idx".into(), json!(t.idx));
    row.insert("status".into(), serde_json::to_value(t.status)?);
    row.insert("started_at".into(), json!(t.started_at));
    row.insert("ended_at".into(), json!(t.ended_at));
    row.insert("prompt".into(), json!(t.prompt));
    row.insert("answer".into(), json!(t.text));
    row.insert("body".into(), serde_json::to_value(t)?);
    Ok(row)
}

pub fn turn_of(row: &Row) -> Result<Turn> {
    Ok(serde_json::from_value(row.get("body").cloned().unwrap_or(Value::Null))?)
}

pub fn queue_row(session: &str, pos: usize, q: &QueueItem) -> Result<Row> {
    let mut row = Map::new();
    row.insert("id".into(), json!(q.id));
    row.insert("session_id".into(), json!(session));
    row.insert("pos".into(), json!(pos));
    row.insert("body".into(), serde_json::to_value(q)?);
    Ok(row)
}

pub fn queue_of(row: &Row) -> Option<QueueItem> {
    row.get("body").and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// One step as an event-log row (shape `upcast::EVENT_V`).
pub fn event_row(session: &str, turn: &str, seq: u64, t: i64, a: &Activity) -> Result<Row> {
    let mut row = Map::new();
    row.insert("session_id".into(), json!(session));
    row.insert("seq".into(), json!(seq));
    row.insert("turn_id".into(), json!(turn));
    row.insert("t".into(), json!(t));
    row.insert("kind".into(), json!(a.kind()));
    row.insert("body".into(), serde_json::to_value(a)?);
    row.insert("v".into(), json!(upcast::EVENT_V));
    Ok(row)
}

/// A v1 activity item as it was (`v = 0`), for the importer: history is never rewritten.
pub fn v0_event_row(session: &str, turn: &str, seq: u64, t: i64, item: &Value) -> Row {
    let mut row = Map::new();
    row.insert("session_id".into(), json!(session));
    row.insert("seq".into(), json!(seq));
    row.insert("turn_id".into(), json!(turn));
    row.insert("t".into(), json!(t));
    row.insert("kind".into(), item.get("kind").cloned().unwrap_or_else(|| json!("text")));
    row.insert("body".into(), item.clone());
    row.insert("v".into(), json!(0));
    row
}

/// An event row as a step, through the upcasters.
pub fn step_of(row: &Row) -> Option<Step> {
    let v = row.get("v").and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
    let activity = upcast::read(v, row.get("body")?)?;
    Some(Step { seq: row.get("seq").and_then(Value::as_u64)?, t: row.get("t").and_then(Value::as_i64).unwrap_or(0), activity })
}
