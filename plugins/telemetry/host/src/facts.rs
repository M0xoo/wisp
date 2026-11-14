//! The facts a turn's telemetry events report (`turn_started`, `turn_ended`, `turn_rated`), read from wisp.runtime
//! through its typed commands: fixed values only, never the prompt.

use wisp_kernel::{Call, Ctx, WireError};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Session, Turn};
use wisp_telemetry_core::turns::{BlockFact, RunFacts, TurnFacts};

/// A wire enum's name (`TurnStatus::Done` → "done", `Mode::Auto` → "auto").
fn name_of<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The facts a turn's events report, read from wisp.runtime (fixed values only, never the prompt). None, logged at
/// debug, when runtime refuses (a task deleted since) or the turn isn't the task's.
pub(crate) async fn facts(ctx: &Ctx, call: &Call, sid: &str, tid: &str) -> Option<(RunFacts, TurnFacts)> {
    let id = SessionId(sid.to_owned());
    let read = async {
        let s = ctx.run::<r::Get>(call, r::IdArgs { id: id.clone() }).await?;
        let turns = ctx.run::<r::Turns>(call, r::TurnsArgs { id: id.clone(), before: None, limit: None, masked: None }).await?;
        Ok::<_, WireError>((s, turns))
    };
    let (s, turns) = match read.await {
        Ok(x) => x,
        Err(err) => {
            tracing::debug!(error = %err.message, task = sid, "telemetry: reading the turn");
            return None;
        }
    };
    let t = turns.into_iter().find(|t| t.id.as_str() == tid)?;
    Some(facts_of(&s, &t))
}

/// What [`facts`] reports from a task and one of its turns.
fn facts_of(s: &Session, t: &Turn) -> (RunFacts, TurnFacts) {
    let str_of = |v: &str| Some(v).filter(|x| !x.is_empty()).map(str::to_owned);
    let run = RunFacts {
        agent: if t.agent.is_empty() { s.agent.clone() } else { t.agent.clone() },
        model: str_of(&t.model),
        mode: name_of(&t.mode),
        effort: str_of(&t.effort),
        turn_index: usize::try_from(t.idx).unwrap_or(0),
        route: s.ext_of("wisp.router").get("route").cloned(),
    };
    let blocks = t
        .presentation
        .as_ref()
        .map(|p| {
            p.blocks
                .iter()
                .map(|b| BlockFact { ty: b["type"].as_str().unwrap_or_default().to_owned(), status: b["status"].as_str().and_then(str_of) })
                .collect()
        })
        .unwrap_or_default();
    // token counts stay far below 2^53: the f64 is exact
    #[allow(clippy::cast_precision_loss)]
    let tokens = |n: Option<u64>| n.map(|n| n as f64);
    let stats = t.stats.as_ref();
    let turn = TurnFacts {
        status: name_of(&t.status),
        started_at: t.started_at,
        ended_at: t.ended_at,
        attachments: t.attachments.len(),
        blocks,
        presentation_fallback: t.presentation.as_ref().is_some_and(|p| p.fallback),
        changed_files: t.changed_files.and_then(|n| usize::try_from(n).ok()).unwrap_or(0),
        input_tokens: tokens(stats.and_then(|x| x.input_tokens)),
        output_tokens: tokens(stats.and_then(|x| x.output_tokens)),
        cost_usd: stats.and_then(|x| x.cost_usd),
    };
    (run, turn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A turn's facts from runtime's typed task and turn: its own harness (the task's when it names none), the wire
    /// names of its mode and status, the route Auto left on the task, its blocks and token counts.
    #[test]
    fn a_turns_facts_read_the_typed_task_and_turn() {
        use wisp_runtime_api::model::{Mode, Presentation, TurnStats, TurnStatus};
        let mut s = Session { agent: "codex".into(), ..Session::default() };
        s.ext.insert("wisp.router".into(), json!({ "route": { "key": "codex:m:high", "type": "explore" } }));
        let t = Turn {
            idx: 2,
            mode: Mode::Edits,
            status: TurnStatus::Stopped,
            started_at: 10,
            ended_at: Some(20),
            changed_files: Some(3),
            stats: Some(TurnStats { input_tokens: Some(1200), cost_usd: Some(0.5), ..TurnStats::default() }),
            presentation: Some(Presentation {
                blocks: vec![json!({ "type": "hero", "status": "done" }), json!({ "type": "diff" })],
                v: 1,
                dropped: Vec::new(),
                topic: None,
                notes: None,
                fallback: true,
            }),
            ..Turn::default()
        };
        let (run, turn) = facts_of(&s, &t);
        assert_eq!((run.agent.as_str(), run.mode.as_str(), run.turn_index, run.model), ("codex", "edits", 2, None));
        assert_eq!(run.route, Some(json!({ "key": "codex:m:high", "type": "explore" })));
        assert_eq!((turn.status.as_str(), turn.ended_at, turn.changed_files), ("stopped", Some(20), 3));
        assert_eq!((turn.input_tokens, turn.output_tokens, turn.cost_usd), (Some(1200.0), None, Some(0.5)));
        assert!(turn.presentation_fallback);
        assert_eq!(
            turn.blocks.iter().map(|b| (b.ty.as_str(), b.status.as_deref())).collect::<Vec<_>>(),
            [("hero", Some("done")), ("diff", None)]
        );
        let own = Turn { agent: "claude".into(), ..t };
        assert_eq!(facts_of(&s, &own).0.agent, "claude");
    }
}
