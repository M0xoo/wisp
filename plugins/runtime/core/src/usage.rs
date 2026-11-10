//! Settings → Usage's line (v1 GET /api/usage summary): spend, turns, how many worked, and the questions
//! agents asked, over the turns that started since a time. Pure: the host reads the turns.

use wisp_runtime_api::commands::UsageSummary;
use wisp_runtime_api::model::{Turn, TurnStatus};

/// A turn that ended by asking (a `question` block in its answer, or held for an answer).
fn asked(t: &Turn) -> bool {
    t.presentation.as_ref().is_some_and(|p| p.blocks.iter().any(|b| b.get("type").and_then(serde_json::Value::as_str) == Some("question")))
}

/// The summary of `turns` that started at or after `from`. `worked`: the share (0–100) of the ended ones that
/// didn't fail; None when none ended.
pub fn summarize(turns: &[Turn], from: i64) -> UsageSummary {
    let mine: Vec<&Turn> = turns.iter().filter(|t| t.started_at >= from).collect();
    let ended: Vec<&&Turn> = mine.iter().filter(|t| matches!(t.status, TurnStatus::Done | TurnStatus::Error | TurnStatus::Stopped)).collect();
    let ok = ended.iter().filter(|t| t.status == TurnStatus::Done && !t.is_error).count();
    #[allow(clippy::cast_precision_loss)] // counts of turns
    let worked = (!ended.is_empty()).then(|| (ok as f64 * 100.0 / ended.len() as f64).round());
    UsageSummary {
        from,
        spend: mine.iter().filter_map(|t| t.stats.as_ref().and_then(|s| s.cost_usd)).sum(),
        turns: u32::try_from(mine.len()).unwrap_or(u32::MAX),
        worked,
        questions: u32::try_from(mine.iter().filter(|t| asked(t)).count()).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::float_cmp)]
mod tests {
    use super::*;
    use serde_json::json;
    use wisp_runtime_api::model::{Presentation, TurnStats};

    fn turn(at: i64, status: TurnStatus, cost: f64, question: bool) -> Turn {
        let blocks = if question { vec![json!({ "type": "question", "question": "which?" })] } else { vec![] };
        Turn { started_at: at, status, stats: Some(TurnStats { cost_usd: Some(cost), ..TurnStats::default() }), presentation: Some(Presentation { blocks, v: 1, ..Presentation::default() }), ..Turn::default() }
    }

    #[test]
    fn usage_sums_spend_counts_turns_and_says_how_many_worked() {
        let turns = vec![turn(10, TurnStatus::Done, 0.5, false), turn(20, TurnStatus::Error, 0.25, false), turn(30, TurnStatus::Done, 0.25, true), turn(40, TurnStatus::Running, 0.0, false), turn(1, TurnStatus::Done, 9.0, false)];
        let u = summarize(&turns, 5);
        assert_eq!(u.turns, 4, "the one before the window is left out");
        assert_eq!(u.spend, 1.0);
        assert_eq!(u.worked, Some(67.0), "2 of 3 ended ones worked; a running one isn't counted");
        assert_eq!(u.questions, 1);
        assert_eq!(summarize(&[], 0).worked, None);
    }
}
