//! The retro (v1 preferences.js `Retro`): scheduled after a turn that ended done or stopped (not interrupted),
//! cancelled by the next turn's start, then one at a time: read the task's new turns, ask a lean run on the
//! task's own harness what it teaches, merge that over the lists as they are now, log the run.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Ctx, Setup, WireError};
use wisp_learn_api::{Change, GLOBAL, Kind, Lists, Retro};
use wisp_learn_core::{IDLE_MS, MAX_HISTORY, RETRO_TIMEOUT_MS, Trail, TurnRead, digest, merge, parse_retro, retro_prompt, worth_retro};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::{TurnEnded, TurnStarted};
use wisp_runtime_api::model::{Activity, Step, ToolKind, Turn, TurnStatus};
use wisp_telemetry_api as tel;

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

/// A step's text as it may leave: the ranges the turn machine flagged as quoting a .env value hidden (ADR-0050). The
/// digest goes to an agent, so it never carries one, whatever the setting says.
fn masked(text: &str, hide: Option<&Vec<[u32; 2]>>) -> String {
    hide.map_or_else(|| text.to_owned(), |h| wisp_envmask::mask_spans(text, h))
}

/// A turn as the digest reads it, from wisp.runtime's turn and its activity.
fn turn_read(t: &Turn, steps: &[Step]) -> TurnRead {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let blocks = t.presentation.as_ref().map(|p| p.blocks.as_slice()).unwrap_or_default();
    let of = |ty: &str| blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some(ty));
    let trail = steps
        .iter()
        .filter_map(|a| match &a.activity {
            Activity::Tool { tool: ToolKind::Run, label, detail, hide, .. } => Some(Trail::Run(match detail {
                Some(d) => masked(d, hide.get("detail")),
                None => masked(label, hide.get("label")),
            })),
            Activity::Tool { tool: ToolKind::Ask, label, hide, .. } => Some(Trail::Ask(masked(label, hide.get("label")))),
            Activity::Tool { tool: ToolKind::Answer, label, hide, .. } => Some(Trail::Answer(masked(label, hide.get("label")))),
            Activity::ToolError { name, text, hide } => Some(Trail::Failed(format!("{name}: {}", masked(text, Some(hide))))),
            _ => None,
        })
        .collect();
    TurnRead {
        prompt: t.prompt.clone(),
        status: serde_json::to_value(t.status).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
        trail,
        hero: of("hero").map(|h| (s(h, "status"), s(h, "title"), s(h, "summary"))),
        question: of("question").map(|q| s(q, "question")).filter(|q| !q.is_empty()),
    }
}

