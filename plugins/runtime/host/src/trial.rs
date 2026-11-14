//! Try it two ways (v1 #650 services/launch.js `checkVariant`, `trialDiffers`; F-comp-31; ADR-0056): a task's
//! variant (the model its subagents run on, Skills off), kept on the task for every turn, and the pair
//! `runtime.trial` starts: what each run is, what differs, why it's refused, and Keep this.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands::{SKILLS, SUBAGENT_MODEL, SUBAGENT_MODELS, StartArgs, TrialArgs, TrialDiff, TrialLink, Variant};
use wisp_runtime_api::model::{Mode, Session};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

const OWN: &str = "wisp.runtime";

/// A start's variant, checked against its harness (`name`, its `HarnessInfo::variants` as `can`): what goes in
/// `ext["wisp.runtime"].variant`, or why it's refused. A variant the harness can't run is refused, never dropped:
/// a dropped one would be two identical paid runs (v1 `checkVariant`).
pub fn checked(a: &StartArgs, name: &str, can: &[String]) -> std::result::Result<Option<Value>, String> {
    let has = |k: &str| can.iter().any(|x| x == k);
    let mut out = Map::new();
    if let Some(m) = &a.subagent_model {
        if !SUBAGENT_MODELS.contains(&m.as_str()) {
            return Err("subagentModel is '' (the task's own model), haiku or sonnet".into());
        }
        if !has(SUBAGENT_MODEL) {
            return Err(format!("{name} can't run its subagents on another model: pick a harness that can, or leave Subagents as it is"));
        }
        out.insert(SUBAGENT_MODEL.into(), json!(m));
    }
    match a.skills.as_deref() {
        None | Some("on") => {}
        Some("off") if has(SKILLS) => {
            out.insert(SKILLS.into(), json!("off"));
        }
        Some("off") => return Err(format!("{name} can't run with its skills off: pick a harness that can, or leave Skills on")),
        Some(_) => return Err("skills is on or off".into()),
    }
    Ok((!out.is_empty()).then_some(Value::Object(out)))
}

/// The variant a task runs with (`ext["wisp.runtime"].variant`), empty when it has none.
pub fn variant_of(s: &Session) -> Variant {
    let v = s.ext.get(OWN).and_then(|o| o.get("variant"));
    let text = |k: &str| v.and_then(|v| v.get(k)).and_then(Value::as_str).map(str::to_owned);
    Variant { subagent_model: text(SUBAGENT_MODEL), skills: text(SKILLS) }
}

/// The trial link a run carries (`ext["wisp.runtime"].trial`), if it is one.
pub fn trial_of(s: &Session) -> Option<TrialLink> {
    s.ext.get(OWN).and_then(|o| o.get("trial")).and_then(|t| serde_json::from_value(t.clone()).ok())
}

/// What a run's subagents really run on: its own pick ('' is the task's model), else the setting.
pub fn subagents_on(own: Option<&str>, setting: &str) -> String {
    own.unwrap_or(if setting == "haiku" || setting == "sonnet" { setting } else { "" }).to_owned()
}

fn skills_word(a: &StartArgs) -> String {
    if a.skills.as_deref() == Some("off") { "off" } else { "on" }.to_owned()
}

/// The two runs of a trial and what differs between them.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub a: StartArgs,
    pub b: StartArgs,
    pub differs: Vec<TrialDiff>,
}

/// v1's refusals, before anything runs: one harness you picked (not Auto), edits to compare (not Plan), a
/// worktree each (a project, not in place, started now: a held start makes no worktree), wisp running it (not a
/// terminal, whose CLI wouldn't apply the change), and run B really different from run A. `setting`:
/// `runtime.subagentModel`, which run A's subagents follow when it names none.
pub fn plan(t: &TrialArgs, setting: &str) -> std::result::Result<Plan, String> {
    let a = &t.task;
    if a.agent.as_deref().is_none_or(|x| x.is_empty() || x == "auto") {
        return Err("Pick a harness first: both runs of Try it two ways go on one harness.".into());
    }
    if t.vary.is_empty() {
        return Err("Say what run B changes: its subagents' model or Skills.".into());
    }
    if a.mode == Some(Mode::Plan) {
        return Err("Try it two ways needs edits to compare, so it doesn't run in Plan.".into());
    }
    if a.cwd.as_deref().is_none_or(|c| c.trim().is_empty()) || a.worktree == Some(false) {
        return Err("Try it two ways needs a project in git: each run keeps its own worktree.".into());
    }
    if a.terminal {
        return Err("Try it two ways runs in wisp: a terminal's CLI wouldn't apply the change.".into());
    }
    if a.hold || a.schedule.is_some() {
        return Err("Try it two ways starts now: each run's worktree is made as it starts.".into());
    }
    let mut a = a.clone();
    a.worktree = Some(true);
    let mut b = a.clone();
    if let Some(m) = &t.vary.subagent_model {
        b.subagent_model = Some(m.clone());
    }
    if let Some(k) = &t.vary.skills {
        b.skills = Some(k.clone());
    }
    let differs: Vec<TrialDiff> = [
        (SUBAGENT_MODEL, subagents_on(a.subagent_model.as_deref(), setting), subagents_on(b.subagent_model.as_deref(), setting)),
        (SKILLS, skills_word(&a), skills_word(&b)),
    ]
    .into_iter()
    .filter(|(_, x, y)| x != y)
    .map(|(key, x, y)| TrialDiff { key: key.into(), values: vec![x, y] })
    .collect();
    if differs.is_empty() {
        return Err("Run B is the same as run A: change its subagents' model or Skills.".into());
    }
    Ok(Plan { a, b, differs })
}

