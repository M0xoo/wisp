//! Task specs and what made a task (ADR-0027, ADR-0029), around `runtime.create`:
//!
//! - **Profiles**: named agents (`agents:` in a formula) in `runtime_profile`. `agent: reviewer` (or an
//!   inline `profile`) fills the harness, model, effort and mode a task didn't set itself: flags beat
//!   the spec, the spec beats the profile.
//! - **Base**: the commit, branch and origin a task starts from, recorded at start. A `base.sha` that
//!   isn't HEAD (a rerun from the same code) runs in a detached worktree of that commit.
//! - **Snapshot**: the effective formula (the resolved profile, crew, team, connectors, the overlay it
//!   was given), stored once by content hash in `runtime_formula`; secrets stay references.
//! - **Spec**: kept in the task's `ext["wisp.runtime"].spec`; its steps are read back from the turns.
//!
//! Applying or pruning a formula never touches any of it: a task's history is data.

use serde_json::{Map, Value, json};
use wisp_kernel::{Result, WireError};
use wisp_proc::{ExecOpts, Proc};
use wisp_runtime_api::commands::StartArgs;
use wisp_runtime_api::model::{Mode, Session, Turn};
use wisp_runtime_api::spec::{AgentSpec, Base, Profile, Snapshot, TaskSpec};
use wisp_store::{Query, Row, Store};

use crate::schema::{FORMULA, PROFILE};

#[allow(clippy::needless_pass_by_value)] // for map_err
fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::internal(format!("store: {e}"))
}

pub async fn profiles(store: &Store) -> Result<Vec<Profile>> {
    let rows = store.read_async(|r| r.query(PROFILE.kind, &Query::new())).await.map_err(store_err)?;
    let mut out: Vec<Profile> = rows.into_iter().filter_map(|r| serde_json::from_value(r.get("body")?.clone()).ok()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn profile(store: &Store, name: &str) -> Result<Option<Profile>> {
    let n = name.to_owned();
    let row = store.read_async(move |r| r.get(PROFILE.kind, n.as_str())).await.map_err(store_err)?;
    Ok(row.and_then(|r| serde_json::from_value(r.get("body")?.clone()).ok()))
}

fn named(name: &str) -> Result<()> {
    let ok = !name.trim().is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c));
    if ok { Ok(()) } else { Err(WireError::invalid(format!("a profile's name is letters, digits, - _ . (not {name:?})"))) }
}

pub async fn set_profile(store: &Store, p: Profile) -> Result<Profile> {
    named(&p.name)?;
    let body = serde_json::to_value(&p).map_err(|e| WireError::internal(e.to_string()))?;
    let id = p.name.clone();
    store
        .write(move |w| {
            let mut r = Row::new();
            r.insert("id".into(), json!(id));
            r.insert("body".into(), body);
            w.upsert(PROFILE.kind, r).map(|_| ())
        })
        .await
        .map_err(store_err)?;
    Ok(p)
}

pub async fn remove_profile(store: &Store, name: &str) -> Result<()> {
    let n = name.to_owned();
    store.write(move |w| w.del(PROFILE.kind, n.as_str()).map(|_| ())).await.map_err(store_err)
}

async fn git(proc: &Proc, cwd: &str, args: &[&str]) -> Option<String> {
    let opts = ExecOpts { cwd: Some(cwd.into()), timeout: Some(std::time::Duration::from_secs(10)), ..ExecOpts::default() };
    let r = proc.exec("git", &args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>(), opts).await.ok()?;
    r.exit.success().then(|| r.stdout_text().trim().to_owned()).filter(|s| !s.is_empty())
}

