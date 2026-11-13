//! The list row (v1 runner.js `summarize`), runtime's own fields only: every other plugin adds its
//! fields through `runtime.summary@1` from its ext slot. Computed once per write of the row, never per
//! list read or per event (the host caches it by the session's `rev`), and reads only the last turn and
//! the last answered one, so it costs the same on a 5,000-turn task as on a new one.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use wisp_runtime_api::model::{Session, Summary, Turn, TurnStatus};

/// What the row needs besides the session and its last turns.
#[derive(Debug, Clone, Default)]
pub struct RowFacts<'a> {
    /// the last turn
    pub last: Option<&'a Turn>,
    /// the last turn that reports something of its own (a compaction doesn't): what the row says
    pub report: Option<&'a Turn>,
    pub turn_count: u32,
    /// follow-ups you sent (not wisp's repair rounds or a compaction)
    pub followups: u32,
    /// the running turn's last step that isn't text
    pub live_step: Option<&'a str>,
    /// a question the agent waits on: its text, its options (none for a clash, which is read before it is
    /// answered), and whether it is a live approval
    pub ask: Option<(&'a str, &'a [String], bool)>,
    /// delegates a lead waits on, by name
    pub waiting_on: &'a [String],
    /// an after-turn step's live line (Auto's check, "Checking the goal")
    pub after_busy: Option<&'a str>,
}

fn hero(t: Option<&Turn>) -> Option<&Value> {
    t?.presentation.as_ref()?.blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("hero"))
}

fn status(f: &RowFacts<'_>, waiting: &str) -> String {
    let last = f.last.map(|t| t.status);
    if last == Some(TurnStatus::Running) || !waiting.is_empty() || f.after_busy.is_some() {
        return "running".into();
    }
    if last == Some(TurnStatus::Held) {
        return "held".into();
    }
    if let Some(s) = hero(f.report).and_then(|h| h.get("status")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return s.to_owned();
    }
    if last == Some(TurnStatus::Error) { "blocked".into() } else { "info".into() }
}

fn live(f: &RowFacts<'_>, waiting: &str) -> String {
    if let Some((q, _, _)) = f.ask {
        return format!("Asks: {q}");
    }
    if let Some(t) = f.last.filter(|t| t.status == TurnStatus::Running) {
        if !waiting.is_empty() {
            return waiting.to_owned();
        }
        if let Some(step) = f.live_step.filter(|s| !s.is_empty()) {
            return step.to_owned();
        }
        return if t.by.as_deref() == Some("compact") { "Compacting" } else { "Starting up" }.into();
    }
    if !waiting.is_empty() {
        return waiting.to_owned();
    }
    f.after_busy.unwrap_or_default().to_owned()
}

/// Why the last run stopped short, in wisp's words (v1 format.js haltOf): a usage limit, a refusal, a crash. The row's
/// pill says it in place of the agent's "Blocked", as each needs something else from you (F-task-14).
fn halt(t: Option<&Turn>) -> Option<&'static str> {
    let t = t?;
    if t.limit.is_some() {
        Some("limit")
    } else if t.refusal.is_some() {
        Some("refused")
    } else if t.status == TurnStatus::Error {
        Some("failed")
    } else {
        None
    }
}

/// The held turn's id (Later's Start / Skip name it).
fn t_id(t: Option<&Turn>) -> String {
    t.map(|t| t.id.as_str().to_owned()).unwrap_or_default()
}

/// The row. `fields`: what `runtime.summary@1` contributors added, flattened onto it.
pub fn summarize(s: &Session, f: &RowFacts<'_>, fields: BTreeMap<String, Value>) -> Summary {
    let mut names: Vec<&str> = Vec::new();
    for n in f.waiting_on {
        if !names.contains(&n.as_str()) {
            names.push(n);
        }
    }
    let waiting = if names.is_empty() { String::new() } else { format!("Waiting on {}", names.join(", ")) };
    let preview = hero(f.report).and_then(|h| h.get("summary")).and_then(Value::as_str).unwrap_or("").to_owned();
    let mut out = BTreeMap::new();
    if let Some(a) = &s.account {
        out.insert("account".into(), json!(a));
    }
    if s.queue_held && !s.queue.is_empty() {
        out.insert("queueHeld".into(), json!(true));
    }
    if !s.tags.is_empty() {
        out.insert("tags".into(), json!(s.tags));
    }
    // saved for later (`runtime.forLater`): the list's For later section
    if let Some(l) = s.ext.get("wisp.runtime").and_then(|r| r.get("forLater")).filter(|l| !l.is_null()) {
        out.insert("forLater".into(), l.clone());
    }
    out.extend(halt(f.last).map(|h| ("halt".to_owned(), json!(h))));
    if let Some(h) = f.last.filter(|t| t.status == TurnStatus::Held).and_then(|t| t.held.as_ref()) {
        out.insert("held".into(), json!({ "kind": h.kind, "by": h.by, "until": h.until, "data": h.data, "turnId": t_id(f.last) }));
    }
    let asks = f.ask.is_some()
        || f.report
            .and_then(|t| t.presentation.as_ref())
            .is_some_and(|p| p.blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("question")));
    out.insert("asks".into(), json!(asks));
    out.insert("question".into(), json!(f.ask.map_or("", |a| a.0)));
    if let Some((_, opts, _)) = f.ask.filter(|a| !a.1.is_empty()) {
        out.insert("options".into(), json!(opts));
    }
    out.insert("approval".into(), json!(f.ask.is_some_and(|a| a.2)));
    out.insert("followups".into(), json!(f.followups));
    out.extend(fields);
    Summary {
        id: s.id.clone(),
        title: s.title.clone(),
        agent: s.agent.clone(),
        model: s.model.clone(),
        effort: s.effort.clone(),
        mode: s.mode,
        cwd: s.cwd.clone(),
        state: s.state,
        status: status(f, &waiting),
        unread: s.unread,
        archived: s.archived,
        created_at: s.created_at,
        updated_at: s.updated_at,
        turn_count: f.turn_count,
        queued: u32::try_from(s.queue.len()).unwrap_or(u32::MAX),
        preview,
        live: live(f, &waiting),
        parent_id: s.parent_id.clone(),
        cost_usd: None,
        fields: out,
    }
}
