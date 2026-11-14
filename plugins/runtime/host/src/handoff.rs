//! A follow-up on another harness (v1 handoff.js, F-comp-27). Each harness keeps its own conversation, so the one
//! taking over hasn't seen the turns that ran elsewhere: they go ahead of the prompt, opening with *What still holds*
//! (the user's "don't touch / only change / leave … alone" lines). The task keeps its thinking level, as the new
//! harness names it (Claude Code `max` goes to Codex as `xhigh`), unless the switch picked one; and the old harness's
//! model doesn't go with it.

use wisp_runtime_api::Harness;
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_core::prompt::handoff::{Handoff, PastTurn, Render, handoff_note, map_effort};

use crate::runtime::Runtime;

/// The thinking levels `h` offers for `model` (the model's own, else the harness's).
fn levels_of<'a>(h: &'a dyn Harness, model: &str) -> &'a [String] {
    let info = h.info();
    info.models.iter().find(|m| m.id == model && !m.efforts.is_empty()).map_or(info.efforts.as_slice(), |m| m.efforts.as_slice())
}

/// After a follow-up switched `s` to another harness (`was`): its model is the new one's default unless picked, and
/// its effort the closest level the new one has unless picked (`picked_*`).
pub(crate) fn carry_over(s: &mut Session, was: &str, picked_model: bool, picked_effort: bool, h: Option<&dyn Harness>) {
    if s.agent == was {
        return;
    }
    if !picked_model {
        s.model.clear();
    }
    if !picked_effort {
        s.effort = h.map(|h| map_effort(&s.effort, levels_of(h, &s.model))).unwrap_or_default();
    }
}

impl Runtime {
    /// `prompt` with what the harness taking `turn` missed ahead of it ('' to add when it has seen everything).
    pub(crate) async fn with_handoff(&self, s: &Session, turn: &Turn, prompt: String) -> String {
        if turn.idx == 0 {
            return prompt;
        }
        let Ok(mut all) = self.repo.turns(s.id.as_str(), None, None).await else { return prompt };
        all.retain(|t| t.id != turn.id);
        all.sort_by_key(|t| t.idx);
        all.push(turn.clone());
        // what the task's turns read of .env files (ADR-0050): the note quotes none of it, as it goes to another
        // harness and is stored as this turn's prompt. Unknown: no note rather than one that may carry a value.
        let known = match self.env_known(s.id.as_str()).await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(task = %s.id.0, error = %e, "runtime: the task's .env reads are unknown, so the hand-off note is left out");
                return prompt;
            }
        };
        let name = |id: &str| self.harness(id).map_or_else(|_| id.to_owned(), |h| h.info().name.clone());
        let past: Vec<PastTurn<'_>> = all
            .iter()
            .map(|t| PastTurn { env: &known.0, ..PastTurn::new(t, name(if t.agent.is_empty() { &s.agent } else { &t.agent })) })
            .collect();
        let h = Handoff { turns: &past, agent: &s.agent, resume_id: s.resume_id.as_deref(), ..Handoff::default() };
        let note = handoff_note(&h, Render::default());
        if note.is_empty() { prompt } else { format!("{note}\n\n{prompt}") }
    }
}
