//! wisp.goal host: a task with a goal keeps going until its judges say it's met (v1 goals: rounds,
//! verdicts, judges, stalls). After each finished turn, each judge (an agent profile or a harness, the
//! goal's own or the `goal` resource's defaults) answers MET or NOT MET in a quick side run; the vote
//! decides: met, another round told what's missing, or past the round limit a question to you. Never
//! for a task's own side runs, and a turn you started yourself after a stall begins the count again.

mod calls;
mod kinds;

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_goal_api::{GoalState, PLUGIN};
use wisp_goal_core::{MAX_ROUNDS, Next, WakeGone, judge_prompt, next, verdict, wake_gone, waits_for_wake};
use calls::{pick_of, put, quick, scheduled, spec_of, state_of, task_of, turns_of, warn_put};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::{Session, TurnStatus};

/// Who the goal's own follow-ups are by.
const BY: &str = "goal";

#[derive(Debug, Default)]
pub struct GoalPlugin;

/// The goal as a task's spec says it, with the defaults under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Goal {
    pub text: String,
    pub judges: Vec<String>,
    pub vote: String,
    pub max_rounds: u32,
    /// its judges run in a sandbox of their own, seeded with the task's folder (ADR-0047: `goal.sandbox`)
    pub sandbox: bool,
}

pub fn goal_of(spec: &Value, d: &kinds::GoalSpec) -> Option<Goal> {
    let g = spec.get("goal")?;
    let text = g.as_str().map(str::to_owned).or_else(|| g.get("text").and_then(Value::as_str).map(str::to_owned)).filter(|t| !t.trim().is_empty())?;
    let list = |v: Option<&Value>| v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).filter(|a| !a.is_empty());
    let judges = list(g.get("judges")).or_else(|| Some(d.judges.clone()).filter(|j| !j.is_empty())).unwrap_or_else(|| vec![spec.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty()).unwrap_or("claude").to_owned()]);
    let vote = g.get("vote").and_then(Value::as_str).map(str::to_owned).or_else(|| Some(d.vote.clone()).filter(|v| !v.is_empty())).unwrap_or_else(|| "majority".into());
    let max_rounds = g.get("maxRounds").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).or(d.max_rounds).unwrap_or(MAX_ROUNDS);
    let sandbox = g.get("sandbox").and_then(Value::as_bool).unwrap_or(false);
    Some(Goal { text, judges, vote, max_rounds, sandbox })
}

/// The goal as it stands: `goal.set`'s text over the spec's; none once it was cleared.
pub fn goal_with(spec: &Value, st: Option<&GoalState>, d: &kinds::GoalSpec) -> Option<Goal> {
    match st {
        Some(s) if s.state == "cleared" => None,
        Some(s) if !s.text.is_empty() => {
            let mut spec = spec.clone();
            let mut goal = spec.get("goal").filter(|g| g.is_object()).cloned().unwrap_or_else(|| json!({}));
            goal["text"] = Value::String(s.text.clone());
            spec["goal"] = goal;
            goal_of(&spec, d)
        }
        _ => goal_of(spec, d),
    }
}

/// `goal.set`: the task's goal set, changed (its count starts again) or cleared.
async fn set(ctx: &Ctx, a: &wisp_goal_api::SetArgs) -> Result<Value> {
    let call = ctx.root_call();
    let task = task_of(ctx, &call, &a.id).await?;
    let text = a.text.trim();
    let st = if text.is_empty() { GoalState { state: "cleared".into(), ..GoalState::default() } } else { GoalState { text: text.to_owned(), ..GoalState::default() } };
    put(ctx, &call, &a.id, &st).await?;
    Ok(view_of(&spec_of(&task), Some(&st), task.created_at, task.updated_at, &kinds::GoalSpec::default()).unwrap_or(Value::Null))
}

/// The new state of a task's goal for pause / resume / drop (pure: the handlers write what this gives).
pub fn moved(st: Option<&GoalState>, to: &str, why: Option<&str>) -> GoalState {
    let mut st = st.cloned().unwrap_or_default();
    match to {
        "paused" => {
            "paused".clone_into(&mut st.state);
            why.unwrap_or_default().clone_into(&mut st.why);
        }
        "cleared" => st = GoalState { state: "cleared".into(), ..GoalState::default() },
        // going again: where it left off, without the pause's note
        _ => {
            st.state.clear();
            st.why.clear();
        }
    }
    st
}

