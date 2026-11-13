//! Who reviews, and what the user asked the work to respect.

use wisp_review_api::{HARNESSES, Pick};

/// A harness as the runtime reports it (runtime.agents).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub available: bool,
}

/// The first `n` characters, the last one an ellipsis when it was longer (v1 clip, trimmed first).
pub fn clip(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Every harness that wrote part of the task: its turns', else the task's own; never Auto or wisp.
pub fn authors_of<'a>(task_agent: &'a str, turn_agents: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in turn_agents.into_iter().chain(std::iter::once(task_agent)) {
        if !a.is_empty() && a != "auto" && a != "wisp" && !out.iter().any(|x| x == a) {
            out.push(a.to_owned());
        }
    }
    out
}

/// The reviewer for `setting`, or why none can. Never picks an account: the harness runs on the one
/// it's signed in with.
pub fn pick_reviewer(setting: &str, authors: &[String], agents: &[Agent]) -> Result<Pick, String> {
    let ready = |id: &str| agents.iter().any(|a| a.id == id && a.available);
    let pick = |id: &str| Pick { agent: id.to_owned(), model: String::new() };
    if setting.is_empty() || setting == "off" {
        return Err("Review by another harness is off.".into());
    }
    if setting == "other" {
        return HARNESSES
            .iter()
            .find(|h| ready(h) && !authors.iter().any(|a| a == *h))
            .map(|h| pick(h))
            .ok_or_else(|| "No other harness than the one that wrote it is installed here.".into());
    }
    if ready(setting) {
        return Ok(pick(setting));
    }
    let name = agents.iter().find(|a| a.id == setting).map_or(setting, |a| if a.name.is_empty() { setting } else { a.name.as_str() });
    Err(format!("{name} isn't installed here."))
}

/// The user's constraints (runtime's handoff extracts them), plus the task's Done when.
pub fn constraints_for(rules: Vec<String>, goal: &str) -> Vec<String> {
    let done = goal.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = rules;
    if !done.is_empty() {
        out.push(format!("Done when: {}", clip(&done, 600)));
    }
    out
}