/// The task's turns as read for its digest; the activity only for the turns from `from` (at most the last 6). A
/// turn whose activity runtime refuses is read without it (logged).
async fn read_turns(ctx: &Ctx, call: &wisp_kernel::Call, id: &str, from: usize) -> Result<Vec<TurnRead>, WireError> {
    let sid = SessionId(id.to_owned());
    let list = ctx.run::<r::Turns>(call, r::TurnsArgs { id: sid.clone(), before: None, limit: None, masked: Some(true) }).await?;
    let mut out = Vec::with_capacity(list.len());
    let deep = from.max(list.len().saturating_sub(6));
    for (i, t) in list.iter().enumerate() {
        let steps = if i >= deep {
            let a = r::ActivityArgs { id: sid.clone(), turn_id: t.id.clone(), since_seq: None, masked: Some(true) };
            match ctx.run::<r::ActivityOf>(call, a).await {
                Ok(page) => page.items,
                Err(err) => {
                    tracing::warn!(error = %err.message, task = id, turn = %t.id.as_str(), "learn: runtime.activity");
                    Vec::new()
                }
            }
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
    let s = ctx.run::<r::Get>(&call, r::IdArgs { id: SessionId(id.to_owned()) }).await?;
    if !forced && !s.queue.is_empty() {
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
    let project = project_of(&serde_json::to_value(&s).unwrap_or_default());
    let (global, mine) = {
        let d = lock(&st.data);
        (d.global.clone(), d.projects.get(&project).cloned().unwrap_or_default())
    };
    let name = std::path::Path::new(&project).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let prompt = retro_prompt(&global, &mine, &name, &digest(&turns, from));
    let agent = s.agent.clone();
    let mut run = Retro {
        id: wisp_kernel::ids::uuid7(),
        session_id: id.to_owned(),
        title: s.title.clone(),
        project: project.clone(),
        agent: agent.clone(),
        turns: upto - u32::try_from(from).unwrap_or(0),
        at: now(ctx),
        ..Retro::default()
    };
    let pick = r::RunPick { agent: Some(agent), model: None, effort: None };
    let args = r::QuickArgs { prompt, cwd: s.cwd.clone(), pick: Some(pick), timeout_ms: Some(RETRO_TIMEOUT_MS), json: false, run_id: None };
    let reply = ctx.run::<r::Quick>(&call, args).await;
    let proposal = match &reply {
        Ok(q) => parse_retro(&q.text),
        Err(_) => None,
    };
    let Some(p) = proposal else {
        run.status = "failed".into();
        run.error = Some(match reply {
            Ok(q) => format!(
                "Unreadable reply: {}",
                Some(q.text.as_str()).filter(|t| !t.is_empty()).unwrap_or("(empty)").chars().take(200).collect::<String>()
            ),
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
            run.added.extend(added.into_iter().map(|text| Change { text, kind, scope: scope.into() }));
            run.removed.extend(removed.into_iter().map(|text| Change { text, kind, scope: scope.into() }));
            // the items it adds keep their ranges against its task (it isn't in the history yet)
            st.set(ctx, &key, kind, &next, run.at, Some(&run)).await;
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
    let mut body = serde_json::to_value(run).unwrap_or_default();
    crate::egress::keep_retro(ctx.use_service::<wisp_runtime_api::env::EnvMaskService>().ok().as_deref(), &mut body);
    if let Some(s) = st.store.get()
        && let Err(e) = store::put_retro(s, run, body, dropped, upto).await
    {
        tracing::warn!(error = %e, "learn: saving a retro");
    }
    let mut props = serde_json::Map::new();
    props.insert("agent".into(), json!(run.agent));
    props.insert("ok".into(), json!(run.status != "failed"));
    props.insert("added".into(), json!(run.added.len()));
    props.insert("removed".into(), json!(run.removed.len()));
    if let Err(err) = ctx.run::<tel::Track>(&ctx.root_call(), tel::TrackArgs { event: "retro".into(), props }).await {
        tracing::warn!(error = %err.message, "learn: telemetry.track");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_reads_its_commands_failures_questions_and_report() {
        use wisp_runtime_api::model::Presentation;
        let blocks = vec![
            json!({ "type": "hero", "status": "done", "title": "Build fixed", "summary": "pinned the version" }),
            json!({ "type": "question", "question": "Ship it?" }),
        ];
        let t = Turn {
            prompt: "fix the build".into(),
            status: TurnStatus::Done,
            presentation: Some(Presentation { blocks, v: 1, dropped: Vec::new(), topic: None, notes: None, fallback: false }),
            ..Turn::default()
        };
        let step = |activity| Step { seq: 0, t: 0, activity };
        let tool = |tool, label: &str, detail: Option<&str>| Activity::Tool {
            tool,
            label: label.into(),
            file: None,
            detail: detail.map(str::to_owned),
            call_id: None,
            output: None,
            title: None,
            hide: std::collections::BTreeMap::new(),
        };
        let steps = [
            step(tool(ToolKind::Run, "Run", Some("npm test"))),
            step(Activity::ToolError { name: "bash".into(), text: "3 failed".into(), hide: Vec::new() }),
            step(Activity::Text { text: "thinking aloud".into(), hide: Vec::new() }),
            step(tool(ToolKind::Ask, "Which branch?", None)),
            step(tool(ToolKind::Read, "src/a.rs", None)),
        ];
        let r = turn_read(&t, &steps);
        assert_eq!(
            r.trail,
            vec![Trail::Run("npm test".into()), Trail::Failed("bash: 3 failed".into()), Trail::Ask("Which branch?".into())]
        );
        assert_eq!(r.status, "done");
        assert_eq!(r.hero.as_ref().map(|h| h.1.as_str()), Some("Build fixed"));
        assert_eq!(r.question.as_deref(), Some("Ship it?"));
    }

    #[test]
    fn a_retros_digest_reads_a_tool_errors_and_commands_masked_text_never_the_value() {
        let t = Turn { prompt: "deploy".into(), status: TurnStatus::Done, ..Turn::default() };
        let text = "auth failed for sk-live-123";
        let at = u32::try_from(text.find("sk-").unwrap()).unwrap();
        let cmd = "curl -H 'Bearer sk-live-123' x";
        let c = u32::try_from(cmd.find("sk-").unwrap()).unwrap();
        let steps = [
            Step { seq: 0, t: 0, activity: Activity::ToolError { name: "bash".into(), text: text.into(), hide: vec![[at, at + 11]] } },
            Step {
                seq: 1,
                t: 0,
                activity: Activity::Tool {
                    tool: ToolKind::Run,
                    label: "Run".into(),
                    file: None,
                    detail: Some(cmd.into()),
                    call_id: None,
                    output: None,
                    title: None,
                    hide: [("detail".to_owned(), vec![[c, c + 11]])].into_iter().collect(),
                },
            },
        ];
        let r = turn_read(&t, &steps);
        assert!(!format!("{:?}", r.trail).contains("sk-live-123"), "{:?}", r.trail);
        assert_eq!(r.trail[0], Trail::Failed("bash: auth failed for ••••".into()));
        // ranges that don't fit the text hide all of it (fail closed)
        let bad = [Step { seq: 0, t: 0, activity: Activity::ToolError { name: "bash".into(), text: "short".into(), hide: vec![[2, 99]] } }];
        assert_eq!(turn_read(&t, &bad).trail, vec![Trail::Failed("bash: ••••".into())]);
    }
}