/// Puts the trial link (and its group, which Compare runs reads) in the start's runtime slot.
pub fn link(a: &mut StartArgs, t: &TrialLink) {
    let own = a.ext.entry(OWN.into()).or_insert_with(|| json!({}));
    if !own.is_object() {
        *own = json!({});
    }
    if let Some(o) = own.as_object_mut() {
        o.insert("group".into(), json!(t.group));
        o.insert("trial".into(), json!(t));
    }
}

fn put_trial(s: &mut Session, t: &TrialLink) {
    if let Some(o) = s.ext.get_mut(OWN).and_then(Value::as_object_mut) {
        o.insert("trial".into(), json!(t));
    }
}

impl Runtime {
    /// A start's variant for `ext["wisp.runtime"].variant`, or why it can't run: a terminal task (its own CLI wouldn't
    /// apply it, a `/terminal …` prompt included) or a harness without it (`HarnessInfo::variants`).
    pub(crate) fn variant_slot(self: &Arc<Self>, a: &StartArgs, agent: &str) -> Result<Option<Value>> {
        if a.subagent_model.is_none() && a.skills.is_none() {
            return Ok(None);
        }
        if a.terminal && (a.subagent_model.is_some() || a.skills.as_deref() == Some("off")) {
            return Err(RuntimeError::Invalid(
                "A terminal task runs the harness's own CLI, which wouldn't change its subagents or skills: start it in wisp.".into(),
            ));
        }
        let h = self.harness(agent)?;
        checked(a, &h.info().name, &h.info().variants).map_err(RuntimeError::Invalid)
    }

    /// `runtime.trial`'s plan, with what only the runtime knows: the subagent setting and the harness's variants.
    pub fn trial_plan(self: &Arc<Self>, t: &TrialArgs) -> Result<Plan> {
        let p = plan(t, &self.text_setting("runtime.subagentModel")).map_err(RuntimeError::Invalid)?;
        let h = self.harness(p.a.agent.as_deref().unwrap_or_default())?;
        for run in [&p.a, &p.b] {
            checked(run, &h.info().name, &h.info().variants).map_err(RuntimeError::Invalid)?;
        }
        Ok(p)
    }

