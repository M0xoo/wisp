//! wisp.goal host: a task with a goal keeps going until its judges say it's met (v1 goals: rounds,
//! verdicts, judges, stalls). After each finished turn, each judge (an agent profile or a harness, the
//! goal's own or the `goal` resource's defaults) answers MET or NOT MET in a quick side run; the vote
//! decides: met, another round told what's missing, or past the round limit a question to you. Never
//! for a task's own side runs, and a turn you started yourself after a stall begins the count again.

mod calls;
mod judging;
use judging::{after, judge_turn, recover, wake_dropped};
mod kinds;
pub mod runs;
mod slash;

use std::sync::Arc;

use calls::{put, spec_of, state_of, task_of, turns_of};
use serde_json::{Value, json};
use wisp_goal_api::{GoalState, PLUGIN};
use wisp_goal_core::MAX_ROUNDS;
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
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
    let text = g
        .as_str()
        .map(str::to_owned)
        .or_else(|| g.get("text").and_then(Value::as_str).map(str::to_owned))
        .filter(|t| !t.trim().is_empty())?;
    let list = |v: Option<&Value>| {
        v.and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())
            .filter(|a| !a.is_empty())
    };
    let judges = list(g.get("judges"))
        .or_else(|| Some(d.judges.clone()).filter(|j| !j.is_empty()))
        .unwrap_or_else(|| vec![spec.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty()).unwrap_or("claude").to_owned()]);
    let vote = g
        .get("vote")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| Some(d.vote.clone()).filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "majority".into());
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

/// `goal.set`: the task's goal set, changed (its count starts again) or cleared. `kick`: a task whose last turn
/// is done is judged on it now (v1 Goals#set: it may already hold); a running one when its turn ends.
async fn set(ctx: &Ctx, defaults: &kinds::Defaults, a: &wisp_goal_api::SetArgs) -> Result<Value> {
    let call = ctx.root_call();
    let task = task_of(ctx, &call, &a.id).await?;
    let text = a.text.trim();
    if !text.is_empty() {
        refuse_goal_on(&task)?;
    }
    let st = if text.is_empty() {
        GoalState { state: "cleared".into(), ..GoalState::default() }
    } else {
        GoalState { text: text.to_owned(), ..GoalState::default() }
    };
    put(ctx, &call, &a.id, &st).await?;
    if a.kick && !text.is_empty() {
        let turns = turns_of(ctx, &call, &a.id).await.unwrap_or_default();
        if let Some(last) = turns.last().filter(|t| t.status == TurnStatus::Done) {
            let (c, d, id, turn) = (ctx.clone(), defaults.clone(), a.id.clone(), last.id.as_str().to_owned());
            ctx.spawn(async move { judge_turn(&c, &d, &id, &turn).await });
        }
    }
    Ok(view_of(&spec_of(&task), Some(&st), task.created_at, task.updated_at, &kinds::GoalSpec::default()).unwrap_or(Value::Null))
}

/// v1 Goals#set and replyTo: a goal is for a task of your own, never a side discussion's or a subagent's.
pub fn refuse_goal_on(task: &Session) -> Result<()> {
    if task.ext.get("wisp.runtime").and_then(|r| r.get("sideOf")).is_some_and(|v| !v.is_null()) {
        return Err(WireError::conflict("A side discussion only talks the work over: set the goal on the main task."));
    }
    if task.parent_id.is_some() {
        return Err(WireError::conflict("Only a task of your own can have a goal."));
    }
    Ok(())
}

/// v1 Goals#pause / resume / drop: there has to be a goal to move (a typed `/goal drop` says so).
pub fn refuse_no_goal(had: bool, to: &str) -> Result<()> {
    match (had, to) {
        (true, _) => Ok(()),
        (false, "cleared") => Err(WireError::not_found("This task has no goal to drop.")),
        (false, _) => Err(WireError::not_found("This task has no goal.")),
    }
}

