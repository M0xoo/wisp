//! `wisp "<task>" --agent claude --try skills=off` (v1 bin/wisp.js `--try`, server/client.js `tryRuns` /
//! `tryProblem`; F-comp-31, ADR-0056): the task as a trial pair, run B with what `--try` names changed, through
//! `runtime.trial`. What's wrong with the flags is said here, before anything has to start.

use std::time::Duration;

use wisp_kernel::Command;
use wisp_runtime_api::commands::{StartArgs, Trial, TrialArgs, TrialStarted, Variant};

use crate::args::Flags;
use crate::client::{CliError, Client, Result};
use crate::scripted::{self as sc, out};

const USE: &str = "Use --try subagents=haiku|sonnet|task or --try skills=off";

/// What run B changes, from every `--try` (repeatable or comma separated). `subagents=task` is the task's own
/// model (''); anything else is refused with how to write it (v1 `tryRuns`).
pub fn vary(tries: &[String]) -> std::result::Result<Variant, String> {
    let mut v = Variant::default();
    for x in tries.iter().flat_map(|t| t.split(',')).map(str::trim).filter(|x| !x.is_empty()) {
        match x.split_once('=') {
            Some(("subagents", m @ ("haiku" | "sonnet"))) => v.subagent_model = Some(m.to_owned()),
            Some(("subagents", "task")) => v.subagent_model = Some(String::new()),
            Some(("skills", "off")) => v.skills = Some("off".to_owned()),
            _ => return Err(USE.to_owned()),
        }
    }
    if v.is_empty() {
        return Err(USE.to_owned());
    }
    Ok(v)
}

/// Why `--try` can't go with these flags, or None (v1 `tryProblem`; the server refuses the same, later).
pub fn problem(f: &Flags) -> Option<&'static str> {
    if f.agent.as_deref().is_none_or(|a| a.is_empty() || a == "auto") {
        return Some("--try needs --agent: both runs go on one harness, pick it first");
    }
    if f.compare.is_some() {
        return Some("--try is its own comparison: leave out --compare");
    }
    if f.mode.as_deref() == Some("plan") {
        return Some("--try needs edits to compare, so it doesn't run in Plan mode");
    }
    if f.worktree == Some(false) {
        return Some("--try keeps a worktree per run: leave out --no-worktree");
    }
    None
}

/// The typed `runtime.trial` call: run A is the launch as the flags say, run B with `vary` changed.
pub fn trial_args(f: &Flags, prompt: &str, cwd: &str) -> std::result::Result<TrialArgs, String> {
    if let Some(p) = problem(f) {
        return Err(p.to_owned());
    }
    let vary = vary(&f.tries)?;
    let task: StartArgs = serde_json::from_value(sc::launch_args(f, prompt, cwd)).map_err(|e| e.to_string())?;
    Ok(TrialArgs { task, vary })
}

/// Starts the pair and says each run's id (`--wait`: waits for both, A first).
pub async fn launch(c: &Client, f: &Flags, prompt: &str, cwd: &str) -> Result<()> {
    let call = trial_args(f, prompt, cwd).map_err(CliError::said)?;
    let r = c.cmd(Trial::ID, serde_json::to_value(&call).map_err(|e| CliError::said(e.to_string()))?).await?;
    let started: TrialStarted = serde_json::from_value(r.clone()).map_err(|e| CliError::said(e.to_string()))?;
    let differs: Vec<String> = started.differs.iter().map(|d| format!("{} {}", d.key, d.values.join(" → "))).collect();
    if !f.wait {
        let lines: Vec<String> = started
            .runs
            .iter()
            .zip(["A", "B"])
            .map(|(run, name)| format!("  ◌ run {name} launched: {}  wisp attach {}", run.id.as_str(), run.id.as_str()))
            .chain(std::iter::once(format!("  differs: {}", differs.join(", "))))
            .collect();
        out(f, &r, &lines.join("\n"));
        return Ok(());
    }
    for m in &started.runs {
        let id = m.id.as_str();
        if !f.json {
            eprintln!("  ◌ launched: {id} — waiting…");
        }
        let w = sc::wait(c, id, Duration::from_secs(30 * 60)).await?;
        sc::show(c, f, id, Some(w)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flags(agent: Option<&str>, tries: &[&str]) -> Flags {
        let mut f = Flags::defaults(None);
        f.agent = agent.map(str::to_owned);
        f.tries = tries.iter().map(|t| (*t).to_owned()).collect();
        f
    }

    #[test]
    fn try_names_what_run_b_changes_repeatable_or_comma_separated_v1_try_runs() {
        let v = vary(&["subagents=haiku,skills=off".into()]).unwrap();
        assert_eq!((v.subagent_model.as_deref(), v.skills.as_deref()), (Some("haiku"), Some("off")));
        let v = vary(&["subagents=task".into(), "skills=off".into()]).unwrap();
        assert_eq!(v.subagent_model.as_deref(), Some(""), "task: the task's own model");
        for bad in ["skills=on", "subagents=opus", "model=haiku", "haiku", ""] {
            assert_eq!(vary(&[bad.into()]).unwrap_err(), USE, "{bad}");
        }
    }

    #[test]
    fn try_is_refused_before_anything_starts_without_an_agent_with_compare_in_plan_or_in_place_v1_try_problem() {
        assert!(trial_args(&flags(None, &["skills=off"]), "x", "/w").unwrap_err().contains("--agent"));
        assert!(trial_args(&flags(Some("auto"), &["skills=off"]), "x", "/w").unwrap_err().contains("--agent"));
        let mut f = flags(Some("claude"), &["skills=off"]);
        f.compare = Some(Vec::new());
        assert!(trial_args(&f, "x", "/w").unwrap_err().contains("--compare"));
        let mut f = flags(Some("claude"), &["skills=off"]);
        f.mode = Some("plan".into());
        assert!(trial_args(&f, "x", "/w").unwrap_err().contains("Plan"));
        let mut f = flags(Some("claude"), &["skills=off"]);
        f.worktree = Some(false);
        assert!(trial_args(&f, "x", "/w").unwrap_err().contains("--no-worktree"));
    }

    #[test]
    fn the_trial_call_is_the_launch_as_run_a_and_the_change_as_vary_with_yes_kept() {
        let mut f = flags(Some("claude"), &["subagents=sonnet"]);
        f.model = Some("opus".into());
        f.yes = true;
        let a = trial_args(&f, "fix it", "/w").unwrap();
        assert_eq!(
            (a.task.prompt.as_str(), a.task.agent.as_deref(), a.task.model.as_deref(), a.task.cwd.as_deref()),
            ("fix it", Some("claude"), Some("opus"), Some("/w"))
        );
        assert!(a.task.confirm_limit, "--yes reaches both runs");
        assert_eq!(a.vary, Variant { subagent_model: Some("sonnet".into()), skills: None });
        assert_eq!(serde_json::to_value(&a).unwrap()["vary"], json!({ "subagentModel": "sonnet" }));
    }
}
