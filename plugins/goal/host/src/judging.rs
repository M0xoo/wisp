//! A goal's rounds (v1 server/goal.js): after a finished turn each judge answers in a quick side run, recorded as
//! it goes (`runs`); the votes decide met, another round told what's missing, or past the limit a question.

use serde_json::{Value, json};
use wisp_goal_api::GoalState;
use wisp_goal_core::{Next, WakeGone, judge_prompt, next, verdict, waits_for_wake, wake_gone};
use wisp_kernel::Ctx;
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::{Session, TurnStatus};

use crate::calls::{pick_of, put_if, quick, raw, raw_of, scheduled, spec_of, state_of, task_of, turns_of, warn_put};
use crate::inflight::{Inflight, was_cancelled};
use crate::{BY, Goal, goal_with, kinds, runs};

/// Where a round's judging stands: its task, the turn judged, the round's number.
struct Round<'a> {
    task: &'a Session,
    turn_id: &'a str,
    number: u32,
}

pub(crate) fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |k| k.now_ms())
}

/// One judge's quick run, recorded as it starts and as it ends (`runs`): its verdict.
async fn one_judge(
    ctx: &Ctx,
    round: &Round<'_>,
    judge: &str,
    prompt: &str,
    place: Option<&(String, String)>,
    run: &str,
) -> wisp_goal_core::Verdict {
    let pick = pick_of(ctx, judge).await;
    let at = now(ctx);
    let task = round.task.id.as_str();
    let check = runs::Check {
        id: run,
        task,
        turn_id: round.turn_id,
        round: round.number,
        name: judge,
        agent: pick.agent.as_deref().unwrap_or_default(),
        model: pick.model.as_deref().unwrap_or_default(),
        prompt,
        at,
    };
    // its task deleted meanwhile (`session.deleted`): no check starts, no record of it is left
    if !runs::put(ctx, runs::started(&check)).await {
        return wisp_goal_core::Verdict { judge: judge.to_owned(), met: false, why: format!("{judge} didn't judge: the task is gone") };
    }
    let args = rt::QuickArgs {
        prompt: prompt.to_owned(),
        cwd: place.map_or(round.task.cwd.as_str(), |p| p.1.as_str()).to_owned(),
        pick: Some(pick.clone()),
        timeout_ms: Some(300_000),
        json: false,
        run_id: Some(run.to_owned()),
    };
    match quick(ctx, place.map(|p| p.0.as_str()), args).await {
        Ok(out) => {
            let said = verdict(judge, &out.text);
            let activity: Vec<Value> = out.activity.iter().filter_map(|x| serde_json::to_value(x).ok()).collect();
            let ended = runs::Ended::Voted { met: said.met, why: &said.why, text: &out.text, activity: &activity, model: &out.model };
            runs::put(ctx, runs::ended(&check, &ended, now(ctx))).await;
            said
        }
        // stopped as its goal was dropped, set again or its task deleted: no vote, and the record says so
        Err(err) if was_cancelled(&err) => {
            let why = format!("{judge} was stopped: the goal changed while it judged");
            runs::put(ctx, runs::ended(&check, &runs::Ended::Cancelled { why: &why }, now(ctx))).await;
            wisp_goal_core::Verdict { judge: judge.to_owned(), met: false, why }
        }
        Err(err) => {
            let why = format!("{judge} couldn't judge: {}", err.message);
            runs::put(ctx, runs::ended(&check, &runs::Ended::Failed { why: &why }, now(ctx))).await;
            wisp_goal_core::Verdict { judge: judge.to_owned(), met: false, why }
        }
    }
}

/// Each judge's vote on the turn's answer, with the record of its run (`run`: the ids, one per judge, in order).
async fn judge(ctx: &Ctx, live: &Inflight, g: &Goal, r: &Round<'_>, answer: &str, ids: &[String]) -> Vec<wisp_goal_core::Verdict> {
    let task = r.task;
    let cwd = task.cwd.as_str();
    let mut out = Vec::new();
    // judges in a sandbox: one for this task's judges (made once, reused every round), the task's folder in it
    let place = if g.sandbox {
        let a =
            wisp_sandbox_api::PlaceArgs { owner: json!({ "judges": task.id.as_str() }), cwd: (!cwd.is_empty()).then(|| cwd.to_owned()) };
        match ctx.run::<wisp_sandbox_api::Place>(&ctx.root_call(), a).await {
            Ok(p) => Some((p.machine, p.cwd)),
            Err(e) => {
                return g
                    .judges
                    .iter()
                    .map(|j| wisp_goal_core::Verdict {
                        judge: j.clone(),
                        met: false,
                        why: format!("{j} couldn't judge in a sandbox: {}", e.message),
                    })
                    .collect();
            }
        }
    } else {
        None
    };
    let prompt = judge_prompt(&g.text, &task.title, answer);
    for (j, run) in g.judges.iter().zip(ids) {
        // held before the goal is read again: a drop, a new goal or a delete either is seen here or stops this run
        let _held = live.hold(task.id.as_str(), run, place.as_ref().map(|p| p.0.as_str()));
        // dropped, set again, paused or deleted since the round began: no further judge is started for it
        if !fresh_state(ctx, &ctx.root_call(), task.id.as_str()).await.is_some_and(|cur| still_ours(&cur, ids)) {
            break;
        }
        out.push(one_judge(ctx, r, j, &prompt, place.as_ref(), run).await);
    }
    out
}

