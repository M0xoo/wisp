//! What a job hands back (v1 crew.js `takeCrewBlock`, `applyMemory`, `clampNotebook`): the hidden `crew`
//! block that ends its report becomes notebook lines, a rewrite, a wake-up, how it's filed, kit offers and
//! follow-ups. The presentation is the runtime's JSON; only `blocks`, `notes` and `topic` are read.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_crew_api::{FOLLOW_UPS_MAX, KIT_BODY_MAX, Member, NOTEBOOK_MAX, OFFER_FILES, REMEMBER_CHARS, REMEMBER_LINES};

use crate::schedule::wake_at;
use crate::text::{clip, squash, str_of, tail, unix};

/// A follow-up a job asked for: a message to the agent of one of the member's tasks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FollowUp {
    pub task: String,
    pub text: String,
}

/// The `crew` blocks of a report, merged.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewOut {
    pub remember: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_in: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub quiet: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub for_later: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kit: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub follow_ups: Vec<FollowUp>,
}

/// A notebook over the cap loses its oldest lines first (new facts are appended at the end).
pub fn clamp_notebook(text: &str) -> String {
    let t = unix(text);
    let mut t = t.trim();
    let mut n = t.chars().count();
    while n > NOTEBOOK_MAX {
        match t.find('\n') {
            Some(i) => {
                n -= t[..=i].chars().count();
                t = &t[i + 1..];
            }
            None => break,
        }
    }
    tail(t, NOTEBOOK_MAX)
}

/// Lines to remember: non-empty strings, squashed, at most 12 of 300 characters.
pub fn remember_lines(list: &[Value]) -> Vec<String> {
    list.iter()
        .filter_map(Value::as_str)
        .map(squash)
        .filter(|s| !s.is_empty())
        .map(|s| clip(&s, REMEMBER_CHARS))
        .take(REMEMBER_LINES)
        .collect()
}

/// The notebook with `lines` added at the end as `- …` items, clamped.
pub fn with_lines(notebook: &str, lines: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !notebook.is_empty() {
        parts.push(notebook.to_owned());
    }
    parts.extend(lines.iter().map(|l| format!("- {l}")));
    clamp_notebook(&parts.join("\n"))
}

fn merge_block(out: &mut CrewOut, b: &Value, presentation_topic: &mut Option<String>) {
    match b.get("remember") {
        Some(Value::Array(a)) => {
            out.remember.extend(a.iter().filter_map(Value::as_str).map(squash).filter(|s| !s.is_empty()).map(|s| clip(&s, REMEMBER_CHARS)));
        }
        Some(Value::String(s)) if !s.trim().is_empty() => out.remember.push(clip(s.trim(), REMEMBER_CHARS)),
        _ => {}
    }
    if let Some(Value::String(s)) = b.get("notebook") {
        out.notebook = Some(s.clone());
    }
    if let Some(w) = b.get("wakeIn").and_then(Value::as_f64).filter(|w| *w > 0.0) {
        out.wake_in = Some(w);
    }
    out.quiet |= b.get("quiet") == Some(&Value::Bool(true));
    out.for_later |= b.get("forLater") == Some(&Value::Bool(true));
    // A quick answer has no hero: the crew block names its task.
    if let Some(t) = b.get("topic").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty())
        && presentation_topic.is_none()
    {
        *presentation_topic = Some(clip(t, 200));
    }
    if let Some(Value::Array(kit)) = b.get("kit") {
        for k in kit.iter().filter(|k| k.is_object()) {
            out.kit.push(json!({ "kind": str_of(k.get("kind")), "name": clip(str_of(k.get("name")).trim(), 64), "description": clip(&str_of(k.get("description")), 1024), "body": clip(&str_of(k.get("body")), KIT_BODY_MAX) }));
        }
    }
    let ups: Vec<&Value> = match b.get("followUp") {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(v) => vec![v],
        None => Vec::new(),
    };
    for f in ups {
        if let Some(text) = f.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
            out.follow_ups.push(FollowUp { task: clip(&str_of(f.get("task")), 60), text: clip(text, 4000) });
        }
    }
}

/// Takes the `crew` blocks out of a presentation (they're never shown) and merges them. `None`: it had
/// none. A report left with nothing gets its text (`notes`) as markdown, or a "Nothing new" hero.
pub fn take_crew_block(p: &mut Value) -> Option<CrewOut> {
    let blocks = p.get("blocks").and_then(Value::as_array).cloned().unwrap_or_default();
    let is_crew = |b: &Value| b.get("type").and_then(Value::as_str) == Some("crew");
    if !blocks.iter().any(is_crew) {
        return None;
    }
    let mut out = CrewOut::default();
    let mut topic = p.get("topic").and_then(Value::as_str).map(str::to_owned);
    let had_topic = topic.is_some();
    for b in blocks.iter().filter(|b| is_crew(b)) {
        merge_block(&mut out, b, &mut topic);
    }
    out.remember.truncate(REMEMBER_LINES);
    out.follow_ups.truncate(FOLLOW_UPS_MAX);
    out.kit.truncate(OFFER_FILES);
    let mut kept: Vec<Value> = blocks.into_iter().filter(|b| !is_crew(b)).collect();
    let Some(obj) = p.as_object_mut() else { return Some(out) };
    if let (false, Some(t)) = (had_topic, topic) {
        obj.insert("topic".into(), Value::String(t));
    }
    // Only a crew block: a quick answer's text (its notes) is the report, else a hero says so.
    if kept.is_empty()
        && let Some(notes) = obj.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_owned)
    {
        kept.push(json!({ "type": "markdown", "text": notes }));
        obj.remove("notes");
    }
    if kept.is_empty() {
        kept.push(json!({ "type": "hero", "title": "Nothing new", "summary": "", "status": "info" }));
    }
    obj.insert("blocks".into(), Value::Array(kept));
    Some(out)
}

/// What changes on the member: its notebook (a rewrite, then lines added) and its next wake-up.
pub fn apply_memory(m: &mut Member, data: &CrewOut, now: i64) {
    if let Some(nb) = &data.notebook {
        m.notebook = clamp_notebook(nb);
    }
    if !data.remember.is_empty() {
        m.notebook = with_lines(&m.notebook, &data.remember);
    }
    if let Some(w) = data.wake_in {
        m.wake_at = Some(wake_at(now, w));
    }
}