/// The code at `cwd`: HEAD, its branch and the origin. None outside a repo with commits.
pub async fn base_at(proc: &Proc, cwd: &str) -> Option<Base> {
    let sha = git(proc, cwd, &["rev-parse", "HEAD"]).await?;
    let branch = git(proc, cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap_or_default();
    let repo = git(proc, cwd, &["config", "--get", "remote.origin.url"]).await.unwrap_or_default();
    Some(Base { repo, sha, branch, worktree: String::new() })
}

fn mode_of(s: &str) -> Option<Mode> {
    serde_json::from_value(json!(s)).ok()
}

/// Content hash of a JSON value (its keys are already sorted, so the text is canonical).
fn hash(v: &Value) -> String {
    blake3::hash(v.to_string().as_bytes()).to_hex()[..16].to_owned()
}

/// The profile a task runs with: given inline, named, or (nothing named) the `default` one; its values
/// fill what the args left out.
async fn resolve(store: &Store, a: &mut StartArgs, asked: &str) -> Result<Option<(String, AgentSpec)>> {
    // a profile: given inline, named, or (nothing named) the `default` one
    let stored = if a.profile.is_some() {
        None
    } else if !asked.is_empty() && asked != "auto" {
        profile(store, asked).await?
    } else {
        profile(store, "default").await?
    };
    let resolved: Option<(String, AgentSpec)> = a.profile.clone().map(|p| (asked.to_owned(), p)).or_else(|| stored.map(|p| (p.name, p.spec)));
    if let Some((_, p)) = &resolved {
        if !p.harness.is_empty() {
            a.agent = Some(p.harness.clone());
        }
        let fill = |x: &mut Option<String>, v: &str| {
            if x.as_deref().is_none_or(str::is_empty) && !v.is_empty() {
                *x = Some(v.to_owned());
            }
        };
        fill(&mut a.model, &p.model);
        fill(&mut a.effort, &p.effort);
        fill(&mut a.account, &p.account);
        if a.mode.is_none() {
            a.mode = mode_of(&p.mode);
        }
        if a.connectors.is_empty() {
            a.connectors.clone_from(&p.connectors);
        }
    }
    Ok(resolved)
}

/// What `prepare` made of the args.
#[derive(Debug, Default)]
pub struct Prepared {
    pub args: StartArgs,
    pub steps: Vec<String>,
}

/// Resolves the profile, records the base (a worktree for an older commit), stores the snapshot and puts
/// the spec on the task's ext. `home` is wisp's folder (for rerun worktrees).
pub async fn prepare(store: &Store, proc: &Proc, home: Option<&std::path::Path>, mut a: StartArgs) -> Result<Prepared> {
    let asked = a.agent.clone().unwrap_or_default();
    // the spec keeps what was asked; the profile's values fill the task, not the spec (ADR-0029:
    // flags > the spec's own fields > the formula's profile, so a rerun under another formula re-resolves)
    let (asked_model, asked_effort, asked_mode) = (a.model.clone().unwrap_or_default(), a.effort.clone().unwrap_or_default(), a.mode);
    let project = a.cwd.clone().unwrap_or_default();
    let resolved = resolve(store, &mut a, &asked).await?;
    // the code it starts from
    let cwd = a.cwd.clone().unwrap_or_default();
    let mut base = if cwd.is_empty() { None } else { base_at(proc, &cwd).await };
    if let (Some(want), Some(have)) = (a.base.clone().filter(|b| !b.sha.is_empty()), base.clone())
        && !have.sha.starts_with(&want.sha)
    {
        let dir = home.map_or_else(std::env::temp_dir, |h| h.join("worktrees")).join(format!("rerun-{}-{}", &want.sha[..want.sha.len().min(10)], &wisp_kernel::ids::uuid7()[24..]));
        let path = dir.display().to_string();
        let made = git(proc, &cwd, &["worktree", "add", "--detach", &path, &want.sha]).await.is_some() || dir.join(".git").exists();
        if !made {
            return Err(WireError::invalid(format!("couldn't check out {} in {cwd}: is that commit in this repo? (--from latest runs on today's code)", want.sha)));
        }
        base = Some(Base { sha: git(proc, &path, &["rev-parse", "HEAD"]).await.unwrap_or(want.sha), worktree: path.clone(), ..have });
        a.cwd = Some(path);
    }
    // the effective formula, once per content
    let mut formula = Map::new();
    if let Some((name, p)) = &resolved {
        let mut o = serde_json::to_value(p).unwrap_or_default();
        o["name"] = json!(if name.is_empty() { "inline" } else { name.as_str() });
        formula.insert("agents".into(), json!([o]));
    }
    if let Some(Value::Object(overlay)) = &a.formula {
        for (k, v) in overlay {
            formula.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    if let Some(c) = &a.crew {
        formula.insert("crewMember".into(), json!(c));
    }
    if let Some(t) = &a.team {
        formula.insert("team".into(), t.clone());
    }
    if !a.connectors.is_empty() {
        formula.insert("connectors".into(), json!(a.connectors));
    }
    let snapshot = Value::Object(formula);
    let h = hash(&snapshot);
    let (hid, body) = (h.clone(), snapshot);
    store
        .write(move |w| {
            if w.get(FORMULA.kind, hid.as_str())?.is_none() {
                let mut r = Row::new();
                r.insert("id".into(), json!(hid));
                r.insert("body".into(), body);
                r.insert("created_at".into(), json!(w.now()));
                w.upsert(FORMULA.kind, r)?;
            }
            Ok(())
        })
        .await
        .map_err(store_err)?;
    let spec = TaskSpec {
        prompt: a.prompt.clone(),
        steps: Vec::new(),
        agent: asked,
        model: asked_model,
        effort: asked_effort,
        mode: asked_mode.map(|m| serde_json::to_value(m).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()).unwrap_or_default(),
        cwd: project,
        dirs: a.dirs.clone(),
        base,
        worktree: a.worktree,
        goal: a.goal.clone(),
        crew: a.crew.clone(),
        team: a.team.clone(),
        connectors: a.connectors.clone(),
        schedule: a.schedule.clone(),
        formula: Some(h),
        lineage: a.lineage.clone(),
    };
    let mut own = match a.ext.remove("wisp.runtime") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    own.insert("spec".into(), serde_json::to_value(&spec).unwrap_or_default());
    a.ext.insert("wisp.runtime".into(), Value::Object(own));
    let steps = std::mem::take(&mut a.steps);
    Ok(Prepared { args: a, steps })
}

/// A task's spec: what was stored at start, its steps read back from the turns the user (or a step)
/// sent. A task from before specs gets one made from its session and turns.
pub fn spec_of(s: &Session, turns: &[Turn]) -> TaskSpec {
    let mut spec: TaskSpec = s.ext.get("wisp.runtime").and_then(|m| m.get("spec")).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_else(|| TaskSpec {
        agent: s.agent.clone(),
        model: s.model.clone(),
        effort: s.effort.clone(),
        cwd: s.cwd.clone(),
        dirs: s.dirs.clone(),
        ..TaskSpec::default()
    });
    let mut prompts = turns.iter().filter(|t| t.by.as_deref().is_none_or(|b| b == "user" || b == "step")).map(|t| t.prompt.clone());
    if let Some(first) = prompts.next()
        && spec.prompt.is_empty()
    {
        spec.prompt = first;
    }
    spec.steps = prompts.collect();
    if let Some(f) = s.ext.get("wisp.runtime").and_then(|m| m.get("forkOf")).and_then(|f| f.get("id")).and_then(Value::as_str) {
        spec.lineage.fork_of = Some(f.to_owned());
    }
    spec
}

pub async fn snapshot(store: &Store, hash: &str) -> Result<Snapshot> {
    let h = hash.to_owned();
    let row = store.read_async(move |r| r.get(FORMULA.kind, h.as_str())).await.map_err(store_err)?;
    let Some(row) = row else { return Err(WireError::not_found(format!("no formula snapshot {hash}"))) };
    Ok(Snapshot { hash: hash.to_owned(), formula: row.get("body").cloned().unwrap_or_default() })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_same_formula_hashes_the_same() {
        let a = json!({ "agents": [{ "name": "reviewer", "harness": "codex" }], "connectors": ["linear"] });
        let b: Value = serde_json::from_str(&a.to_string()).unwrap();
        assert_eq!(hash(&a), hash(&b));
        assert_ne!(hash(&a), hash(&json!({ "agents": [] })));
    }

    #[test]
    fn a_task_from_before_specs_gets_one_from_its_turns() {
        let s = Session { agent: "claude".into(), cwd: "/w".into(), ..Session::default() };
        let t = |p: &str, by: Option<&str>| Turn { prompt: p.into(), by: by.map(str::to_owned), ..Turn::default() };
        let spec = spec_of(&s, &[t("fix it", None), t("check", Some("wisp")), t("now the tests", None)]);
        assert_eq!((spec.prompt.as_str(), spec.steps.as_slice(), spec.agent.as_str()), ("fix it", &["now the tests".to_owned()][..], "claude"));
    }
}