/// The wake-up a goal waited for went without going (`later.dropped`, v1 goal.js wakeGone): cancelled, the round's
/// report is checked now; otherwise the goal pauses and waits for you.
pub(crate) async fn wake_dropped(ctx: &Ctx, defaults: &kinds::Defaults, live: &Inflight, e: &wisp_later_api::Dropped) {
    let call = ctx.root_call();
    let Ok(task) = task_of(ctx, &call, &e.session_id).await else { return };
    let was = raw_of(&task);
    let mut st = state_of(&task).unwrap_or_default();
    if st.wake.is_empty() || st.wake != e.entry.id {
        return;
    }
    st.wake.clear();
    match wake_gone(&e.why) {
        WakeGone::CheckNow => {
            // a goal moved since it was read (dropped, set again): theirs stands, nothing is checked for it
            if put_if(ctx, &call, &e.session_id, &st, &was).await.is_err() {
                return;
            }
            let turns = turns_of(ctx, &call, &e.session_id).await.unwrap_or_default();
            if let Some(last) = turns.last() {
                judge_turn(ctx, defaults, live, &e.session_id, last.id.as_str()).await;
            }
        }
        WakeGone::Pause => {
            "paused".clone_into(&mut st.state);
            "Its agent’s wake-up didn’t go".clone_into(&mut st.why);
            warn_put(&e.session_id, put_if(ctx, &call, &e.session_id, &st, &was).await);
        }
    }
}

pub(crate) async fn after(ctx: &Ctx, defaults: &kinds::Defaults, live: &Inflight, e: &TurnEnded) {
    if e.status != TurnStatus::Done {
        return;
    }
    judge_turn(ctx, defaults, live, e.session_id.as_str(), e.turn_id.as_str()).await;
}

