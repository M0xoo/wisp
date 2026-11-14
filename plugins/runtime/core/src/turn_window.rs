//! A task's topic as a window (v1 #788): opening a long task sends its latest [`WHOLE_TURNS`] turns whole
//! (their rows and their events) and every older turn as a stub that keeps what its folded row and the
//! usage card read. A task of 250 turns sent every event of every turn, on each first look.
//!
//! - `session:<id>`: the window (the task page, the CLI's attach, the TUI).
//! - `session:<id>/turn/<turn id>`: that one turn whole, with its events (an older turn opened by hand).
//! - `session:<id>/turns`: every turn row whole, no events (the Changes pane lists every edit).
//! - `session:<id>/all`: every turn whole with every event (the TUI, which draws every turn's steps), read from
//!   the tables, not the change feed.
//!
//! Subagents run on their own topics (`session:<child>`), so a lead's window never carries their runs:
//! a card reads the child's list row, and opening the run subscribes to it.
//!
//! Pure: rows in, rows out. The host reads only what the window sends (the events of whole turns).

use serde_json::{Map, Value};

use crate::env_session::HIDE;

/// The latest turns a window sends whole (v1 `VISIBLE_TURNS`).
pub const WHOLE_TURNS: usize = 8;

/// What a task topic asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View<'a> {
    Window { session: &'a str },
    Turn { session: &'a str, turn: &'a str },
    Turns { session: &'a str },
    All { session: &'a str },
}

impl<'a> View<'a> {
    pub fn session(&self) -> &'a str {
        match *self {
            View::Window { session } | View::Turn { session, .. } | View::Turns { session } | View::All { session } => session,
        }
    }
}

/// The view a topic names, or `None` when it isn't a task topic.
pub fn view_of(topic: &str) -> Option<View<'_>> {
    let rest = topic.strip_prefix("session:").filter(|r| !r.is_empty())?;
    if let Some((session, turn)) = rest.rsplit_once("/turn/") {
        return (!session.is_empty() && !turn.is_empty() && !turn.contains('/')).then_some(View::Turn { session, turn });
    }
    if let Some(session) = rest.strip_suffix("/turns") {
        return (!session.is_empty()).then_some(View::Turns { session });
    }
    if let Some(session) = rest.strip_suffix("/all") {
        return (!session.is_empty()).then_some(View::All { session });
    }
    Some(View::Window { session: rest })
}

/// The topic of one turn whole.
pub fn turn_topic(session: &str, turn: &str) -> String {
    format!("session:{session}/turn/{turn}")
}

/// The topic of every turn row whole.
pub fn turns_topic(session: &str) -> String {
    format!("session:{session}/turns")
}

/// Every turn whole with every event.
pub fn all_topic(session: &str) -> String {
    format!("session:{session}/all")
}

/// Of `n` turns (oldest first), the index of the first one sent whole.
pub fn whole_from(n: usize) -> usize {
    n.saturating_sub(WHOLE_TURNS)
}

/// What a stub's body keeps: its folded row (prompt, who, when, status, mode, harness and model), Fork and
/// the checkpoint (in `ext`), and what the usage card sums (`stats`).
const KEEP: &[&str] = &[
    "id",
    "sessionId",
    "idx",
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
    "isError",
    "changedFiles",
    "refusal",
    "limit",
    "nEvents",
];

/// A turn row (`{id, session_id, idx, status, started_at, ended_at, prompt, answer, body}`) as a stub: the
/// answer's text goes, the body keeps [`KEEP`], its hero's title and summary, a Compact now turn's markdown
/// (its folded row says what it did), and every plugin's `ext` but runtime's edits (`ext["wisp.runtime"].changes`,
/// most of a turn's bytes). `body.stub` says it is one.
pub fn stub_row(row: &Map<String, Value>) -> Map<String, Value> {
    let mut out: Map<String, Value> =
        row.iter().filter(|(k, _)| k.as_str() != "body" && k.as_str() != "answer").map(|(k, v)| (k.clone(), v.clone())).collect();
    out.insert("body".into(), Value::Object(stub_body(row.get("body").and_then(Value::as_object))));
    out
}

