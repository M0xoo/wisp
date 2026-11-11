//! A member asked in a task, and your replies to their answer (v1 crew.js `replyIn`; `POST /sessions/:id/crew-reply`).
//! `crew.ask` keeps an entry under the asking turn (crew's own ext slot on it, `runtime.turn.setExt`) and gives the
//! member a job whose `reply` points at it; the job's report fills the answer in. `crew.reply` threads your reply
//! right after the answer and sends it to the same job as a follow-up, with `reply` now pointing at the new entry.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_crew_api::commands as c;
use wisp_crew_api::{CrewAnswer, JobKind, PLUGIN_ID, ReplyTo, TaskRef, WaitingJob};
use wisp_crew_core::answers::{answers_of, ask_prompt, find, settle, slot_with, thread_reply};
use wisp_kernel::{Call, Ctx, Setup, WireError};

use crate::State;
use crate::jobs::{assign, now};

/// A task's turns as `(turn id, its crew slot)`, in order.
async fn turns_of(ctx: &Ctx, call: &Call, session: &str) -> Result<Vec<(String, Option<Value>)>, WireError> {
    let turns = ctx.run_json(call, "runtime.turns", json!({ "id": session })).await?;
    Ok(turns
        .as_array()
        .map(|a| a.iter().filter_map(|t| Some((t.get("id")?.as_str()?.to_owned(), t.pointer("/ext/wisp.crew").cloned()))).collect())
        .unwrap_or_default())
}

/// Changes the answers on one turn of `session` (the caller holds `st.answering`).
async fn change(ctx: &Ctx, call: &Call, session: &str, turn: &str, f: impl FnOnce(&mut Vec<CrewAnswer>) -> bool) -> Result<bool, WireError> {
    let turns = turns_of(ctx, call, session).await?;
    let slot = turns.iter().find(|(t, _)| t == turn).and_then(|(_, s)| s.clone());
    let mut list = answers_of(slot.as_ref());
    if !f(&mut list) {
        return Ok(false);
    }
    let value = slot_with(slot.as_ref(), &list);
    ctx.run_json(call, "runtime.turn.setExt", json!({ "id": session, "turnId": turn, "plugin": PLUGIN_ID, "value": value })).await?;
    Ok(true)
}

/// The job answering `r` started: the entry names it, so a reply can carry it on.
pub(crate) async fn started(ctx: &Ctx, call: &Call, st: &State, r: &ReplyTo, job: &str) {
    let _g = st.answering.lock().await;
    if let Err(e) = change(ctx, call, &r.session_id, &r.turn_id, |l| wisp_crew_core::answers::started(l, &r.entry_id, job)).await {
        tracing::warn!(task = %r.session_id, error = %e.message, "a crew answer's job isn't kept on it");
    }
}

/// A job reported: if it answers a message in another task, its answer goes there.
pub(crate) async fn answered(ctx: &Ctx, call: &Call, st: &State, job: &str, text: &str, failed: bool) {
    let Ok(s) = ctx.run_json(call, "runtime.get", json!({ "id": job })).await else { return };
    let Some(r) = s.pointer("/ext/wisp.crew/reply").and_then(|v| serde_json::from_value::<ReplyTo>(v.clone()).ok()) else { return };
    let at = now(ctx);
    let _g = st.answering.lock().await;
    if let Err(e) = change(ctx, call, &r.session_id, &r.turn_id, |l| settle(l, &r.entry_id, text, failed, at)).await {
        tracing::warn!(task = %r.session_id, error = %e.message, "a crew answer isn't kept under its question");
    }
}

