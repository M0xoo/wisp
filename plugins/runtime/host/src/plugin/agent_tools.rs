//! Three of a task's agent tools runtime owns (v1 routes/internal.js): `wisp_tag` (`/internal/tags`), `wisp_blocks`
//! (protocol.js `blockDocs`) and `wisp_stats` (`/internal/stats/:id`). Each answers `{ text }`, or `{ error }`: the
//! refusal the agent reads. The decisions are in `wisp_runtime_core::{tags, tool_stats}`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Setup, WireError};
use wisp_runtime_api::commands as c;
use wisp_runtime_api::model::Activity;
use wisp_runtime_core::tags;
use wisp_runtime_core::tool_stats::{self, Call, Filter, Task};
use wisp_store::{Cond, Query};

use super::{Slot, rt, track};
use crate::error::Result;
use crate::runtime::Runtime;

/// The event-log kinds that are never a tool call (v2's, and v1's imported ones).
const NOT_CALLS: &[&str] = &["text", "thinking", "tool_output", "tool_error", "blocked", "notice", "error", "answer"];
/// Turn ids per event query (SQLite's bound-parameter limit is far above it).
const CHUNK: usize = 500;

fn said(r: Result<String>) -> c::AgentText {
    match r {
        Ok(text) => c::AgentText { text: Some(text), error: None },
        Err(e) => c::AgentText { text: None, error: Some(WireError::from(e).message) },
    }
}

pub(super) fn setup(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::AgentTag, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            Ok(match r.agent_tag(&a).await {
                Ok((text, first, agent)) => {
                    if first {
                        let n = tags::normalize(&a.tags).len();
                        track(&ctx, "wisp_tag", json!({ "agent": agent, "tags": n })).await;
                    }
                    c::AgentText { text: Some(text), error: None }
                }
                Err(e) => c::AgentText { text: None, error: Some(e) },
            })
        }
    });
    cmd!(s, slot, c::AgentBlocks, |_r, call, a| {
        let types: Vec<String> = match &a.types {
            Value::Array(list) => list.iter().map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned)).collect(),
            Value::Null => Vec::new(),
            Value::String(t) => vec![t.clone()],
            t => vec![t.to_string()],
        };
        Ok(c::AgentText { text: Some(wisp_runtime_core::prompt::block_docs(&types)), error: None })
    });
    let sl = slot.clone();
    s.command::<c::AgentStats, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let capped = call.caller().set.starts_with("agent:capped");
            let out = said(r.agent_stats(&a, capped).await);
            let agent = r.get(&a.session).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "wisp_stats", json!({ "agent": agent })).await;
            Ok(out)
        }
    });
}

impl Runtime {
    /// `wisp_tag`: the task's tags replaced by the ones given (normalised), written like any edit of the task
    /// (its row and list line, and the change clients see). (what the agent reads, whether it had none, its harness)
    ///
    /// # Errors
    /// The refusal the agent reads: no such task, or no usable word.
    pub(crate) async fn agent_tag(self: &Arc<Self>, a: &c::AgentTagArgs) -> std::result::Result<(String, bool, String), String> {
        let list = tags::normalize(&a.tags);
        if list.is_empty() {
            return Err(tags::NONE_GIVEN.into());
        }
        let given = a.tags.as_array().map_or(0, Vec::len);
        let mut first = false;
        let kept = list.clone();
        let s = self
            .edit(&a.session, |s| {
                first = s.tags.is_empty();
                s.tags = kept;
                Ok(())
            })
            .await
            .map_err(|_| "no such session".to_owned())?;
        Ok((tags::tagged_text(&list, given), first, s.agent))
    }

    /// `wisp_stats` over every task that ran in the range (a capped agent's: its own project's).
    ///
    /// # Errors
    /// No such task, or the store failed.
    async fn agent_stats(&self, a: &c::AgentStatsArgs, capped: bool) -> Result<String> {
        let me = self.repo.session(&a.session).await?;
        let blank = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
        let mut project = if capped { Some("current".to_owned()) } else { blank(&a.project) };
        if project.as_deref() == Some("current") {
            project = Some(me.cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(&me.cwd).to_owned());
        }
        let days = tool_stats::days(a.days.as_ref());
        let now = self.now();
        let turns = self.repo.turns_since(tool_stats::since(days, now)).await?;
        let sessions = self.repo.sessions().await?;
        let tasks: HashMap<&str, Task<'_>> =
            sessions.iter().map(|s| (s.id.as_str(), Task { agent: s.agent.as_str(), cwd: s.cwd.as_str() })).collect();
        let ended: Vec<String> = turns.iter().filter(|t| !t.status.is_live()).map(|t| t.id.as_str().to_owned()).collect();
        let calls = self.tool_calls(ended).await?;
        let st =
            tool_stats::tool_stats(&|id| tasks.get(id).copied(), &turns, &calls, (days, now), Filter { agent: blank(&a.agent), project });
        Ok(tool_stats::tool_stats_text(&st))
    }

    /// The tool calls of these turns, from their event logs (v1 and v2 rows alike, through the upcasters).
    async fn tool_calls(&self, turns: Vec<String>) -> Result<Vec<Call>> {
        let mut out = Vec::new();
        for ids in turns.chunks(CHUNK) {
            let mut q =
                Query::new().select(&["turn_id", "seq", "t", "v", "body"]).any_of("turn_id", ids.iter().map(|i| json!(i)).collect());
            for k in NOT_CALLS {
                q = q.cond("kind", Cond::Ne(json!(k)));
            }
            let rows = self.repo.store.read_async(move |r| r.query("event", &q)).await?;
            for row in &rows {
                let Some(turn) = row.get("turn_id").and_then(Value::as_str) else { continue };
                if let Some(step) = crate::rows::step_of(row)
                    && let Activity::Tool { tool, .. } = step.activity
                {
                    out.push(Call { turn: turn.to_owned(), t: step.t, kind: tool });
                }
            }
        }
        Ok(out)
    }
}
