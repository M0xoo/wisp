//! wisp.goal host: a task with a goal keeps going until its judges say it's met (v1 goals: rounds,
//! verdicts, judges, stalls). After each finished turn, each judge (an agent profile or a harness, the
//! goal's own or the `goal` resource's defaults) answers MET or NOT MET in a quick side run; the vote
//! decides: met, another round told what's missing, or past the round limit a question to you. Never
//! for a task's own side runs, and a turn you started yourself after a stall begins the count again.

mod kinds;

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_goal_api::{GoalState, PLUGIN};
use wisp_goal_core::{MAX_ROUNDS, Next, judge_prompt, next, verdict};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup};
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::TurnStatus;

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
}

pub fn goal_of(spec: &Value, d: &kinds::GoalSpec) -> Option<Goal> {
    let g = spec.get("goal")?;
    let text = g.as_str().map(str::to_owned).or_else(|| g.get("text").and_then(Value::as_str).map(str::to_owned)).filter(|t| !t.trim().is_empty())?;
    let list = |v: Option<&Value>| v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).filter(|a| !a.is_empty());
    let judges = list(g.get("judges")).or_else(|| Some(d.judges.clone()).filter(|j| !j.is_empty())).unwrap_or_else(|| vec![spec.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty()).unwrap_or("claude").to_owned()]);
    let vote = g.get("vote").and_then(Value::as_str).map(str::to_owned).or_else(|| Some(d.vote.clone()).filter(|v| !v.is_empty())).unwrap_or_else(|| "majority".into());
    let max_rounds = g.get("maxRounds").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).or(d.max_rounds).unwrap_or(MAX_ROUNDS);
    Some(Goal { text, judges, vote, max_rounds })
}

/// A judge's run: its profile's harness and model, or the harness itself.
async fn pick_of(ctx: &Ctx, judge: &str) -> Value {
    let profiles = ctx.run_json(&ctx.root_call(), "runtime.profiles", json!({})).await.unwrap_or_default();
    let p = profiles.as_array().and_then(|a| a.iter().find(|p| p.get("name").and_then(Value::as_str) == Some(judge)).cloned());
    match p {
        Some(p) => json!({ "agent": p.get("harness"), "model": p.get("model"), "effort": p.get("effort") }),
        None => json!({ "agent": judge }),
    }
}

async fn judge(ctx: &Ctx, g: &Goal, task: &Value, answer: &str) -> Vec<wisp_goal_core::Verdict> {
    let title = task.get("title").and_then(Value::as_str).unwrap_or_default();
    let cwd = task.get("cwd").and_then(Value::as_str).unwrap_or_default();
    let mut out = Vec::new();
    for j in &g.judges {
        let a = json!({ "prompt": judge_prompt(&g.text, title, answer), "cwd": cwd, "pick": pick_of(ctx, j).await, "timeoutMs": 300_000 });
        let said = ctx.run_json(&ctx.root_call(), "runtime.quick", a).await.map(|r| r.get("text").and_then(Value::as_str).unwrap_or_default().to_owned());
        out.push(match said {
            Ok(text) => verdict(j, &text),
            Err(e) => wisp_goal_core::Verdict { judge: j.clone(), met: false, why: format!("{j} couldn't judge: {}", e.message) },
        });
    }
    out
}