/// The entry went wrong before a job could take it: say why on it.
async fn failed(ctx: &Ctx, call: &Call, st: &State, session: &str, turn: &str, entry: &str, why: &str) {
    let at = now(ctx);
    let _g = st.answering.lock().await;
    let _ = change(ctx, call, session, turn, |l| settle(l, entry, why, true, at)).await;
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let ask = st.clone();
    s.command::<c::Ask, _, _>(move |ctx, call, a| {
        let st = ask.clone();
        async move {
            let m = st.member(&a.id)?;
            let question = a.text.trim().to_owned();
            if question.is_empty() {
                return Err(WireError::invalid("Type your question first."));
            }
            let task = ctx.run_json(&call, "runtime.get", json!({ "id": a.session_id })).await?;
            let title = task.get("title").and_then(Value::as_str).unwrap_or_default().to_owned();
            let entry = CrewAnswer { id: wisp_kernel::ids::uuid7(), crew: m.id.clone(), member: m.name.clone(), question: question.clone(), status: "running".into(), asked_at: now(&ctx), ..CrewAnswer::default() };
            let turn = {
                let _g = st.answering.lock().await;
                let turns = turns_of(&ctx, &call, &a.session_id).await?;
                let turn = match &a.turn_id {
                    Some(t) if turns.iter().any(|(x, _)| x == t) => t.clone(),
                    Some(_) => return Err(WireError::not_found("That message isn't on the task.")),
                    None => turns.last().map(|(t, _)| t.clone()).ok_or_else(|| WireError::invalid("That task has no message to answer under yet."))?,
                };
                let e = entry.clone();
                change(&ctx, &call, &a.session_id, &turn, move |l| {
                    l.push(e);
                    true
                })
                .await?;
                turn
            };
            let reply = ReplyTo { session_id: a.session_id.clone(), turn_id: turn.clone(), entry_id: entry.id.clone() };
            let w = WaitingJob { prompt: ask_prompt(&title, &question), job: JobKind::Task, from: Some(TaskRef { id: a.session_id.clone(), title }), reply: Some(reply), ..WaitingJob::default() };
            match assign(&ctx, &call, &st, &m, w).await {
                Ok(out) => {
                    let job = out.session.as_ref().and_then(|s| s.get("id")).and_then(Value::as_str).map(str::to_owned);
                    Ok(CrewAnswer { job, ..entry })
                }
                Err(e) => {
                    failed(&ctx, &call, &st, &a.session_id, &turn, &entry.id, &e.message).await;
                    Err(e)
                }
            }
        }
    });
    let rep = st.clone();
    s.command::<c::Reply, _, _>(move |ctx, call, a| {
        let st = rep.clone();
        async move {
            let text = a.text.trim().to_owned();
            if text.is_empty() {
                return Err(WireError::invalid("Type your reply first."));
            }
            let gone = || WireError::not_found("They’re no longer on your crew.");
            let (turn, entry, job) = {
                let _g = st.answering.lock().await;
                let turns = turns_of(&ctx, &call, &a.session_id).await?;
                let (turn, parent) = find(turns.iter().map(|(t, s)| (t.as_str(), s.as_ref())), &a.entry).ok_or_else(gone)?;
                let m = st.member(&parent.crew).map_err(|_| gone())?;
                let job = parent.job.clone().ok_or_else(|| WireError::conflict(format!("{} hasn’t started on it yet.", m.name)))?;
                let (id, at) = (wisp_kernel::ids::uuid7(), now(&ctx));
                let mut made = None;
                change(&ctx, &call, &a.session_id, &turn, |l| {
                    made = thread_reply(l, &parent.id, id, text.clone(), at);
                    made.is_some()
                })
                .await?;
                (turn, made.ok_or_else(gone)?, job)
            };
            // the same job carries on; its next answer lands under this reply
            let carried = async {
                let s = ctx.run_json(&call, "runtime.get", json!({ "id": job })).await.map_err(|_| WireError::not_found("That job is gone."))?;
                let mut ext = s.pointer("/ext/wisp.crew").cloned().unwrap_or_else(|| json!({}));
                ext["reply"] = json!(ReplyTo { session_id: a.session_id.clone(), turn_id: turn.clone(), entry_id: entry.id.clone() });
                ctx.run_json(&call, "runtime.setExt", json!({ "id": job, "plugin": PLUGIN_ID, "value": ext })).await?;
                ctx.run_json(&call, "runtime.followUp", json!({ "id": job, "text": text, "queue": true, "by": "crew" })).await
            };
            match carried.await {
                Ok(_) => Ok(entry),
                Err(e) => {
                    failed(&ctx, &call, &st, &a.session_id, &turn, &entry.id, &e.message).await;
                    Err(e)
                }
            }
        }
    });
}