    /// Once both runs exist, each lists them (A first), so Keep needs no search.
    pub async fn trial_runs(self: &Arc<Self>, runs: &[SessionId]) -> Result<()> {
        for id in runs {
            self.edit(id.as_str(), |s| {
                if let Some(mut t) = trial_of(s) {
                    t.runs = runs.to_vec();
                    put_trial(s, &t);
                }
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    /// `runtime.trial.keep` (v1 PATCH `trialKept`, Compare's Keep this): every run of the trial says which one
    /// you kept; the others are archived and the kept one isn't. Keeping again, or the other one, says so again.
    /// A sibling deleted meanwhile is skipped.
    pub async fn trial_keep(self: &Arc<Self>, id: &str) -> Result<()> {
        let s = self.repo.session(id).await?;
        let t = trial_of(&s).ok_or_else(|| RuntimeError::Invalid("This task isn't a run of Try it two ways.".into()))?;
        let mut runs = t.runs.clone();
        if !runs.contains(&s.id) {
            runs.push(s.id.clone());
        }
        let kept = s.id.clone();
        // the others stop first: archived out of sight, a working run would go on billing (an agent's Keep too)
        for r in runs.iter().filter(|r| **r != kept) {
            if let Err(e) = self.stop(r.as_str(), false).await {
                tracing::debug!(error = %e, task = r.as_str(), "runtime: trial.keep stop (idle or gone)");
            }
        }
        for r in &runs {
            let mark = |x: &mut Session| {
                if let Some(mut t) = trial_of(x) {
                    t.kept = Some(kept.clone());
                    put_trial(x, &t);
                }
                x.archived = x.id != kept;
                Ok(())
            };
            match self.edit(r.as_str(), mark).await {
                Ok(_) => {}
                Err(e) if r == &kept => return Err(e),
                Err(e) => tracing::warn!(error = %e, task = r.as_str(), "runtime: trial.keep skipped a run"),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn task() -> StartArgs {
        StartArgs { prompt: "fix it".into(), agent: Some("claude".into()), cwd: Some("/repo".into()), ..StartArgs::default() }
    }
    fn vary(m: Option<&str>, k: Option<&str>) -> Variant {
        Variant { subagent_model: m.map(str::to_owned), skills: k.map(str::to_owned) }
    }
    const CAN: [&str; 2] = [SUBAGENT_MODEL, SKILLS];

    #[test]
    fn a_trial_is_run_a_as_given_and_run_b_with_one_setting_changed_both_in_worktrees_v1_try_two_ways() {
        let p = plan(&TrialArgs { task: task(), vary: vary(Some("haiku"), None) }, "").unwrap();
        assert_eq!((p.a.worktree, p.b.worktree), (Some(true), Some(true)), "each run keeps its own worktree");
        assert_eq!((p.a.subagent_model.as_deref(), p.b.subagent_model.as_deref()), (None, Some("haiku")));
        assert_eq!(p.differs, vec![TrialDiff { key: "subagentModel".into(), values: vec![String::new(), "haiku".into()] }]);
        let p = plan(&TrialArgs { task: task(), vary: vary(None, Some("off")) }, "").unwrap();
        assert_eq!(p.differs, vec![TrialDiff { key: "skills".into(), values: vec!["on".into(), "off".into()] }]);
    }

    #[test]
    fn run_as_subagents_follow_the_setting_so_differs_says_what_really_ran_v1_trial_differs() {
        // Settings put subagents on Haiku: run A (no pick) is on Haiku, run B asks for the task's model
        let p = plan(&TrialArgs { task: task(), vary: vary(Some(""), None) }, "haiku").unwrap();
        assert_eq!(p.differs[0].values, vec!["haiku".to_owned(), String::new()]);
        // the same as the setting: nothing differs, refused rather than two identical paid runs
        let same = plan(&TrialArgs { task: task(), vary: vary(Some("haiku"), None) }, "haiku").unwrap_err();
        assert!(same.contains("same as run A"), "{same}");
        let on = plan(&TrialArgs { task: task(), vary: vary(None, Some("on")) }, "").unwrap_err();
        assert!(on.contains("same as run A"), "{on}");
    }

    #[test]
    fn a_trial_is_refused_on_auto_in_plan_without_a_project_in_place_held_or_in_a_terminal_v1_try_refusals() {
        let refused = |f: &dyn Fn(&mut StartArgs)| {
            let mut a = task();
            f(&mut a);
            plan(&TrialArgs { task: a, vary: vary(Some("haiku"), None) }, "").unwrap_err()
        };
        assert!(refused(&|a| a.agent = Some("auto".into())).contains("Pick a harness"));
        assert!(refused(&|a| a.agent = None).contains("Pick a harness"));
        assert!(refused(&|a| a.mode = Some(Mode::Plan)).contains("Plan"));
        assert!(refused(&|a| a.cwd = None).contains("project in git"));
        assert!(refused(&|a| a.worktree = Some(false)).contains("own worktree"));
        assert!(refused(&|a| a.hold = true).contains("starts now"));
        assert!(refused(&|a| a.schedule = Some("tomorrow 9:00".into())).contains("starts now"));
        assert!(refused(&|a| a.terminal = true).contains("terminal"));
        let nothing = plan(&TrialArgs { task: task(), vary: Variant::default() }, "").unwrap_err();
        assert!(nothing.contains("what run B changes"), "{nothing}");
    }

    #[test]
    fn a_variant_a_harness_cant_run_is_refused_by_name_never_dropped_v1_check_variant() {
        let with =
            |m: Option<&str>, k: Option<&str>| StartArgs { subagent_model: m.map(str::to_owned), skills: k.map(str::to_owned), ..task() };
        let can: Vec<String> = CAN.map(str::to_owned).to_vec();
        assert_eq!(
            checked(&with(Some("haiku"), Some("off")), "Claude Code", &can).unwrap(),
            Some(json!({ "subagentModel": "haiku", "skills": "off" }))
        );
        assert_eq!(
            checked(&with(Some(""), None), "Claude Code", &can).unwrap(),
            Some(json!({ "subagentModel": "" })),
            "'' is the task's model, kept"
        );
        assert_eq!(checked(&with(None, Some("on")), "Codex", &[]).unwrap(), None, "Skills on is as usual, anywhere");
        assert_eq!(checked(&task(), "Codex", &[]).unwrap(), None);
        let e = checked(&with(Some("haiku"), None), "Codex", &[]).unwrap_err();
        assert!(e.starts_with("Codex can't run its subagents"), "{e}");
        let e = checked(&with(None, Some("off")), "Codex", &[]).unwrap_err();
        assert!(e.starts_with("Codex can't run with its skills off"), "{e}");
        assert!(checked(&with(Some("opus"), None), "Claude Code", &can).unwrap_err().contains("haiku or sonnet"));
        assert!(checked(&with(None, Some("maybe")), "Claude Code", &can).unwrap_err().contains("on or off"));
    }

    #[test]
    fn the_link_goes_in_runtimes_slot_beside_what_the_caller_put_there() {
        let mut a = StartArgs { ext: [(OWN.to_owned(), json!({ "subagents": [] }))].into(), ..task() };
        let t = TrialLink { group: "g-1".into(), run: 1, ..TrialLink::default() };
        link(&mut a, &t);
        let own = &a.ext[OWN];
        assert_eq!(own["group"], "g-1");
        assert_eq!(own["trial"]["run"], 1);
        assert_eq!(own["subagents"], json!([]), "the caller's own fields stay");
    }
}