async fn after(ctx: &Ctx, defaults: &kinds::Defaults, e: &TurnEnded) {
    if e.status != TurnStatus::Done {
        return;
    }
    let call = ctx.root_call();
    let id = e.session_id.as_str();
    let Ok(task) = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await else { return };
    if task.get("parentId").is_some_and(|p| !p.is_null()) {
        return;
    }
    let spec = task.pointer("/ext/wisp.runtime/spec").cloned().unwrap_or_default();
    let d = defaults.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let Some(g) = goal_of(&spec, &d) else { return };
    let mut st: GoalState = task.pointer("/ext/wisp.goal").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    if st.state == "met" {
        return;
    }
    // a turn you started after a stall: a new count
    let turns = ctx.run_json(&call, "runtime.turns", json!({ "id": id })).await.unwrap_or_default();
    let last = turns.as_array().and_then(|t| t.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(e.turn_id.as_str())).cloned()).unwrap_or_default();
    if st.state == "stalled" && last.get("by").and_then(Value::as_str) != Some(BY) {
        st.rounds = 0;
    }
    let answer = last.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
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
    let _ = ctx.run_json(&call, "runtime.setExt", json!({ "id": id, "plugin": PLUGIN, "value": st })).await;
    // the verdict as a durable fact (ADR-0043: `goal.met` and `goal.failed` start triggers and wake crew)
    match &step {
        Next::Met => ctx.emit(&call, &wisp_goal_api::GoalMet { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds }),
        Next::Stall(why) => ctx.emit(&call, &wisp_goal_api::GoalFailed { session_id: id.to_owned(), goal: g.text.clone(), rounds: st.rounds, why: why.clone() }),
        Next::Again(_) => {}
    }
    let out = match step {
        Next::Met => Ok(Value::Null),
        Next::Again(text) => ctx.run_json(&call, "runtime.followUp", json!({ "id": id, "text": text, "by": BY })).await,
        Next::Stall(q) => ctx.run_json(&call, "runtime.ask", json!({ "id": id, "question": q })).await,
    };
    if let Err(err) = out {
        tracing::warn!(task = %id, "goal: {}", err.message);
    }
}

/// What a task's list row says about its goal (`summary.goal`, the GUI's `GoalView`: the band over the task,
/// the list's pill): the goal as its spec has it, where its judging stands (`ext["wisp.goal"]`) and the last
/// round's verdicts. None for a task without a goal.
pub fn view_of(spec: &Value, st: Option<&GoalState>, set_at: i64, at: i64, d: &kinds::GoalSpec) -> Option<Value> {
    let g = goal_of(spec, d)?;
    let st = st.cloned().unwrap_or_default();
    let status = match st.state.as_str() {
        "met" => "met",
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
        let d = Arc::clone(&defaults);
        s.on::<TurnEnded, _, _>(move |ctx, e| {
            let (d, e, c) = (d.clone(), e.clone(), ctx.clone());
            ctx.spawn(async move { after(&c, &d, &e).await });
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

    /// The GUI's goal band reads `summary.goal`: a task with a goal says where it stands, judged or not.
    #[test]
    fn goal_summary_shows_where_the_goal_stands() {
        let d = kinds::GoalSpec::default();
        assert_eq!(view_of(&json!({ "prompt": "x" }), None, 1, 2, &d), None, "no goal: no field");
        let spec = json!({ "goal": { "text": "a.txt says hello!" }, "agent": "claude" });
        let fresh = view_of(&spec, None, 10, 20, &d).unwrap_or_default();
        assert_eq!((fresh["text"].clone(), fresh["status"].clone(), fresh["round"].clone(), fresh["setAt"].clone()), (json!("a.txt says hello!"), json!("working"), json!(0), json!(10)));
        assert_eq!(fresh["judges"][0]["name"], "claude");
        let st = GoalState { state: "again".into(), rounds: 2, verdicts: vec![json!({ "judge": "claude", "met": false, "why": "no exclamation mark" })], why: String::new() };
        let again = view_of(&spec, Some(&st), 10, 20, &d).unwrap_or_default();
        assert_eq!((again["round"].clone(), again["checks"][0]["verdict"].clone(), again["last"]["why"].clone(), again["last"]["tally"].clone()), (json!(2), json!("not_yet"), json!("no exclamation mark"), json!("0/1")));
        let met = view_of(&spec, Some(&GoalState { state: "met".into(), rounds: 3, ..GoalState::default() }), 10, 20, &d).unwrap_or_default();
        assert_eq!(met["status"], "met");
        let out = view_of(&spec, Some(&GoalState { state: "stalled".into(), rounds: 5, why: "past 5 rounds".into(), ..GoalState::default() }), 10, 20, &d).unwrap_or_default();
        assert_eq!((out["status"].clone(), out["why"].clone()), (json!("out"), json!("past 5 rounds")));
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
