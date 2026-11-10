//! The retro (v1 preferences.js `Retro`): scheduled after a turn that ended done or stopped (not interrupted),
//! cancelled by the next turn's start, then one at a time: read the task's new turns, ask a lean run on the
//! task's own harness what it teaches, merge that over the lists as they are now, log the run.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Ctx, Setup, WireError};
use wisp_learn_api::{Change, GLOBAL, Kind, Lists, Retro};
use wisp_learn_core::{IDLE_MS, MAX_HISTORY, RETRO_TIMEOUT_MS, Trail, TurnRead, digest, merge, parse_retro, retro_prompt, worth_retro};
use wisp_runtime_api::events::{TurnEnded, TurnStarted};
use wisp_runtime_api::model::TurnStatus;

use crate::{State, enabled, lock, now, project_of, store};

/// A new wait for task `id`, superseding any earlier one; its number.
fn bump(st: &State, id: &str) -> u64 {
    let mut w = lock(&st.waits);
    let n = w.get(id).copied().unwrap_or(0) + 1;
    w.insert(id.to_owned(), n);
    n
}

pub(crate) fn schedule(s: &mut Setup, st: &Arc<State>) {
    let a = st.clone();
    s.on::<TurnStarted, _, _>(move |_ctx, e| {
        let st = a.clone();
        async move {
            bump(&st, e.session_id.as_str());
        }
    });
    let b = st.clone();
    s.on::<TurnEnded, _, _>(move |ctx, e| {
        let st = b.clone();
        async move {
            if e.interrupted || !matches!(e.status, TurnStatus::Done | TurnStatus::Stopped) || !enabled(&ctx) {
                return;
            }
            let id = e.session_id.0.clone();
            let n = bump(&st, &id);
            let Ok(clock) = ctx.clock() else { return };
            let c2 = ctx.clone();
            ctx.spawn(async move {
                clock.sleep(IDLE_MS).await;
                if lock(&st.waits).get(&id) != Some(&n) {
                    return; // a newer turn: its own end schedules again
                }
                if let Err(e) = run(&c2, &st, &id, false).await {
                    tracing::debug!(task = %id, why = %e.message, "learn: no retro");
                }
            });
        }
    });
}

/// A turn as the digest reads it, from wisp.runtime's turn and its activity.
fn turn_read(t: &Value, steps: &[Value]) -> TurnRead {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let blocks = t.pointer("/presentation/blocks").and_then(Value::as_array).cloned().unwrap_or_default();
    let of = |ty: &str| blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some(ty));
    let trail = steps
        .iter()
        .filter_map(|a| match (a.get("kind").and_then(Value::as_str), a.get("tool").and_then(Value::as_str)) {
            (Some("tool"), Some("run")) => Some(Trail::Run(a.get("detail").and_then(Value::as_str).map_or_else(|| s(a, "label"), str::to_owned))),
            (Some("tool"), Some("ask")) => Some(Trail::Ask(s(a, "label"))),
            (Some("tool"), Some("answer")) => Some(Trail::Answer(s(a, "label"))),
            (Some("tool_error"), _) => Some(Trail::Failed(format!("{}: {}", s(a, "name"), s(a, "text")))),
            _ => None,
        })
        .collect();
    TurnRead { prompt: s(t, "prompt"), status: s(t, "status"), trail, hero: of("hero").map(|h| (s(h, "status"), s(h, "title"), s(h, "summary"))), question: of("question").map(|q| s(q, "question")).filter(|q| !q.is_empty()) }
}