/// `goal.pause` / `goal.resume` / `goal.drop`: the goal's state written, the band's view given back.
async fn move_goal(ctx: &Ctx, a: &wisp_goal_api::TaskArgs, to: &str) -> Result<Value> {
    let call = ctx.root_call();
    let task = task_of(ctx, &call, &a.id).await?;
    let st = moved(state_of(&task).as_ref(), to, a.why.as_deref());
    put(ctx, &call, &a.id, &st).await?;
    Ok(view_of(&spec_of(&task), Some(&st), task.created_at, task.updated_at, &kinds::GoalSpec::default()).unwrap_or(Value::Null))
}

/// `goal.check`: the last finished turn judged now (in the background; the band shows it as it lands).
async fn check_now(ctx: &Ctx, defaults: &kinds::Defaults, id: &str) -> Result<Value> {
    let turns = turns_of(ctx, &ctx.root_call(), id).await?;
    let Some(turn) = turns.iter().rev().find(|t| t.status == TurnStatus::Done).map(|t| t.id.as_str().to_owned()) else {
        return Err(WireError::invalid("No finished turn to check yet."));
    };
    let (c, d, id) = (ctx.clone(), defaults.clone(), id.to_owned());
    ctx.spawn(async move { judge_turn(&c, &d, &id, &turn).await });
    Ok(json!({}))
}

async fn judge(ctx: &Ctx, g: &Goal, task: &Session, answer: &str) -> Vec<wisp_goal_core::Verdict> {
    let cwd = task.cwd.as_str();
    let mut out = Vec::new();
    // judges in a sandbox: one for this task's judges (made once, reused every round), the task's folder in it
    let place = if g.sandbox {
        let a = wisp_sandbox_api::PlaceArgs { owner: json!({ "judges": task.id.as_str() }), cwd: (!cwd.is_empty()).then(|| cwd.to_owned()) };
        match ctx.run::<wisp_sandbox_api::Place>(&ctx.root_call(), a).await {
            Ok(p) => Some((p.machine, p.cwd)),
            Err(e) => return g.judges.iter().map(|j| wisp_goal_core::Verdict { judge: j.clone(), met: false, why: format!("{j} couldn't judge in a sandbox: {}", e.message) }).collect(),
        }
    } else {
        None
    };
    for j in &g.judges {
        let a = rt::QuickArgs { prompt: judge_prompt(&g.text, &task.title, answer), cwd: place.as_ref().map_or(cwd, |p| p.1.as_str()).to_owned(), pick: Some(pick_of(ctx, j).await), timeout_ms: Some(300_000), json: false };
        let said = quick(ctx, place.as_ref().map(|p| p.0.as_str()), a).await;
        out.push(match said {
            Ok(text) => verdict(j, &text),
            Err(e) => wisp_goal_core::Verdict { judge: j.clone(), met: false, why: format!("{j} couldn't judge: {}", e.message) },
        });
    }
    out
}

/// The wake-up a goal waited for went without going (`later.dropped`, v1 goal.js wakeGone): cancelled, the round's
/// report is checked now; otherwise the goal pauses and waits for you.
async fn wake_dropped(ctx: &Ctx, defaults: &kinds::Defaults, e: &wisp_later_api::Dropped) {
    let call = ctx.root_call();
    let Ok(task) = task_of(ctx, &call, &e.session_id).await else { return };
    let mut st = state_of(&task).unwrap_or_default();
    if st.wake.is_empty() || st.wake != e.entry.id {
        return;
    }
    st.wake.clear();
    match wake_gone(&e.why) {
        WakeGone::CheckNow => {
            warn_put(&e.session_id, put(ctx, &call, &e.session_id, &st).await);
            let turns = turns_of(ctx, &call, &e.session_id).await.unwrap_or_default();
            if let Some(last) = turns.last() {
                judge_turn(ctx, defaults, &e.session_id, last.id.as_str()).await;
            }
        }
        WakeGone::Pause => {
            "paused".clone_into(&mut st.state);
            "Its agent’s wake-up didn’t go".clone_into(&mut st.why);
            warn_put(&e.session_id, put(ctx, &call, &e.session_id, &st).await);
        }
    }
}

