//! Feedback for the wisp team (v1 server/services/feedback.js): thumbs on a turn and/or a note. A rating
//! sticks to its turn (it shows on the card and can be taken back). What goes out is the rating, the
//! user's own words and how the run was set up, never the prompt or the result.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::events::{Props, set_opt};
use crate::turns::{RunFacts, TurnFacts, block_types, hero_status, run_props};

/// A rating given with the feedback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rating {
    Up,
    Down,
    /// `rating: null`: take the rating on a turn back
    Clear,
}

impl Rating {
    pub fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Up => Some("up"),
            Self::Down => Some("down"),
            Self::Clear => None,
        }
    }
}

/// The body of POST /api/feedback, checked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedbackArgs {
    pub rating: Option<Rating>,
    pub text: String,
    pub kind: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub source: Option<String>,
}

impl FeedbackArgs {
    /// The body for the machine the session is on, with its own id there (v1's peer call).
    pub fn peer_body(&self, local_id: &str) -> Value {
        let mut b = serde_json::Map::new();
        if let Some(r) = self.rating {
            b.insert("rating".into(), r.as_str().map_or(Value::Null, |r| json!(r)));
        }
        b.insert("text".into(), json!(self.text));
        if let Some(k) = &self.kind {
            b.insert("kind".into(), json!(k));
        }
        b.insert("sessionId".into(), json!(local_id));
        if let Some(t) = &self.turn_id {
            b.insert("turnId".into(), json!(t));
        }
        if let Some(s) = &self.source {
            b.insert("source".into(), json!(s));
        }
        Value::Object(b)
    }
}

/// v1's checks, with v1's messages (all 400).
pub fn parse(body: &Value) -> Result<FeedbackArgs, String> {
    let empty = serde_json::Map::new();
    let b = body.as_object().unwrap_or(&empty);
    let rating = match b.get("rating") {
        None => None,
        Some(Value::Null) => Some(Rating::Clear),
        Some(Value::String(r)) if r == "up" => Some(Rating::Up),
        Some(Value::String(r)) if r == "down" => Some(Rating::Down),
        Some(_) => return Err("rating must be up or down".into()),
    };
    let kind = match b.get("kind") {
        None | Some(Value::Null) => None,
        Some(Value::String(k)) if k == "bug" || k == "idea" => Some(k.clone()),
        Some(_) => return Err("kind must be bug or idea".into()),
    };
    let text = match b.get("text") {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(v) => v.to_string().trim().to_owned(),
    };
    if kind.as_deref() == Some("bug") && text.is_empty() {
        return Err("Say what happened, so the team can fix it.".into());
    }
    if rating.is_none() && text.is_empty() {
        return Err("Write something, or pick 👍 / 👎.".into());
    }
    let opt = |k: &str| match b.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.to_string()),
    };
    Ok(FeedbackArgs { rating, text, kind, session_id: opt("sessionId"), turn_id: opt("turnId"), source: opt("source") })
}

/// `id@machine` → (id, machine) (v1 machines.js `splitId`): the last `@`, not at the start.
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let i = id.rfind('@')?;
    (i > 0).then(|| (&id[..i], &id[i + 1..]))
}

/// The run a rating is about, when it is a task on this computer.
#[derive(Debug, Clone, Default)]
pub struct Context<'a> {
    pub run: Option<(&'a RunFacts, &'a TurnFacts)>,
    /// the session is the wisp tour (`agent: wisp`)
    pub tour: bool,
    /// the session is on another machine that couldn't take it: sent from here, without the run
    pub machine: bool,
}

/// The event name and its props: thumbs on a turn are `turn_rated`; anything written, or sent from the
/// dialog, is `feedback`. Taking a rating back says `cleared`.
pub fn event(a: &FeedbackArgs, c: &Context<'_>) -> (&'static str, Props) {
    let mut p = Props::new();
    if let Some((r, t)) = c.run {
        p.extend(run_props(r));
        p.insert("status".into(), json!(t.status));
        set_opt(&mut p, "heroStatus", hero_status(t));
        p.insert("blockTypes".into(), json!(block_types(t)));
        set_opt(&mut p, "durationMs", t.ended_at.filter(|e| *e != 0).map(|e| e - t.started_at));
        if c.tour {
            p.insert("tour".into(), json!(true));
        }
    }
    set_opt(&mut p, "rating", a.rating.and_then(Rating::as_str));
    set_opt(&mut p, "kind", a.kind.clone());
    let source = a.source.clone().unwrap_or_else(|| if c.run.is_some() { "turn".into() } else { "app".into() });
    p.insert("source".into(), json!(source.chars().take(20).collect::<String>()));
    if c.machine {
        p.insert("machine".into(), json!(true));
    }
    let name = if !a.text.is_empty() || a.turn_id.is_none() { "feedback" } else { "turn_rated" };
    if name == "turn_rated" && a.rating == Some(Rating::Clear) {
        p.insert("cleared".into(), json!(true));
    }
    if !a.text.is_empty() {
        p.insert("text".into(), json!(a.text));
    }
    (name, p)
}

/// Only thumbs on a turn stick to it; a rating in the feedback dialog is about wisp as a whole.
pub fn sticks_to_turn(a: &FeedbackArgs) -> bool {
    a.turn_id.is_some() && a.rating.is_some()
}

/// What POST /api/feedback answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackResult {
    pub ok: bool,
    /// `PostHog` has it; false: it waits in the outbox
    pub sent: bool,
    /// feedback can go out at all (a key, and `WISP_FEEDBACK` isn't 0)
    pub available: bool,
}