/// The task's turns as read for its digest; the activity only for the turns from `from` (at most the last 6).
async fn read_turns(ctx: &Ctx, call: &wisp_kernel::Call, id: &str, from: usize) -> Result<Vec<TurnRead>, WireError> {
    let turns = ctx.run_json(call, "runtime.turns", json!({ "id": id })).await?;
    let list = turns.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(list.len());
    let deep = from.max(list.len().saturating_sub(6));
    for (i, t) in list.iter().enumerate() {
        let steps = if i >= deep {
            let page = ctx.run_json(call, "runtime.activity", json!({ "id": id, "turnId": t.get("id") })).await.unwrap_or_default();
            page.get("items").and_then(Value::as_array).cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        out.push(turn_read(t, &steps));
    }
    Ok(out)
}

/// One retro of task `id`. `forced`: asked for (`learn.retro`), so it runs whatever the turns hold.
pub(crate) async fn run(ctx: &Ctx, st: &State, id: &str, forced: bool) -> Result<Retro, WireError> {
    let _one = st.one.lock().await;
    let call = ctx.root_call();
    let s = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await?;
    if !forced && s.get("queue").and_then(Value::as_array).is_some_and(|q| !q.is_empty()) {
        return Err(WireError::conflict("a follow-up waits: its end schedules the retro"));
    }
    let from = lock(&st.data).seen.get(id).copied().unwrap_or(0) as usize;
    let turns = read_turns(ctx, &call, id, from).await?;
    let upto = u32::try_from(turns.len()).unwrap_or(u32::MAX);
    let from = if forced { 0 } else { from.min(turns.len()) };
    if !forced && (from >= turns.len() || !worth_retro(&turns, from)) {
        mark_seen(st, id, upto).await;
        return Err(WireError::conflict("nothing to learn from these turns"));
    }
    let project = project_of(&s);
    let (global, mine) = {
        let d = lock(&st.data);
        (d.global.clone(), d.projects.get(&project).cloned().unwrap_or_default())
    };
    let name = std::path::Path::new(&project).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let prompt = retro_prompt(&global, &mine, &name, &digest(&turns, from));
    let agent = s.get("agent").and_then(Value::as_str).unwrap_or_default().to_owned();
    let mut run = Retro { id: wisp_kernel::ids::uuid7(), session_id: id.to_owned(), title: s.get("title").and_then(Value::as_str).unwrap_or_default().to_owned(), project: project.clone(), agent: agent.clone(), turns: upto - u32::try_from(from).unwrap_or(0), at: now(ctx), ..Retro::default() };
    let args = json!({ "prompt": prompt, "cwd": s.get("cwd"), "pick": { "agent": agent }, "timeoutMs": RETRO_TIMEOUT_MS });
    let reply = ctx.run_json(&call, "runtime.quick", args).await;
    let proposal = match &reply {
        Ok(r) => parse_retro(r.get("text").and_then(Value::as_str).unwrap_or_default()),
        Err(_) => None,
    };
    let Some(p) = proposal else {
        run.status = "failed".into();
        run.error = Some(match reply {
            Ok(r) => format!("Unreadable reply: {}", r.get("text").and_then(Value::as_str).unwrap_or("(empty)").chars().take(200).collect::<String>()),
            Err(e) => e.message.chars().take(240).collect(),
        });
        record(ctx, st, &run, upto).await;
        return Ok(run);
    };
    for (scope, key, snap, prop) in [("global", GLOBAL.to_owned(), &global, &p.global), ("project", project.clone(), &mine, &p.project)] {
        for (i, kind) in Kind::ALL.into_iter().enumerate() {
            let Some(proposed) = &prop[i] else { continue };
            let current = current(st, &key, kind);
            let (next, added, removed) = merge(snap.get(kind), proposed, &current);
            if added.is_empty() && removed.is_empty() {
                continue;
            }
            st.set(&key, kind, &next, run.at).await;
            run.added.extend(added.into_iter().map(|text| Change { text, kind, scope: scope.into() }));
            run.removed.extend(removed.into_iter().map(|text| Change { text, kind, scope: scope.into() }));
        }
    }
    run.status = if run.added.is_empty() && run.removed.is_empty() { "nothing" } else { "learned" }.into();
    record(ctx, st, &run, upto).await;
    Ok(run)
}

fn current(st: &State, key: &str, kind: Kind) -> Vec<String> {
    let d = lock(&st.data);
    let l: Option<&Lists> = if key == GLOBAL { Some(&d.global) } else { d.projects.get(key) };
    l.map(|l| l.get(kind).to_vec()).unwrap_or_default()
}

async fn mark_seen(st: &State, id: &str, upto: u32) {
    lock(&st.data).seen.insert(id.to_owned(), upto);
    if let Some(s) = st.store.get()
        && let Err(e) = store::put_seen(s, id, upto).await
    {
        tracing::warn!(error = %e, "learn: saving");
    }
}

/// Every run is logged (Settings shows what each did, nothing included), the task read up to `upto`.
async fn record(ctx: &Ctx, st: &State, run: &Retro, upto: u32) {
    let dropped: Vec<String> = {
        let mut d = lock(&st.data);
        d.history.push(run.clone());
        d.seen.insert(run.session_id.clone(), upto);
        let over = d.history.len().saturating_sub(MAX_HISTORY);
        d.history.drain(..over).map(|x| x.id).collect()
    };
    if let Some(s) = st.store.get()
        && let Err(e) = store::put_retro(s, run, dropped, upto).await
    {
        tracing::warn!(error = %e, "learn: saving a retro");
    }
    let props = json!({ "agent": run.agent, "ok": run.status != "failed", "added": run.added.len(), "removed": run.removed.len() });
    let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "retro", "props": props })).await;
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_reads_its_commands_failures_questions_and_report() {
        let t = json!({ "prompt": "fix the build", "status": "done", "presentation": { "blocks": [
            { "type": "hero", "status": "done", "title": "Build fixed", "summary": "pinned the version" },
            { "type": "question", "question": "Ship it?" } ] } });
        let steps = [
            json!({ "kind": "tool", "tool": "run", "label": "Run", "detail": "npm test" }),
            json!({ "kind": "tool_error", "name": "bash", "text": "3 failed" }),
            json!({ "kind": "text", "text": "thinking aloud" }),
        ];
        let r = turn_read(&t, &steps);
        assert_eq!(r.trail, vec![Trail::Run("npm test".into()), Trail::Failed("bash: 3 failed".into())]);
        assert_eq!(r.hero.as_ref().map(|h| h.1.as_str()), Some("Build fixed"));
        assert_eq!(r.question.as_deref(), Some("Ship it?"));
    }
}