async fn after(ctx: &Ctx, defaults: &kinds::Defaults, e: &TurnEnded) {
    if e.status != TurnStatus::Done {
        return;
    }
    judge_turn(ctx, defaults, e.session_id.as_str(), e.turn_id.as_str()).await;
}

/// A turn's answer judged against the task's goal: met, another round, or past the limit a question.
async fn judge_turn(ctx: &Ctx, defaults: &kinds::Defaults, id: &str, turn_id: &str) {
    let call = ctx.root_call();
    let Ok(task) = task_of(ctx, &call, id).await else { return };
    if task.parent_id.is_some() {
        return;
    }
    let spec = spec_of(&task);
    let d = defaults.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let mut st = state_of(&task).unwrap_or_default();
    let Some(g) = goal_with(&spec, Some(&st), &d) else { return };
    if matches!(st.state.as_str(), "met" | "paused") {
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
        warn_put(id, put(ctx, &call, id, &st).await);
        return;
    }
    st.wake.clear();
    let answer = last.and_then(|t| t.text.clone()).unwrap_or_default();
    let verdicts = judge(ctx, &g, &task, &answer).await;
    st.rounds += 1;
    st.verdicts = verdicts.iter().map(|v| json!(v)).collect();
    let step = next(&g.vote, &verdicts, st.rounds, g.max_rounds);
    match &step {
        Next::Met => "met".clone_into(&mut st.state),
        Next::Again(_) => "again".clone_into(&mut st.state),
        Next::Stall(why) => {
            "stalled".clone_into(&mut st.state);
            why.clone_into(&mut st.why);
        }
    }
    warn_put(id, put(ctx, &call, id, &st).await);
    // the verdict as a durable fact (ADR-0043: `goal.met` and `goal.failed` start triggers and wake crew)
    match &step {
        Next::Met => ctx.emit(&call, &wisp_goal_api::GoalMet { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds }),
        Next::Stall(why) => ctx.emit(&call, &wisp_goal_api::GoalFailed { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds, why: why.clone() }),
        Next::Again(_) => {}
    }
    let out = match step {
        Next::Met => Ok(()),
        Next::Again(text) => ctx.run::<rt::FollowUp>(&call, rt::FollowUpArgs { id: id.into(), text, by: Some(BY.into()), ..rt::FollowUpArgs::default() }).await.map(|_| ()),
        Next::Stall(q) => ctx.run::<rt::Ask>(&call, rt::AskArgs { id: id.into(), question: q, options: Vec::new(), details: None }).await.map(|_| ()),
    };
    if let Err(err) = out {
        tracing::warn!(task = %id, "goal: {}", err.message);
    }
}

/// What a task's list row says about its goal (`summary.goal`, the GUI's `GoalView`: the band over the task,
/// the list's pill): the goal as its spec has it, where its judging stands (`ext["wisp.goal"]`) and the last
/// round's verdicts. None for a task without a goal.
pub fn view_of(spec: &Value, st: Option<&GoalState>, set_at: i64, at: i64, d: &kinds::GoalSpec) -> Option<Value> {
    let g = goal_with(spec, st, d)?;
    let st = st.cloned().unwrap_or_default();
    let status = match st.state.as_str() {
        "met" => "met",
        "paused" => "paused",
        "stalled" => "out",
        "judging" => "checking",
        _ => "working",
    };
    let met = |v: &Value| v.get("met").and_then(Value::as_bool) == Some(true);
    let checks: Vec<Value> = st.verdicts.iter().map(|v| json!({ "round": st.rounds, "at": at, "verdict": if met(v) { "met" } else { "not_yet" }, "why": v.get("why").and_then(Value::as_str).unwrap_or_default() })).collect();
    let mut view = json!({
        "text": g.text,
        "judges": g.judges.iter().map(|j| json!({ "agent": j, "model": "", "effort": "", "name": j })).collect::<Vec<_>>(),
        "vote": g.vote,
        "status": status,
        "round": st.rounds,
        "setAt": set_at,
        "checks": checks,
    });
    if !st.why.is_empty() {
        view["why"] = Value::String(st.why.clone());
    }
    if !st.verdicts.is_empty() {
        let all_met = st.verdicts.iter().all(met);
        let why = st.verdicts.iter().filter_map(|v| v.get("why").and_then(Value::as_str)).collect::<Vec<_>>().join(" · ");
        let tally = format!("{}/{}", st.verdicts.iter().filter(|v| met(v)).count(), st.verdicts.len());
        view["last"] = json!({ "verdict": if all_met { "met" } else { "not_yet" }, "why": why, "tally": tally });
    }
    Some(view)
}