/// A turn's answer judged against the task's goal: met, another round, or past the limit a question.
pub(crate) async fn judge_turn(ctx: &Ctx, defaults: &kinds::Defaults, live: &Inflight, id: &str, turn_id: &str) {
    let call = ctx.root_call();
    let Ok(task) = task_of(ctx, &call, id).await else { return };
    if task.parent_id.is_some() {
        return;
    }
    let spec = spec_of(&task);
    let d = defaults.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    // every write below is conditional on the slot as read here (or as this round last wrote it), in the write's
    // own transaction: a goal set, paused or dropped meanwhile always wins over this round
    let was = raw_of(&task);
    let mut st = state_of(&task).unwrap_or_default();
    let Some(g) = goal_with(&spec, Some(&st), &d) else { return };
    // met, paused, or a round already being judged (TurnEnded and a kick or Check now on one turn): nothing twice
    if matches!(st.state.as_str(), "met" | "paused") || judging_now(&st) {
        return;
    }
    // a turn you started after a stall: a new count
    let turns = turns_of(ctx, &call, id).await.unwrap_or_default();
    let last = turns.iter().find(|t| t.id.as_str() == turn_id);
    if st.state == "stalled" && last.and_then(|t| t.by.as_deref()) != Some(BY) {
        st.rounds = 0;
    }
    // its agent scheduled its own wake-up this turn: it's waiting, not done; the goal is checked after that turn (v1 #775)
    let started = last.map_or(0, |t| t.started_at);
    if let Some(wake) = waits_for_wake(&scheduled(ctx, id).await, started) {
        st.wake = wake;
        warn_put(id, put_if(ctx, &call, id, &st, &was).await);
        return;
    }
    st.wake.clear();
    let answer = last.and_then(|t| t.text.clone()).unwrap_or_default();
    // checking: the band says so and each judge's run opens while it goes (v1 goalView `running`)
    let ids: Vec<String> = g.judges.iter().map(|_| wisp_kernel::ids::uuid7()).collect();
    "judging".clone_into(&mut st.state);
    st.running = g.judges.iter().zip(&ids).map(|(j, run)| json!({ "run": run, "name": j, "at": now(ctx) })).collect();
    // the goal moved while this read the turns (set, paused, dropped, another round started): theirs stands
    if let Err(err) = put_if(ctx, &call, id, &st, &was).await {
        tracing::debug!(task = %id, "goal: the round isn't started: {}", err.message);
        return;
    }
    let ours = raw(&st);
    let r = Round { task: &task, turn_id, number: st.rounds + 1 };
    let verdicts = judge(ctx, live, &g, &r, &answer, &ids).await;
    st.running.clear();
    st.rounds += 1;
    st.verdicts = verdicts.iter().zip(&ids).map(|(v, run)| json!({ "judge": v.judge, "met": v.met, "why": v.why, "run": run })).collect();
    let step = next(&g.vote, &verdicts, st.rounds, g.max_rounds);
    match &step {
        Next::Met => "met".clone_into(&mut st.state),
        Next::Again(_) => "again".clone_into(&mut st.state),
        Next::Stall(why) => {
            "stalled".clone_into(&mut st.state);
            why.clone_into(&mut st.why);
        }
    }
    // set again, paused, dropped or resumed while it judged (even between a read and this write): the votes stay
    // on their records, the goal where you put it, and nothing follows from them
    if let Err(err) = put_if(ctx, &call, id, &st, &ours).await {
        tracing::debug!(task = %id, "goal: the round's votes are not the goal's any more: {}", err.message);
        return;
    }
    // the verdict as a durable fact (ADR-0043: `goal.met` and `goal.failed` start triggers and wake crew)
    match &step {
        Next::Met => ctx.emit(&call, &wisp_goal_api::GoalMet { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds }),
        Next::Stall(why) => ctx.emit(
            &call,
            &wisp_goal_api::GoalFailed { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds, why: why.clone() },
        ),
        Next::Again(_) => {}
    }
    let out = match step {
        Next::Met => Ok(()),
        Next::Again(text) => ctx
            .run::<rt::FollowUp>(&call, rt::FollowUpArgs { id: id.into(), text, by: Some(BY.into()), ..rt::FollowUpArgs::default() })
            .await
            .map(|_| ()),
        Next::Stall(q) => {
            ctx.run::<rt::Ask>(&call, rt::AskArgs { id: id.into(), question: q, options: Vec::new(), details: None }).await.map(|_| ())
        }
    };
    if let Err(err) = out {
        tracing::warn!(task = %id, "goal: {}", err.message);
    }
}

/// The task's goal state as it is now (None: the task is gone).
async fn fresh_state(ctx: &Ctx, call: &wisp_kernel::Call, id: &str) -> Option<GoalState> {
    task_of(ctx, call, id).await.ok().map(|t| state_of(&t).unwrap_or_default())
}

/// A round is being judged (its judges' runs under way).
pub fn judging_now(st: &GoalState) -> bool {
    st.state == "judging" && !st.running.is_empty()
}

/// The goal is still at the round these runs judge: nothing set, paused, dropped or started another since.
pub fn still_ours(cur: &GoalState, ids: &[String]) -> bool {
    let runs: Vec<&str> = cur.running.iter().filter_map(|r| r.get("run").and_then(Value::as_str)).collect();
    cur.state == "judging" && runs == ids.iter().map(String::as_str).collect::<Vec<_>>()
}

/// After a restart (v1 `interrupted`): checks that were under way never vote; their records say so, and their
/// tasks' goals go back to working and their last answers are judged again.
pub(crate) async fn recover(ctx: &Ctx, defaults: &kinds::Defaults, live: &Inflight) {
    let call = ctx.root_call();
    for id in runs::interrupted(ctx, now(ctx)).await {
        let Ok(task) = task_of(ctx, &call, &id).await else { continue };
        let was = raw_of(&task);
        let Some(mut st) = state_of(&task).filter(|s| s.state == "judging") else { continue };
        st.state.clear();
        st.running.clear();
        if put_if(ctx, &call, &id, &st, &was).await.is_err() {
            continue;
        }
        let turns = turns_of(ctx, &call, &id).await.unwrap_or_default();
        if let Some(last) = turns.last().filter(|t| t.status == TurnStatus::Done) {
            judge_turn(ctx, defaults, live, &id, last.id.as_str()).await;
        }
    }
}
