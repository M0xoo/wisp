//! wisp.goal's TUI (ADR-0024): a `tui.input@1` in the task header, where the goal stands (`ext["wisp.goal"]`):
//! judging, again, met or stalled, and the round, in the state's tone. The GUI's goal band, one span wide.

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use serde_json::Value;
use wisp_tui_api::{InputCx, Registry, Slot, Theme, TuiInput};

/// What wisp.goal adds to the TUI.
pub fn register(r: &mut Registry) {
    r.input(GoalPill);
}

/// The goal's state in the task header.
#[derive(Debug)]
pub struct GoalPill;

impl TuiInput for GoalPill {
    fn slot(&self) -> Slot {
        Slot::TaskHeader
    }
    fn render(&self, cx: &InputCx, th: &Theme) -> Option<Span<'static>> {
        let g = cx.task.pointer("/ext/wisp.goal").filter(|g| g.is_object())?;
        let state = g.get("state").and_then(Value::as_str).unwrap_or("judging");
        let round = g.get("rounds").and_then(Value::as_u64).unwrap_or(0);
        let (mark, tone, word) = match state {
            "met" => ("✓", th.good, "goal met"),
            "stalled" => ("✗", th.bad, "goal stalled"),
            "again" => ("◆", th.warn, "goal: again"),
            _ => ("○", th.accent_ink, "goal: judging"),
        };
        let text = if round > 0 { format!("{mark} {word} · round {round}") } else { format!("{mark} {word}") };
        Some(Span::styled(text, Style::default().fg(tone).add_modifier(Modifier::BOLD)))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_goal_shows_in_the_task_header_in_its_tone() {
        let th = Theme::DARK;
        let cx = |g: Value| InputCx { task: json!({ "ext": { "wisp.goal": g } }), ..InputCx::default() };
        let met = GoalPill.render(&cx(json!({ "state": "met", "rounds": 2 })), &th).unwrap();
        assert_eq!((met.content.as_ref(), met.style.fg), ("✓ goal met · round 2", Some(th.good)));
        let stalled = GoalPill.render(&cx(json!({ "state": "stalled", "rounds": 3 })), &th).unwrap();
        assert_eq!(stalled.style.fg, Some(th.bad));
        assert!(GoalPill.render(&InputCx::default(), &th).is_none(), "no goal: nothing");
        let mut r = Registry::default();
        register(&mut r);
        assert_eq!((r.inputs.len(), r.inputs[0].slot()), (1, Slot::TaskHeader));
    }
}
