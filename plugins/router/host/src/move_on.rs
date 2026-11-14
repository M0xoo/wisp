//! Where Auto moves a task that stopped at a limit (v1 pipeline.js `#moveOn`, F-acct-16). A usage or rate limit is
//! the plan's: another harness carries on. *Model at capacity* (openai/codex#59045) is the model's, not your plan's:
//! the same harness carries on on another of its models when it has one (v1 rests only that arm), else another
//! harness. Pure, so the choice is tested without a runtime.

use wisp_runtime_api::commands::{AgentStatus, RunPick};
use wisp_runtime_api::model::{Turn, TurnStatus};

/// The words a CLI uses when the model itself is full (router core's `CAPACITY`).
pub fn at_capacity(error: Option<&str>) -> bool {
    let e = error.unwrap_or_default().to_ascii_lowercase();
    e.contains("model is at capacity") || e.contains("capacity unavailable")
}

/// The (harness, model) of a task's runs that stopped at a limit: never picked again for it, and at most
/// [`MAX_MOVES`] moves (v1 `tried`).
pub fn tried(turns: Vec<Turn>) -> Vec<(String, String)> {
    turns
        .into_iter()
        .filter(|t| t.status == TurnStatus::Error && crate::pipeline::hit_limit(t.text.as_deref()))
        .map(|t| (t.agent, t.model))
        .collect()
}

/// v1 pipeline.js `MAX_MOVES`: a task moved this many times because harnesses were at their limit stops there.
pub const MAX_MOVES: usize = 4;

/// The run to carry on with and what the follow-up says; None when nothing else can run, or the task has moved
/// [`MAX_MOVES`] times already. `tried`: the (harness, model) of this task's runs that stopped at a limit, this one's
/// included, so a model at capacity is never picked again for the task (v1 `tried`).
pub fn move_on(
    agents: &[AgentStatus],
    was_agent: &str,
    was_model: &str,
    error: Option<&str>,
    tried: &[(String, String)],
) -> Option<(RunPick, String)> {
    if tried.len() > MAX_MOVES {
        return None;
    }
    let name = |id: &str| agents.iter().find(|a| a.id == id).map_or_else(|| id.to_owned(), |a| a.name.clone());
    let fresh =
        |agent: &str, model: &str| !(tried.iter().any(|(a, m)| a == agent && m == model) || (agent == was_agent && model == was_model));
    if at_capacity(error)
        && let Some(here) = agents.iter().find(|a| a.id == was_agent && a.available && a.signed_in != Some(false))
        && let Some(m) = here.models.iter().find(|m| !m.id.is_empty() && fresh(was_agent, &m.id))
    {
        let was = here.models.iter().find(|x| x.id == was_model).map_or_else(|| was_model.to_owned(), |x| x.label.clone());
        let was = if was.is_empty() { name(was_agent) } else { was };
        let text = format!("{was} is at capacity · moving to {}. Carry on from where it stopped.", m.label);
        return Some((RunPick { agent: Some(was_agent.to_owned()), model: Some(m.id.clone()), effort: None }, text));
    }
    // another harness: one the task hasn't stopped on (its default model)
    let other =
        agents.iter().find(|a| a.available && a.signed_in != Some(false) && a.id != was_agent && !tried.iter().any(|(t, _)| t == &a.id))?;
    let why = if at_capacity(error) { "is at capacity" } else { "hit its usage limit" };
    let text = format!("{} {why} · moving to {}. Carry on from where it stopped.", name(was_agent), other.name);
    Some((RunPick { agent: Some(other.id.clone()), ..RunPick::default() }, text))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use wisp_runtime_api::commands::AgentStatus;
    use wisp_runtime_api::harness::HarnessModel;

    use super::{at_capacity, move_on};

    fn agent(id: &str, name: &str, models: &[(&str, &str)]) -> AgentStatus {
        AgentStatus {
            id: id.into(),
            name: name.into(),
            available: true,
            version: None,
            error: None,
            models: models
                .iter()
                .map(|(i, l)| HarnessModel { id: (*i).into(), label: (*l).into(), hint: None, efforts: Vec::new() })
                .collect(),
            efforts: Vec::new(),
            delegates: false,
            signed_in: None,
            setup: None,
        }
    }

    #[test]
    fn a_codex_model_at_capacity_in_auto_moves_on_to_another_codex_model() {
        let agents = [
            agent("codex", "Codex", &[("", "Default"), ("gpt-5.5", "GPT-5.5"), ("gpt-5.5-mini", "GPT-5.5 mini")]),
            agent("claude", "Claude Code", &[]),
        ];
        let err = Some("ERROR: Selected model is at capacity. Please try a different model.");
        assert!(at_capacity(err));
        let (pick, text) = move_on(&agents, "codex", "gpt-5.5", err, &[]).unwrap();
        // the model rests, not the plan: Codex carries on on another of its models
        assert_eq!((pick.agent.as_deref(), pick.model.as_deref()), (Some("codex"), Some("gpt-5.5-mini")));
        assert_eq!(text, "GPT-5.5 is at capacity · moving to GPT-5.5 mini. Carry on from where it stopped.");
        // a harness with no other model: another harness
        let one = [agent("codex", "Codex", &[("gpt-5.5", "GPT-5.5")]), agent("claude", "Claude Code", &[])];
        let (pick, text) = move_on(&one, "codex", "gpt-5.5", err, &[]).unwrap();
        assert_eq!(pick.agent.as_deref(), Some("claude"));
        assert!(text.starts_with("Codex is at capacity · moving to Claude Code"), "{text}");
        // a usage limit is the plan's: another harness, never another model of the same plan
        let (pick, text) = move_on(&agents, "codex", "gpt-5.5", Some("You've hit your usage limit"), &[]).unwrap();
        assert_eq!(pick.agent.as_deref(), Some("claude"));
        assert!(text.contains("hit its usage limit"), "{text}");
        // nothing else can run: nothing
        assert!(move_on(&agents[..1], "codex", "", Some("usage limit"), &[]).is_none());
        // mini at capacity too, after gpt-5.5: never back to gpt-5.5 (no bouncing), on to another harness
        let tried = [("codex".to_owned(), "gpt-5.5".to_owned()), ("codex".to_owned(), "gpt-5.5-mini".to_owned())];
        let (pick, _) = move_on(&agents, "codex", "gpt-5.5-mini", err, &tried).unwrap();
        assert_eq!(pick.agent.as_deref(), Some("claude"));
        // moved four times already: it stops there (v1 MAX_MOVES)
        let many: Vec<(String, String)> = (0..5).map(|i| ("codex".to_owned(), format!("m{i}"))).collect();
        assert!(move_on(&agents, "codex", "gpt-5.5", err, &many).is_none());
    }
}
