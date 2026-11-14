//! One job's own run (v1 crew.js `#jobRun`, `#bodyFor`; #764): a model, level or mode for this job only
//! ("@ada with opus plan: …"), and a harness only when you picked it in wisp's own prompt box (`picked`).
//! A member keeps its harness otherwise: its kit and memory are made for it. Auto picks its own model.

use wisp_crew_api::{Member, RunPick};

use crate::error::Error;

const MODES: [&str; 3] = ["plan", "edits", "auto"];

/// The run a job gets, checked; `None` when it changes nothing. `harness_ok`: a harness id wisp knows.
pub fn job_run(m: &Member, run: Option<&RunPick>, picked: bool, harness_ok: &dyn Fn(&str) -> bool) -> Result<Option<RunPick>, Error> {
    let Some(run) = run else { return Ok(None) };
    let some = |x: &Option<String>| x.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    let (agent, model, effort, mode) = (some(&run.agent), some(&run.model), some(&run.effort), some(&run.mode));
    let swap = agent.as_deref().filter(|a| *a != m.agent);
    if let Some(a) = swap {
        if !picked {
            return Err(Error::Invalid(format!("{} stays on {}: a job can’t change harness.", m.name, m.agent)));
        }
        if a != "auto" && !harness_ok(a) {
            return Err(Error::Invalid(format!("No harness “{}”.", a.chars().take(40).collect::<String>())));
        }
    }
    let on = swap.unwrap_or(&m.agent);
    if on == "auto" && (model.is_some() || effort.is_some()) {
        return Err(Error::Invalid(if swap.is_none() {
            format!("{} is on Auto, which picks the model itself.", m.name)
        } else {
            "Auto picks the model itself.".to_owned()
        }));
    }
    if mode.as_deref().is_some_and(|x| !MODES.contains(&x)) {
        return Err(Error::Invalid("mode must be plan, edits or auto.".into()));
    }
    if effort.as_deref().is_some_and(|e| e.len() > 20 || !e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
        return Err(Error::Invalid("That thinking level isn’t one.".into()));
    }
    let out = RunPick { agent: swap.map(str::to_owned), model: model.map(|x| x.chars().take(120).collect()), effort, mode };
    Ok((out != RunPick::default()).then_some(out))
}

/// What the job's task runs on: `(agent, model, effort, mode)`. Another harness for this job leaves the
/// member's model and level behind (they're the member's harness's).
pub fn job_body(m: &Member, run: Option<&RunPick>) -> (String, String, String, String) {
    let r = run.cloned().unwrap_or_default();
    let own = r.agent.is_none();
    let keep = |pick: Option<String>, mine: &str| pick.unwrap_or_else(|| if own { mine.to_owned() } else { String::new() });
    (
        r.agent.clone().unwrap_or_else(|| m.agent.clone()),
        keep(r.model, &m.model),
        keep(r.effort, &m.effort),
        r.mode.unwrap_or_else(|| m.mode.clone()),
    )
}

/// A job's mode under a lead's cap (v1 `atCap`): never above it (plan < edits < auto); no cap, the job's own.
pub fn at_cap(mode: &str, cap: Option<&str>) -> String {
    let rank = |m: &str| match m {
        "plan" => 0,
        "edits" => 1,
        _ => 2,
    };
    match cap {
        Some(c) if rank(c) < rank(mode) => c.to_owned(),
        _ => mode.to_owned(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ada() -> Member {
        Member {
            name: "Ada".into(),
            agent: "claude".into(),
            model: "opus".into(),
            effort: "high".into(),
            mode: "auto".into(),
            ..Member::default()
        }
    }
    fn pick(agent: &str, model: &str, effort: &str) -> RunPick {
        let s = |x: &str| (!x.is_empty()).then(|| x.to_owned());
        RunPick { agent: s(agent), model: s(model), effort: s(effort), mode: None }
    }

    #[test]
    fn a_launcher_pick_overrides_the_member_for_that_job_only() {
        let m = ada();
        let known = |a: &str| a == "codex" || a == "claude";
        let run = job_run(&m, Some(&pick("codex", "gpt-6", "medium")), true, &known).unwrap();
        assert_eq!(job_body(&m, run.as_ref()), ("codex".into(), "gpt-6".into(), "medium".into(), "auto".into()));
        // another harness with no model: the member's Claude model and level stay behind
        let run = job_run(&m, Some(&pick("codex", "", "")), true, &known).unwrap();
        assert_eq!(job_body(&m, run.as_ref()), ("codex".into(), String::new(), String::new(), "auto".into()));
        // the member itself is untouched: the next job runs on its own setup
        assert_eq!(job_body(&m, None), ("claude".into(), "opus".into(), "high".into(), "auto".into()));
        // the same harness, another model: only the model changes
        let run = job_run(&m, Some(&pick("claude", "fable", "")), true, &known).unwrap();
        assert_eq!(job_body(&m, run.as_ref()), ("claude".into(), "fable".into(), "high".into(), "auto".into()));
    }

    #[test]
    fn a_channel_cant_change_a_members_harness() {
        let m = ada();
        let known = |_: &str| true;
        let e = job_run(&m, Some(&pick("codex", "", "")), false, &known).unwrap_err();
        assert!(e.to_string().contains("can’t change harness"), "{e}");
        assert!(job_run(&m, Some(&pick("", "sonnet", "")), false, &known).unwrap().is_some(), "a model for this job is fine");
        assert!(job_run(&m, Some(&pick("nope", "", "")), true, &|_| false).is_err(), "an unknown harness");
        assert!(job_run(&m, Some(&pick("auto", "opus", "")), true, &known).is_err(), "Auto picks its own model");
        assert!(job_run(&m, Some(&pick("", "", "x y")), true, &known).is_err());
        assert_eq!(job_run(&m, Some(&pick("claude", "", "")), false, &known).unwrap(), None, "its own harness: nothing changes");
    }

    #[test]
    fn a_delegated_job_runs_no_higher_than_its_leads_cap() {
        assert_eq!(at_cap("auto", Some("edits")), "edits");
        assert_eq!(at_cap("plan", Some("edits")), "plan", "a lower mode stays");
        assert_eq!(at_cap("auto", None), "auto");
        assert_eq!(at_cap("edits", Some("plan")), "plan");
    }
}