fn stub_body(body: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("stub".into(), Value::Bool(true));
    let Some(b) = body else { return out };
    for k in KEEP {
        if let Some(v) = b.get(*k) {
            out.insert((*k).into(), v.clone());
        }
    }
    if let Some(ext) = b.get("ext").and_then(Value::as_object) {
        out.insert("ext".into(), Value::Object(light_ext(ext)));
    }
    let blocks = b.get("presentation").and_then(|p| p.get("blocks")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut kept = Vec::new();
    // where each kept block was: its .env ranges (ADR-0050) follow it to its place in the stub
    let mut moved: Vec<(usize, usize, &[&str])> = Vec::new();
    if let Some((i, hero)) = blocks.iter().enumerate().find(|(_, x)| x.get("type").and_then(Value::as_str) == Some("hero")) {
        moved.push((i, kept.len(), &["title", "summary"]));
        let mut h = Map::new();
        h.insert("type".into(), "hero".into());
        for k in ["title", "summary", "status"] {
            if let Some(v) = hero.get(k) {
                h.insert(k.into(), v.clone());
            }
        }
        kept.push(Value::Object(h));
    }
    let compact = b.get("by").and_then(Value::as_str) == Some("compact");
    if let Some((i, said)) = blocks.iter().enumerate().find(|(_, x)| compact && x.get("type").and_then(Value::as_str) == Some("markdown")) {
        moved.push((i, kept.len(), &["text"]));
        kept.push(serde_json::json!({ "type": "markdown", "text": said.get("text").cloned().unwrap_or(Value::Null) }));
    }
    if !kept.is_empty() {
        out.insert("presentation".into(), serde_json::json!({ "blocks": kept }));
    }
    if let Some(h) = b.get(HIDE) {
        out.insert(HIDE.into(), stub_hide(h, &moved));
    }
    out
}

/// A turn's kept ranges for its stub: each kept block's at its new index, the refusal's line, what they say of
/// themselves (`#lines`, `#known`, `#clean`: the stub is a part of the turn); the answer's text and the rest go
/// with what they were about. Unreadable ranges stay so (all of its prose hidden).
fn stub_hide(h: &Value, moved: &[(usize, usize, &[&str])]) -> Value {
    let Some(m) = h.as_object() else { return h.clone() };
    let mut out = Map::new();
    for (k, v) in m {
        let to = if k.starts_with('#') || k == "/refusal/line" {
            Some(k.clone())
        } else {
            moved.iter().find_map(|(from, at, keys)| {
                let rest = k.strip_prefix(&format!("/presentation/blocks/{from}/"))?;
                keys.contains(&rest).then(|| format!("/presentation/blocks/{at}/{rest}"))
            })
        };
        if let Some(to) = to {
            out.insert(to, v.clone());
        }
    }
    Value::Object(out)
}

fn light_ext(ext: &Map<String, Value>) -> Map<String, Value> {
    let mut out = ext.clone();
    if let Some(Value::Object(rt)) = out.get_mut("wisp.runtime") {
        rt.remove("changes");
    }
    out
}

/// Whether a turn row is a stub (`body.stub`).
pub fn is_stub(row: &Map<String, Value>) -> bool {
    row.get("body").and_then(|b| b.get("stub")).and_then(Value::as_bool) == Some(true)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::needless_pass_by_value)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn a_task_topic_names_its_window_one_turn_or_every_turn() {
        assert_eq!(view_of("session:s1"), Some(View::Window { session: "s1" }));
        assert_eq!(view_of("session:s1/turn/t9"), Some(View::Turn { session: "s1", turn: "t9" }));
        assert_eq!(view_of("session:s1/turns"), Some(View::Turns { session: "s1" }));
        assert_eq!(view_of(&turn_topic("a", "b")), Some(View::Turn { session: "a", turn: "b" }));
        assert_eq!(view_of(&turns_topic("a")), Some(View::Turns { session: "a" }));
        assert_eq!(view_of(&all_topic("a")), Some(View::All { session: "a" }));
        assert_eq!(view_of("list"), None);
        assert_eq!(view_of("session:"), None);
        // malformed turn topics are a window on an odd id, never a turn of an empty session
        assert!(!matches!(view_of("session:/turn/t"), Some(View::Turn { .. })));
        assert!(!matches!(view_of("session:s/turn/"), Some(View::Turn { .. })));
    }

    #[test]
    fn the_latest_eight_turns_go_whole_a_short_task_goes_whole() {
        assert_eq!(whole_from(3), 0);
        assert_eq!(whole_from(8), 0);
        assert_eq!(whole_from(257), 249);
    }

    #[test]
    fn a_stub_keeps_what_the_usage_card_sums_and_fork_reads_not_the_edits() {
        let r = row(json!({
            "id": "t1", "session_id": "s", "idx": 0, "status": "done", "started_at": 1, "ended_at": 2, "prompt": "p", "answer": "long answer",
            "body": { "id": "t1", "prompt": "p", "status": "done", "stats": { "inputTokens": 5, "costUsd": 0.1 }, "text": "long answer",
              "ext": { "wisp.git": { "checkpoint": { "to": "abc", "head": "def" } }, "wisp.telemetry": { "feedback": { "rating": "up" } },
                       "wisp.runtime": { "changes": [{ "file": "a.ts", "edits": ["x".repeat(1000)] }], "group": "g" } },
              "presentation": { "blocks": [{ "type": "hero", "title": "Did it", "summary": "s" }, { "type": "markdown", "text": "much" }] } }
        }));
        let s = stub_row(&r);
        assert!(is_stub(&s));
        assert!(!is_stub(&r));
        assert_eq!(s.get("answer"), None);
        assert_eq!(s["prompt"], "p");
        let b = &s["body"];
        assert_eq!(b["stats"], json!({ "inputTokens": 5, "costUsd": 0.1 }));
        assert_eq!(b["ext"]["wisp.git"]["checkpoint"]["to"], "abc");
        assert_eq!(b["ext"]["wisp.telemetry"]["feedback"]["rating"], "up");
        assert_eq!(b["ext"]["wisp.runtime"], json!({ "group": "g" }));
        assert_eq!(b.get("text"), None);
        assert_eq!(b["presentation"], json!({ "blocks": [{ "type": "hero", "title": "Did it", "summary": "s" }] }));
    }

    #[test]
    fn a_compact_now_stub_keeps_what_it_did() {
        let r = row(
            json!({ "id": "t", "body": { "by": "compact", "presentation": { "blocks": [{ "type": "markdown", "text": "Compacted 80k to 12k" }, { "type": "code", "code": "x" }] } } }),
        );
        assert_eq!(stub_row(&r)["body"]["presentation"], json!({ "blocks": [{ "type": "markdown", "text": "Compacted 80k to 12k" }] }));
    }

    #[test]
    fn a_stubs_env_ranges_follow_its_kept_blocks_so_it_masks_after_a_restart() {
        let blocks = json!([{ "type": "code", "code": "x" }, { "type": "hero", "title": "Key sk-live-one", "summary": "ok" }]);
        let mut body =
            json!({ "id": "t1", "presentation": { "blocks": blocks }, "text": "sk-live-one", "refusal": { "line": "sk-live-one" } });
        body[HIDE] = crate::env_turn::hide_of(&body, Some(&["sk-live-one".to_owned()]));
        let r = row(json!({ "id": "t1", "session_id": "s", "answer": "sk-live-one", "body": body }));
        let mut s = Value::Object(stub_row(&r));
        let h = &s["body"][HIDE];
        assert!(h.get("/presentation/blocks/0/title").is_some() && h.get("/presentation/blocks/1/title").is_none(), "renumbered: {h}");
        assert!(h.get("/text").is_none(), "the text it was about isn't in the stub");
        assert!(h.get("#lines").is_some() && h.get("#known").is_some(), "{h}");
        crate::env_turn::mask_row(&mut s, None);
        assert!(!s.to_string().contains("sk-live"), "{s}");
        assert_eq!(s["body"]["presentation"]["blocks"][0]["title"], "Key ••••", "masked, not hidden whole");
        assert_eq!(s["body"]["presentation"]["blocks"][0]["summary"], "ok");
        let mut u = r.clone();
        u["body"][HIDE] = json!("unread");
        assert_eq!(stub_row(&u)["body"][HIDE], "unread", "unreadable stays so");
    }

    #[test]
    fn a_turn_row_without_a_body_stubs_to_an_empty_one() {
        let s = stub_row(&row(json!({ "id": "t" })));
        assert_eq!(s["body"], json!({ "stub": true }));
    }
}
