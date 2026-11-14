//! `runtime.prompt@1`'s brief: the system prompt part built from what `prepare` resolved.

use std::fmt::Write as _;

use serde_json::Value;

/// The system prompt's brief from what `prepare` resolved (`ext["wisp.runtime"].brief`).
pub fn brief_text(brief: &Value) -> String {
    let mut out = String::new();
    let s = |k: &str| brief.get(k).and_then(Value::as_str).unwrap_or_default();
    if !s("project").is_empty() {
        let _ = write!(out, "## This project's instructions\n\n{}\n", s("project").trim());
    }
    if !s("agent").is_empty() {
        let _ = write!(out, "\n## Your instructions\n\n{}\n", s("agent").trim());
    }
    let skills = brief.get("skills").and_then(Value::as_array).cloned().unwrap_or_default();
    if !skills.is_empty() {
        out.push_str("\n## Skills you have\n");
        for k in skills {
            let (n, d, b) = (
                k.get("name").and_then(Value::as_str).unwrap_or(""),
                k.get("description").and_then(Value::as_str).unwrap_or(""),
                k.get("body").and_then(Value::as_str).unwrap_or(""),
            );
            let _ = write!(out, "\n### {n}\n{d}\n\n{}\n", b.trim());
        }
    }
    let team = brief.get("team").and_then(Value::as_array).cloned().unwrap_or_default();
    if !team.is_empty() {
        out.push_str("\n## Your team\n\nHand work to these with wisp_delegate (by name):\n");
        for m in team {
            let g = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            let n = m.get("count").and_then(Value::as_u64).map_or_else(String::new, |c| format!(", up to {c} at once"));
            let why = g("why");
            let _ = writeln!(out, "- {} ({}{n}){}", g("name"), g("agent"), if why.is_empty() { String::new() } else { format!(": {why}") });
        }
    }
    out.trim().to_owned()
}

/// `runtime.prompt@1`: a task's brief (its project's instructions, its agent's, its skills).
#[derive(Debug)]
pub struct Brief;

impl wisp_runtime_api::points::PromptPart for Brief {
    fn id(&self) -> &'static str {
        "wisp.runtime.brief"
    }
    fn part(&self, session: &wisp_runtime_api::model::Session) -> String {
        session.ext.get("wisp.runtime").and_then(|m| m.get("brief")).map(brief_text).unwrap_or_default()
    }
}