/// `runtime.summary@1`: the goal on each task's list row.
struct Summary {
    defaults: kinds::Defaults,
}

impl wisp_runtime_api::points::SummaryField for Summary {
    fn plugin(&self) -> &str {
        PLUGIN
    }
    fn fields(&self, session: &wisp_runtime_api::model::Session, _last: Option<&wisp_runtime_api::model::Turn>, out: &mut std::collections::BTreeMap<String, Value>) {
        let spec = session.ext.get("wisp.runtime").and_then(|r| r.get("spec")).cloned().unwrap_or_default();
        let st: Option<GoalState> = session.ext.get(PLUGIN).and_then(|v| serde_json::from_value(v.clone()).ok());
        let d = self.defaults.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if let Some(v) = view_of(&spec, st.as_ref(), session.created_at, session.updated_at, &d) {
            out.insert("goal".into(), v);
        }
    }
}

impl Plugin for GoalPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let defaults = crate::kinds::register(s);
        let summary: Arc<dyn wisp_runtime_api::points::SummaryField> = Arc::new(Summary { defaults: Arc::clone(&defaults) });
        s.contribute(&wisp_runtime_api::points::SUMMARY, summary);
        s.command::<wisp_goal_api::Set, _, _>(|ctx, _call, a| async move { set(&ctx, &a).await });
        s.command::<wisp_goal_api::Pause, _, _>(|ctx, _call, a| async move { move_goal(&ctx, &a, "paused").await });
        s.command::<wisp_goal_api::Resume, _, _>(|ctx, _call, a| async move { move_goal(&ctx, &a, "working").await });
        s.command::<wisp_goal_api::Drop, _, _>(|ctx, _call, a| async move { move_goal(&ctx, &a, "cleared").await });
        let dc = Arc::clone(&defaults);
        s.command::<wisp_goal_api::Check, _, _>(move |ctx, _call, a| {
            let d = dc.clone();
            async move { check_now(&ctx, &d, &a.id).await }
        });
        let d = Arc::clone(&defaults);
        s.on::<TurnEnded, _, _>(move |ctx, e| {
            let (d, e, c) = (d.clone(), e.clone(), ctx.clone());
            ctx.spawn(async move { after(&c, &d, &e).await });
            async {}
        });
        let dw = Arc::clone(&defaults);
        s.on::<wisp_later_api::Dropped, _, _>(move |ctx, e| {
            let (d, e, c) = (dw.clone(), e.clone(), ctx.clone());
            ctx.spawn(async move { wake_dropped(&c, &d, &e).await });
            async {}
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(GoalPlugin.manifest().id, "wisp.goal");
    }

    /// ADR-0047 (new in v2): a goal may ask for its judges in a sandbox; a goal that doesn't, judges here.
    #[test]
    fn a_goal_may_ask_for_its_judges_in_a_sandbox() {
        let d = kinds::GoalSpec::default();
        let boxed = goal_of(&json!({ "goal": { "text": "tests pass", "judges": ["claude"], "sandbox": true } }), &d).unwrap();
        assert!(boxed.sandbox);
        assert!(!goal_of(&json!({ "goal": "tests pass" }), &d).unwrap().sandbox);
    }

    /// The GUI's goal band reads `summary.goal`: a task with a goal says where it stands, judged or not.
    #[test]
    fn goal_summary_shows_where_the_goal_stands() {
        let d = kinds::GoalSpec::default();
        assert_eq!(view_of(&json!({ "prompt": "x" }), None, 1, 2, &d), None, "no goal: no field");
        let spec = json!({ "goal": { "text": "a.txt says hello!" }, "agent": "claude" });
        let fresh = view_of(&spec, None, 10, 20, &d).unwrap_or_default();
        assert_eq!((fresh["text"].clone(), fresh["status"].clone(), fresh["round"].clone(), fresh["setAt"].clone()), (json!("a.txt says hello!"), json!("working"), json!(0), json!(10)));
        assert_eq!(fresh["judges"][0]["name"], "claude");
        let st = GoalState { state: "again".into(), rounds: 2, verdicts: vec![json!({ "judge": "claude", "met": false, "why": "no exclamation mark" })], ..GoalState::default() };
        let again = view_of(&spec, Some(&st), 10, 20, &d).unwrap_or_default();
        assert_eq!((again["round"].clone(), again["checks"][0]["verdict"].clone(), again["last"]["why"].clone(), again["last"]["tally"].clone()), (json!(2), json!("not_yet"), json!("no exclamation mark"), json!("0/1")));
        let met = view_of(&spec, Some(&GoalState { state: "met".into(), rounds: 3, ..GoalState::default() }), 10, 20, &d).unwrap_or_default();
        assert_eq!(met["status"], "met");
        let out = view_of(&spec, Some(&GoalState { state: "stalled".into(), rounds: 5, why: "past 5 rounds".into(), ..GoalState::default() }), 10, 20, &d).unwrap_or_default();
        assert_eq!((out["status"].clone(), out["why"].clone()), (json!("out"), json!("past 5 rounds")));
    }

    /// `goal.set` after the start: its text wins over the spec's and the count starts again; empty clears it.
    #[test]
    fn goal_set_changes_or_clears_the_goal() {
        let d = kinds::GoalSpec::default();
        let spec = json!({ "goal": { "text": "tests pass", "judges": ["reviewer"] } });
        let changed = GoalState { text: "tests and lint pass".into(), ..GoalState::default() };
        let g = goal_with(&spec, Some(&changed), &d).unwrap_or_else(|| unreachable!());
        assert_eq!((g.text.as_str(), g.judges), ("tests and lint pass", vec!["reviewer".to_owned()]), "the judges stay the spec's");
        let set_later = goal_with(&json!({ "agent": "codex" }), Some(&changed), &d).unwrap_or_else(|| unreachable!());
        assert_eq!((set_later.text.as_str(), set_later.judges), ("tests and lint pass", vec!["codex".to_owned()]), "a task without a goal gets one");
        let cleared = GoalState { state: "cleared".into(), ..GoalState::default() };
        assert_eq!(goal_with(&spec, Some(&cleared), &d), None);
        assert_eq!(view_of(&spec, Some(&cleared), 1, 2, &d), None, "the band goes");
        assert_eq!(view_of(&spec, Some(&changed), 1, 2, &d).unwrap_or_default()["status"], "working");
    }

    /// Pause holds the goal with its note (no judging while paused), resume goes on where it was, drop clears it.
    #[test]
    fn goal_pause_resume_and_drop_move_its_state() {
        let d = kinds::GoalSpec::default();
        let spec = json!({ "goal": "tests pass", "agent": "claude" });
        let was = GoalState { state: "again".into(), rounds: 2, ..GoalState::default() };
        let paused = moved(Some(&was), "paused", Some("waiting on the API"));
        assert_eq!((paused.state.as_str(), paused.rounds, paused.why.as_str()), ("paused", 2, "waiting on the API"));
        assert_eq!(view_of(&spec, Some(&paused), 1, 2, &d).unwrap_or_default()["status"], "paused");
        let resumed = moved(Some(&paused), "working", None);
        assert_eq!((resumed.state.as_str(), resumed.rounds, resumed.why.as_str()), ("", 2, ""));
        assert_eq!(view_of(&spec, Some(&resumed), 1, 2, &d).unwrap_or_default()["status"], "working");
        assert_eq!(view_of(&spec, Some(&moved(Some(&resumed), "cleared", None)), 1, 2, &d), None);
    }

    #[test]
    fn the_goal_takes_the_defaults_under_its_own() {
        let d = kinds::GoalSpec { judges: vec!["reviewer".into()], vote: "all".into(), max_rounds: Some(2) };
        assert_eq!(goal_of(&json!({ "agent": "fixer" }), &d), None);
        let g = goal_of(&json!({ "goal": { "text": "tests pass" } }), &d).unwrap_or_else(|| unreachable!());
        assert_eq!((g.judges, g.vote.as_str(), g.max_rounds), (vec!["reviewer".to_owned()], "all", 2));
        let g = goal_of(&json!({ "goal": "ship it", "agent": "fixer" }), &kinds::GoalSpec::default()).unwrap_or_else(|| unreachable!());
        assert_eq!((g.judges, g.max_rounds), (vec!["fixer".to_owned()], MAX_ROUNDS));
    }
}
