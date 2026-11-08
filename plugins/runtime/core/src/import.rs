//! v1's session files (`~/.wisp/sessions/<id>.json`) as v2 rows, and back (plan §4.8: during the release
//! that brings the database, writes go to both stores, so going back one version loses nothing). Pure:
//! the host reads and writes the files.
//!
//! Fields runtime owns map 1:1. Everything else v1 kept on a task or a turn (goal, worktree, crew, auto,
//! delegations, checkpoint, …) is kept as it was under `ext["v1"]`, for its owner's own import to read,
//! and written back unchanged. Activity keeps v1's item shape in the log with `v = 0` (read through
//! `upcast`), so history is never rewritten.

use serde_json::{Map, Value, json};
use wisp_runtime_api::model::{
    Attachment, ChangeOp, Edit, FileChange, Held, Mode, Presentation, QueueItem, Session,
    SessionState, Turn, TurnStats, TurnStatus,
};
use wisp_runtime_api::{SessionId, TurnId};

/// The slot v1's other fields wait in.
pub const V1_EXT: &str = "v1";

const SESSION_OWN: &[&str] = &[
    "id",
    "title",
    "agent",
    "model",
    "effort",
    "account",
    "mode",
    "cwd",
    "state",
    "unread",
    "archived",
    "parentId",
    "createdAt",
    "updatedAt",
    "queue",
    "queueHeld",
    "tags",
    "agentSessionId",
    "turns",
];
const TURN_OWN: &[&str] = &[
    "id",
    "prompt",
    "agent",
    "model",
    "effort",
    "account",
    "mode",
    "attachments",
    "by",
    "status",
    "startedAt",
    "endedAt",
    "held",
    "stats",
    "presentation",
    "raw",
    "activity",
    "changes",
];

/// One turn as rows: the turn, its log (v1 items, `v = 0`, with their time), its captured edits.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedTurn {
    pub turn: Turn,
    pub steps: Vec<(i64, Value)>,
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub session: Session,
    pub turns: Vec<ImportedTurn>,
}