/// The new state of a task's goal for pause / resume / drop (pure: the handlers write what this gives).
pub fn moved(st: Option<&GoalState>, to: &str, why: Option<&str>) -> GoalState {
    let mut st = st.cloned().unwrap_or_default();
    match to {
        "paused" => {
            // a round being judged is let go: its runs finish on their records, the goal waits for you
            st.running.clear();
            "paused".clone_into(&mut st.state);
            why.unwrap_or_default().clone_into(&mut st.why);
        }
        "cleared" => st = GoalState { state: "cleared".into(), ..GoalState::default() },
        // going again: where it left off, without the pause's note
        _ => {
            st.state.clear();
            st.why.clear();
            st.running.clear();
        }
    }
    st
}

/// `goal.pause` / `goal.resume` / `goal.drop`: the goal's state written, the band's view given back.
async fn move_goal(ctx: &Ctx, a: &wisp_goal_api::TaskArgs, to: &str) -> Result<Value> {
    let call = ctx.root_call();
    let task = task_of(ctx, &call, &a.id).await?;
    let had = goal_with(&spec_of(&task), state_of(&task).as_ref(), &kinds::GoalSpec::default()).is_some();
    refuse_no_goal(had, to)?;
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
    let said = |v: &Value| if met(v) { "met" } else { "not_yet" };
    let why_of = |v: &Value| v.get("why").and_then(Value::as_str).unwrap_or_default().to_owned();
    // the last round: one check with each judge's vote, each opening its run (v1 goalView checks[].votes)
    let votes: Vec<Value> = st
        .verdicts
        .iter()
        .map(|v| {
            let name = v.get("judge").and_then(Value::as_str).unwrap_or_default();
            let mut vote = json!({ "name": name, "agent": name, "verdict": said(v), "why": why_of(v) });
            if let Some(run) = v.get("run").and_then(Value::as_str) {
                vote["run"] = json!(run);
            }
            vote
        })
        .collect();
    let all_met = !st.verdicts.is_empty() && st.verdicts.iter().all(met);
    let tally = format!("{}/{}", st.verdicts.iter().filter(|v| met(v)).count(), st.verdicts.len());
    let joined = st.verdicts.iter().map(why_of).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" · ");
    let checks: Vec<Value> = if votes.is_empty() {
        Vec::new()
    } else {
        vec![
            json!({ "round": st.rounds, "at": at, "verdict": if all_met { "met" } else { "not_yet" }, "why": joined, "tally": tally, "votes": votes }),
        ]
    };
    let mut view = json!({
        "text": g.text,
        "judges": g.judges.iter().map(|j| json!({ "agent": j, "model": "", "effort": "", "name": j })).collect::<Vec<_>>(),
        "vote": g.vote,
        "status": status,
        "round": st.rounds,
        "setAt": set_at,
        "checks": checks,
    });
    if status == "checking" && !st.running.is_empty() {
        view["running"] = Value::Array(st.running.clone());
    }
    if !st.why.is_empty() {
        view["why"] = Value::String(st.why.clone());
    }
    if !st.verdicts.is_empty() {
        view["last"] = json!({ "verdict": if all_met { "met" } else { "not_yet" }, "why": joined, "tally": tally, "votes": votes });
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
    fn fields(
        &self,
        session: &wisp_runtime_api::model::Session,
        _last: Option<&wisp_runtime_api::model::Turn>,
        out: &mut std::collections::BTreeMap<String, Value>,
    ) {
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
        let ds = Arc::clone(&defaults);
        s.command::<wisp_goal_api::Set, _, _>(move |ctx, _call, a| {
            let d = ds.clone();
            async move { set(&ctx, &d, &a).await }
        });
        crate::slash::register(s);
        let dr = Arc::clone(&defaults);
        s.on_start(|ctx| async move {
            if let Ok(store) = ctx.service::<wisp_store::Store>() {
                runs::install(&store).map_err(|e| WireError::internal(e.to_string()))?;
            }
            // checks a restart cut short: ended, and their goals judged again
            let c = ctx.clone();
            ctx.spawn(async move { recover(&c, &dr).await });
            Ok(())
        });
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
        assert_eq!(
            (fresh["text"].clone(), fresh["status"].clone(), fresh["round"].clone(), fresh["setAt"].clone()),
            (json!("a.txt says hello!"), json!("working"), json!(0), json!(10))
        );
        assert_eq!(fresh["judges"][0]["name"], "claude");
        let st = GoalState {
            state: "again".into(),
            rounds: 2,
            verdicts: vec![json!({ "judge": "claude", "met": false, "why": "no exclamation mark" })],
            ..GoalState::default()
        };
        let again = view_of(&spec, Some(&st), 10, 20, &d).unwrap_or_default();
        assert_eq!(
            (again["round"].clone(), again["checks"][0]["verdict"].clone(), again["last"]["why"].clone(), again["last"]["tally"].clone()),
            (json!(2), json!("not_yet"), json!("no exclamation mark"), json!("0/1"))
        );
        let met =
            view_of(&spec, Some(&GoalState { state: "met".into(), rounds: 3, ..GoalState::default() }), 10, 20, &d).unwrap_or_default();
        assert_eq!(met["status"], "met");
        let out = view_of(
            &spec,
            Some(&GoalState { state: "stalled".into(), rounds: 5, why: "past 5 rounds".into(), ..GoalState::default() }),
            10,
            20,
            &d,
        )
        .unwrap_or_default();
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
        assert_eq!(
            (set_later.text.as_str(), set_later.judges),
            ("tests and lint pass", vec!["codex".to_owned()]),
            "a task without a goal gets one"
        );
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

    /// v1 replyTo / Goals#drop: `/goal …` on a side discussion or a subagent is refused, `/goal drop` without one says so.
    #[test]
    fn a_goal_is_refused_where_v1_refused_it() {
        let mut task = Session::default();
        assert!(refuse_goal_on(&task).is_ok());
        task.ext.insert("wisp.runtime".into(), json!({ "sideOf": { "id": "t0", "title": "Fix login" } }));
        assert!(refuse_goal_on(&task).unwrap_err().message.starts_with("A side discussion only talks the work over"));
        let sub = Session { parent_id: Some("lead".into()), ..Session::default() };
        assert_eq!(refuse_goal_on(&sub).unwrap_err().message, "Only a task of your own can have a goal.");
        assert_eq!(refuse_no_goal(false, "cleared").unwrap_err().message, "This task has no goal to drop.");
        assert_eq!(refuse_no_goal(false, "paused").unwrap_err().message, "This task has no goal.");
        assert!(refuse_no_goal(true, "cleared").is_ok());
    }

    /// A round's result is written only while the goal is still at that round: a goal set, paused, dropped or
    /// judged again meanwhile keeps what was done to it (and one turn is never judged twice at once).
    #[test]
    fn a_rounds_votes_land_only_on_the_round_they_judged() {
        let ids = vec!["r1".to_owned(), "r2".to_owned()];
        let judging =
            GoalState { state: "judging".into(), running: vec![json!({ "run": "r1" }), json!({ "run": "r2" })], ..GoalState::default() };
        assert!(judging::still_ours(&judging, &ids));
        assert!(judging::judging_now(&judging), "a second judge_turn on it stops");
        let set_again = GoalState { text: "X2".into(), ..GoalState::default() };
        assert!(!judging::still_ours(&set_again, &ids), "goal.set meanwhile: its new goal stands");
        assert!(!judging::still_ours(&moved(Some(&judging), "paused", None), &ids), "paused meanwhile");
        let resumed = moved(Some(&moved(Some(&judging), "paused", None)), "working", None);
        assert!(!judging::still_ours(&resumed, &ids) && resumed.running.is_empty(), "paused and resumed meanwhile");
        let other = GoalState { running: vec![json!({ "run": "r9" })], ..judging.clone() };
        assert!(!judging::still_ours(&other, &ids), "another round started meanwhile");
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