fn s(o: &Map<String, Value>, k: &str) -> String {
    o.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn opt(o: &Map<String, Value>, k: &str) -> Option<String> {
    o.get(k)
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .map(str::to_owned)
}
/// A ms timestamp; v1 sometimes wrote one as a float.
fn int(o: &Map<String, Value>, k: &str) -> Option<i64> {
    let v = o.get(k)?;
    v.as_i64().or_else(|| {
        let f = v.as_f64().filter(|f| f.is_finite() && f.abs() < 9.0e15)?;
        #[allow(clippy::cast_possible_truncation)] // range checked above
        Some(f.round() as i64)
    })
}
fn flag(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(false)
}
fn parse<T: serde::de::DeserializeOwned + Default>(v: Option<&Value>) -> T {
    v.and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn leftovers(o: &Map<String, Value>, own: &[&str]) -> Map<String, Value> {
    o.iter()
        .filter(|(k, _)| !own.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn mode(o: &Map<String, Value>) -> Mode {
    parse::<Option<Mode>>(o.get("mode")).unwrap_or_default()
}

/// v1's `running` and `waiting` (a lead held in Working on its delegates) can't be true after a restart:
/// nothing runs, so they land in Needs you.
fn state(v: &str) -> SessionState {
    match v {
        "done" => SessionState::Done,
        "error" => SessionState::Error,
        _ => SessionState::Review,
    }
}

fn status(v: &str) -> TurnStatus {
    match v {
        "done" => TurnStatus::Done,
        "error" => TurnStatus::Error,
        "held" => TurnStatus::Held,
        // a turn running when v1 stopped never finished: it shows stopped, as v1's restart did
        _ => TurnStatus::Stopped,
    }
}

fn held(v: Option<&Value>) -> Option<Held> {
    let h = v?.as_object()?;
    let (by, kind) = if h.contains_key("project") {
        ("wisp.trust", "project")
    } else if h.contains_key("harness") {
        ("wisp.harness-watch", "harness")
    } else {
        ("wisp.guard", "limit")
    };
    Some(Held {
        by: by.into(),
        kind: kind.into(),
        until: int(h, "until"),
        data: Value::Object(h.clone()),
    })
}

fn stats(v: Option<&Value>) -> Option<TurnStats> {
    let o = v?.as_object()?;
    let num = |k: &str| o.get(k).and_then(Value::as_u64);
    let cache = match (num("cacheReadTokens"), num("cacheWriteTokens")) {
        (None, None) => None,
        (read, write) => Some(read.unwrap_or(0) + write.unwrap_or(0)),
    };
    let models = o
        .get("models")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    Some(TurnStats {
        cost_usd: o.get("costUsd").and_then(Value::as_f64),
        input_tokens: num("inputTokens"),
        output_tokens: num("outputTokens"),
        cache_tokens: cache,
        ms: num("durationMs"),
        models,
    })
}

fn change_op(v: &str) -> ChangeOp {
    match v {
        "create" | "add" => ChangeOp::Add,
        "delete" => ChangeOp::Delete,
        "rename" => ChangeOp::Rename,
        _ => ChangeOp::Modify,
    }
}

fn changes(v: Option<&Value>) -> Vec<FileChange> {
    let list = v.and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    list.iter()
        .filter_map(Value::as_object)
        .map(|c| FileChange {
            file: s(c, "file"),
            op: change_op(&s(c, "op")),
            edits: parse::<Vec<Edit>>(c.get("edits")),
        })
        .collect()
}

/// A stored v1 presentation keeps `v = 0`: the current parser rebuilds it from the turn's text lazily.
fn presentation(v: Option<&Value>) -> Option<Presentation> {
    let o = v?.as_object()?;
    let blocks = o
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(Presentation {
        blocks,
        v: 0,
        dropped: Vec::new(),
        topic: opt(o, "topic"),
        notes: opt(o, "notes"),
        fallback: flag(o, "fallback"),
    })
}

fn turn(sid: &SessionId, idx: u32, o: &Map<String, Value>) -> ImportedTurn {
    let steps = o
        .get("activity")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |a| {
            a.iter()
                .map(|x| (x.get("t").and_then(Value::as_i64).unwrap_or(0), x.clone()))
                .collect()
        });
    let changes = changes(o.get("changes"));
    let st = status(&s(o, "status"));
    let started = int(o, "startedAt").unwrap_or(0);
    let mut ext = Map::new();
    let rest = leftovers(o, TURN_OWN);
    if !rest.is_empty() {
        ext.insert(V1_EXT.into(), Value::Object(rest));
    }
    let turn = Turn {
        id: TurnId(s(o, "id")),
        session_id: sid.clone(),
        idx,
        prompt: s(o, "prompt"),
        agent: s(o, "agent"),
        model: s(o, "model"),
        effort: s(o, "effort"),
        account: opt(o, "account"),
        mode: mode(o),
        attachments: parse::<Vec<Attachment>>(o.get("attachments")),
        by: opt(o, "by"),
        status: st,
        started_at: started,
        ended_at: int(o, "endedAt"),
        held: held(o.get("held")),
        stats: stats(o.get("stats")),
        presentation: presentation(o.get("presentation")),
        resume_id: None,
        text: opt(o, "raw"),
        is_error: st == TurnStatus::Error,
        changed_files: u32::try_from(changes.len()).ok().filter(|n| *n > 0),
        n_events: u32::try_from(steps.len()).unwrap_or(u32::MAX),
        ext: ext.into_iter().collect(),
    };
    ImportedTurn {
        turn,
        steps,
        changes,
    }
}

fn queue(v: Option<&Value>) -> Vec<QueueItem> {
    let list = v.and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    list.iter()
        .filter_map(Value::as_object)
        .map(|q| {
            let rest = leftovers(
                q,
                &["id", "text", "attachments", "at", "by", "now", "reports"],
            );
            QueueItem {
                id: s(q, "id"),
                text: s(q, "text"),
                attachments: parse(q.get("attachments")),
                at: int(q, "at").unwrap_or(0),
                by: opt(q, "by"),
                opts: (!rest.is_empty()).then_some(Value::Object(rest)),
                now: flag(q, "now"),
                reports: flag(q, "reports"),
            }
        })
        .collect()
}

/// A v1 session file's JSON as rows. Err: not a v1 session.
pub fn from_v1(v: &Value) -> Result<Imported, String> {
    let o = v.as_object().ok_or("not an object")?;
    let sid = SessionId(opt(o, "id").ok_or("no id")?);
    let list = o
        .get("turns")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let turns: Vec<ImportedTurn> = list
        .iter()
        .filter_map(Value::as_object)
        .enumerate()
        .map(|(i, t)| turn(&sid, u32::try_from(i).unwrap_or(u32::MAX), t))
        .collect();
    let mut ext = Map::new();
    let rest = leftovers(o, SESSION_OWN);
    if !rest.is_empty() {
        ext.insert(V1_EXT.into(), Value::Object(rest));
    }
    let dirs = o
        .get("also")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |a| {
            a.iter()
                .filter_map(|x| x.get("cwd").and_then(Value::as_str).map(str::to_owned))
                .collect()
        });
    let session = Session {
        id: sid,
        title: s(o, "title"),
        agent: s(o, "agent"),
        model: s(o, "model"),
        effort: s(o, "effort"),
        account: opt(o, "account"),
        mode: mode(o),
        cwd: s(o, "cwd"),
        dirs,
        state: state(&s(o, "state")),
        unread: flag(o, "unread"),
        archived: flag(o, "archived"),
        parent_id: opt(o, "parentId").map(SessionId),
        created_at: int(o, "createdAt").unwrap_or(0),
        updated_at: int(o, "updatedAt").unwrap_or(0),
        queue: queue(o.get("queue")),
        queue_held: flag(o, "queueHeld"),
        tags: parse(o.get("tags")),
        resume_id: opt(o, "agentSessionId"),
        rev: 0,
        ext: ext.into_iter().collect(),
    };
    Ok(Imported { session, turns })
}

fn put(o: &mut Map<String, Value>, k: &str, v: impl serde::Serialize) {
    if let Ok(v) = serde_json::to_value(v)
        && !v.is_null()
    {
        o.insert(k.to_owned(), v);
    }
}

fn presentation_v1(p: &Presentation) -> Value {
    let mut v = json!({ "blocks": p.blocks });
    if p.fallback {
        v["fallback"] = json!(true);
    }
    if let Some(t) = &p.topic {
        v["topic"] = json!(t);
    }
    if let Some(n) = &p.notes {
        v["notes"] = json!(n);
    }
    v
}

fn op_v1(op: ChangeOp) -> &'static str {
    match op {
        ChangeOp::Add => "create",
        ChangeOp::Delete => "delete",
        ChangeOp::Rename => "rename",
        ChangeOp::Modify => "edit",
    }
}

fn turn_to_v1(t: &ImportedTurn) -> Value {
    let x = &t.turn;
    let mut o = x
        .ext
        .get(V1_EXT)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (k, v) in [
        ("id", json!(x.id)),
        ("prompt", json!(x.prompt)),
        ("agent", json!(x.agent)),
        ("model", json!(x.model)),
        ("effort", json!(x.effort)),
        ("mode", json!(x.mode)),
        ("status", json!(x.status)),
    ] {
        o.insert(k.into(), v);
    }
    put(&mut o, "account", &x.account);
    put(&mut o, "by", &x.by);
    o.insert("attachments".into(), json!(x.attachments));
    o.insert("startedAt".into(), json!(x.started_at));
    o.insert("endedAt".into(), json!(x.ended_at));
    if let Some(h) = &x.held {
        o.insert("held".into(), h.data.clone());
    }
    let stats = x.stats.as_ref().map_or(Value::Null, |s| json!({ "costUsd": s.cost_usd, "inputTokens": s.input_tokens, "outputTokens": s.output_tokens, "durationMs": s.ms, "models": s.models }));
    o.insert("stats".into(), stats);
    o.insert(
        "presentation".into(),
        x.presentation.as_ref().map_or(Value::Null, presentation_v1),
    );
    put(&mut o, "raw", &x.text);
    o.insert(
        "activity".into(),
        Value::Array(t.steps.iter().map(|(_, b)| b.clone()).collect()),
    );
    let ch: Vec<Value> = t
        .changes
        .iter()
        .map(|c| json!({ "file": c.file, "op": op_v1(c.op), "edits": c.edits }))
        .collect();
    o.insert("changes".into(), Value::Array(ch));
    Value::Object(o)
}

fn queue_v1(q: &QueueItem) -> Value {
    let mut x = q
        .opts
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    x.insert("id".into(), json!(q.id));
    x.insert("text".into(), json!(q.text));
    x.insert("attachments".into(), json!(q.attachments));
    put(&mut x, "by", &q.by);
    if q.now {
        x.insert("now".into(), json!(true));
    }
    if q.reports {
        x.insert("reports".into(), json!(true));
    }
    Value::Object(x)
}

/// The rows as a v1 session file (dual-write). `steps` are v1 items (`upcast::to_v0` for new rows).
pub fn to_v1(i: &Imported) -> Value {
    let s = &i.session;
    let mut o = s
        .ext
        .get(V1_EXT)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (k, v) in [
        ("id", json!(s.id)),
        ("title", json!(s.title)),
        ("agent", json!(s.agent)),
        ("model", json!(s.model)),
        ("effort", json!(s.effort)),
        ("mode", json!(s.mode)),
        ("cwd", json!(s.cwd)),
        ("state", json!(s.state)),
        ("unread", json!(s.unread)),
        ("createdAt", json!(s.created_at)),
        ("updatedAt", json!(s.updated_at)),
    ] {
        o.insert(k.into(), v);
    }
    put(&mut o, "account", &s.account);
    put(&mut o, "parentId", &s.parent_id);
    put(&mut o, "agentSessionId", &s.resume_id);
    if s.archived {
        o.insert("archived".into(), json!(true));
    }
    if s.queue_held {
        o.insert("queueHeld".into(), json!(true));
    }
    if !s.tags.is_empty() {
        o.insert("tags".into(), json!(s.tags));
    }
    o.insert(
        "queue".into(),
        Value::Array(s.queue.iter().map(queue_v1).collect()),
    );
    o.insert(
        "turns".into(),
        Value::Array(i.turns.iter().map(turn_to_v1).collect()),
    );
    Value::Object(o)
}
