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
use wisp_runtime_api::spec::{AgentSpec, Base, HistoryArgs, HistoryRow, Profile, Snapshot, TaskSpec};
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

/// A profile renamed in place: one write moves its row (and its name inside), refusing a taken name.
pub async fn rename_profile(store: &Store, from: &str, to: &str) -> Result<Profile> {
    named(to)?;
    let (f, t) = (from.to_owned(), to.to_owned());
    let moved = store
        .write(move |w| {
            if w.get(PROFILE.kind, t.as_str())?.is_some() {
                return Ok(Err(format!("an agent named {t} exists already")));
            }
            let Some(row) = w.get(PROFILE.kind, f.as_str())? else { return Ok(Err(format!("no agent named {f}"))) };
            let mut body = row.get("body").cloned().unwrap_or_default();
            body["name"] = json!(t);
            let mut r = Row::new();
            r.insert("id".into(), json!(t));
            r.insert("body".into(), body.clone());
            w.upsert(PROFILE.kind, r)?;
            w.del(PROFILE.kind, f.as_str())?;
            Ok(Ok(body))
        })
        .await
        .map_err(store_err)?
        .map_err(WireError::conflict)?;
    serde_json::from_value(moved).map_err(|e| WireError::internal(e.to_string()))
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
/// A section's `(name, spec)` from a task's formula overlay (`wisp run --formula`, a list or a map).
fn overlay(a: &StartArgs, section: &str) -> Vec<(String, Value)> {
    match a.formula.as_ref().and_then(|f| f.get(section)) {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|x| {
                let mut o = x.as_object()?.clone();
                let n = o.remove("name")?.as_str()?.to_owned();
                Some((n, Value::Object(o)))
            })
            .collect(),
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => Vec::new(),
    }
}

/// The overlay's specs of a kind, then the stored ones it doesn't name (the overlay wins, for this task).
async fn specs_of(a: &StartArgs, section: &str, stored: Option<&std::sync::Arc<wisp_resources_api::StoredKind>>) -> Vec<(String, Value)> {
    let mut out = overlay(a, section);
    if let Some(k) = stored {
        for (n, v) in k.specs().await.unwrap_or_default() {
            if !out.iter().any(|(m, _)| *m == n) {
                out.push((n, v));
            }
        }
    }
    out
}

/// What the stored kinds do to a task as it starts (`crate::kinds`): its project's agent, worktree and
/// instructions (its setup runs in a fresh worktree: `project_setup`); its harness's switch and defaults; its team; its skills. Returns the brief.
async fn act(kinds: Option<&crate::kinds::Kinds>, a: &mut StartArgs, profile: Option<&AgentSpec>) -> Result<Value> {
    let cwd = a.cwd.clone().unwrap_or_default();
    let projects = specs_of(a, "projects", kinds.map(|k| &k.project)).await;
    let project = crate::kinds::project_for(&projects, &cwd);
    // the harness: off refuses it; its defaults fill what's left
    let harnesses = specs_of(a, "harnesses", kinds.map(|k| &k.harness)).await;
    let harness = a.agent.clone().unwrap_or_default();
    let mut bin = None;
    if let Some((_, h)) = harnesses.iter().find(|(n, _)| *n == harness) {
        let h: crate::kinds::HarnessSpec = serde_json::from_value(h.clone()).unwrap_or_default();
        if h.enabled == Some(false) {
            return Err(WireError::invalid(format!("{harness} is off (harnesses: {harness}: {{ enabled: false }})")));
        }
        if a.model.as_deref().is_none_or(str::is_empty) && !h.model.is_empty() {
            a.model = Some(h.model.clone());
        }
        if a.effort.as_deref().is_none_or(str::is_empty) && !h.effort.is_empty() {
            a.effort = Some(h.effort.clone());
        }
        if h.from == "path" && !h.path.is_empty() {
            bin = Some(h.path.clone());
        }
    }
    // a team the task names: its subagents (on the task, and in its system prompt)
    let mut team_brief = Vec::new();
    if let Some(Value::String(t)) = a.team.clone() {
        let teams = specs_of(a, "teams", kinds.map(|k| &k.team)).await;
        let Some((_, spec)) = teams.into_iter().find(|(n, _)| *n == t) else {
            return Err(WireError::invalid(format!("no team named {t} (teams: in a formula)")));
        };
        let team: crate::kinds::TeamSpec = serde_json::from_value(spec).unwrap_or_default();
        let subs: Vec<Value> = team.members.iter().map(|(n, m)| json!({ "name": n, "agent": m.agent, "count": m.count, "why": m.why })).collect();
        let mut own = match a.ext.remove("wisp.runtime") {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        own.insert("subagents".into(), Value::Array(subs.clone()));
        team_brief = subs;
        a.ext.insert("wisp.runtime".into(), Value::Object(own));
    }
    // the brief: the project's instructions, the agent's, its skills
    let mut skills = Vec::new();
    if let Some(p) = profile.filter(|p| !p.skills.is_empty()) {
        let all = specs_of(a, "skills", kinds.map(|k| &k.skill)).await;
        for want in &p.skills {
            let Some((n, spec)) = all.iter().find(|(n, _)| n == want) else { continue };
            let k: crate::kinds::SkillSpec = serde_json::from_value(spec.clone()).unwrap_or_default();
            let body = if k.body.is_empty() && !k.path.is_empty() {
                let file = if std::path::Path::new(&k.path).extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) { k.path.clone() } else { format!("{}/SKILL.md", k.path.trim_end_matches('/')) };
                tokio::fs::read_to_string(&file).await.unwrap_or_default()
            } else {
                k.body.clone()
            };
            skills.push(json!({ "name": n, "description": k.description, "body": body }));
        }
    }
    // a project that declares its trust: without hooks or MCP servers trusted, the harness skips them
    let untrusted = project.as_ref().and_then(|(_, p)| p.trust.as_ref()).is_some_and(|t| !t.hooks && t.mcp.is_empty());
    let mut brief = json!({ "project": project.map(|(_, p)| p.instructions).unwrap_or_default(), "agent": profile.map(|p| p.instructions.clone()).unwrap_or_default(), "skills": skills });
    if untrusted {
        brief["untrusted"] = json!(true);
    }
    if let Some(b) = bin {
        brief["bin"] = json!(b);
    }
    if !team_brief.is_empty() {
        brief["team"] = Value::Array(team_brief);
    }
    Ok(brief)
}

/// The setup commands of the project `a`'s folder is in, when it trusts its setup (v1: they run in a
/// fresh worktree or clone only, never on every task).
pub async fn project_setup(kinds: Option<&crate::kinds::Kinds>, a: &StartArgs) -> Vec<String> {
    let projects = specs_of(a, "projects", kinds.map(|k| &k.project)).await;
    crate::kinds::project_for(&projects, a.cwd.as_deref().unwrap_or_default()).filter(|(_, p)| p.trust.as_ref().is_none_or(|t| t.setup)).map(|(_, p)| p.setup).unwrap_or_default()
}

/// Runs the setup in `dir`, in order; the first failure, said for the held card.
pub async fn run_setup(proc: &Proc, dir: &str, cmds: &[String]) -> Option<String> {
    for cmd in cmds {
        let opts = ExecOpts { cwd: Some(dir.into()), timeout: Some(std::time::Duration::from_secs(600)), ..ExecOpts::default() };
        match proc.exec("sh", &["-c".to_owned(), cmd.clone()], opts).await {
            Ok(r) if r.exit.success() => {}
            Ok(r) => return Some(format!("`{cmd}` failed: {}", String::from_utf8_lossy(&r.stderr).trim())),
            Err(e) => return Some(format!("`{cmd}` didn't start: {e}")),
        }
    }
    None
}

/// The project the folder is in names the agent when the task doesn't, and its worktree default; a
/// profile the overlay declares is this task's (it leaves nothing behind).
async fn defaults(a: &mut StartArgs, kinds: Option<&crate::kinds::Kinds>) {
    if a.agent.as_deref().is_none_or(str::is_empty) || a.worktree.is_none() {
        let projects = specs_of(a, "projects", kinds.map(|k| &k.project)).await;
        if let Some((_, p)) = crate::kinds::project_for(&projects, a.cwd.as_deref().unwrap_or_default()) {
            if a.agent.as_deref().is_none_or(str::is_empty) && !p.agent.is_empty() {
                a.agent = Some(p.agent.clone());
            }
            if a.worktree.is_none() {
                a.worktree = p.worktree.as_ref().and_then(|w| w.enabled);
            }
        }
    }
    if a.profile.is_none()
        && let Some(name) = a.agent.clone()
        && let Some((_, spec)) = overlay(a, "agents").into_iter().find(|(n, _)| *n == name)
        && let Ok(p) = serde_json::from_value::<AgentSpec>(spec)
    {
        a.profile = Some(p);
    }
}

/// Where a task runs, never the server's own folder (v1 `launch.js`): a folder that isn't there is refused,
/// and a task with none gets an empty one of its own under `~/.wisp/scratch` (v1 `store.scratchDir`).
pub async fn folder(home: Option<&std::path::Path>, a: &mut StartArgs) -> Result<()> {
    let cwd = a.cwd.clone().unwrap_or_default();
    if cwd.trim().is_empty() {
        let dir = home.map_or_else(std::env::temp_dir, std::path::Path::to_path_buf).join("scratch").join(wisp_kernel::ids::uuid7());
        tokio::fs::create_dir_all(&dir).await.map_err(|e| WireError::internal(format!("couldn't make a scratch folder at {}: {e}", dir.display())))?;
        a.cwd = Some(dir.display().to_string());
        return Ok(());
    }
    // a relative folder resolves against the server's own: refused, as a missing one is
    let dir = wisp_runtime_api::paths::Folder::of(&cwd).map_err(|e| WireError::invalid(format!("Not a project folder: {e}")))?;
    if !tokio::fs::metadata(dir.path()).await.is_ok_and(|m| m.is_dir()) {
        return Err(WireError::invalid(format!("Not a project folder: {cwd} (it isn't on this computer; pick a project that is)")));
    }
    Ok(())
}

pub async fn prepare(store: &Store, proc: &Proc, home: Option<&std::path::Path>, kinds: Option<&crate::kinds::Kinds>, mut a: StartArgs) -> Result<Prepared> {
    defaults(&mut a, kinds).await;
    let asked = a.agent.clone().unwrap_or_default();
    // the spec keeps what was asked; the profile's values fill the task, not the spec (ADR-0029:
    // flags > the spec's own fields > the formula's profile, so a rerun under another formula re-resolves)
    let (asked_model, asked_effort, asked_mode) = (a.model.clone().unwrap_or_default(), a.effort.clone().unwrap_or_default(), a.mode);
    let project = a.cwd.clone().unwrap_or_default();
    // the spec keeps "no folder", so a rerun gets a fresh scratch folder of its own
    folder(home, &mut a).await?;
    let resolved = resolve(store, &mut a, &asked).await?;
    let brief = act(kinds, &mut a, resolved.as_ref().map(|(_, p)| p)).await?;
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
    // the overlay's connectors are this task's alone (wisp.connectors gives them to its runs)
    let only: Map<String, Value> = overlay(&a, "connectors").into_iter().collect();
    if !only.is_empty() {
        own.insert("connectors".into(), Value::Object(only));
    }
    if brief.as_object().is_some_and(|b| b.values().any(|v| v != &json!("") && v != &json!([]))) {
        own.insert("brief".into(), brief);
    }
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

/// Whether `snap`'s agent ran as one of `profiles` (same name, same spec).
fn ran_with(snap: &Value, profiles: &[Value]) -> bool {
    let Some(agents) = snap.get("agents").and_then(Value::as_array) else { return false };
    agents.iter().any(|a| {
        profiles.iter().any(|p| {
            let same_name = p.get("name") == a.get("name");
            let strip = |v: &Value| {
                let mut v = v.clone();
                if let Some(o) = v.as_object_mut() {
                    o.remove("name");
                    o.retain(|_, x| !(x.is_null() || x == &json!("") || x == &json!([])));
                }
                v
            };
            same_name && strip(p) == strip(a)
        })
    })
}

fn field<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a str> {
    v.and_then(|x| x.get(k)).and_then(Value::as_str)
}

/// `runtime.history`: every task that fits all the filters, newest first. `snapshot` reads a
/// snapshot's formula by hash (cached per call).
pub fn history(sessions: &[Session], costs: &std::collections::HashMap<String, f64>, a: &HistoryArgs, snapshot: &mut dyn FnMut(&str) -> Option<Value>) -> Vec<HistoryRow> {
    let spec = |s: &Session| spec_of(s, &[]);
    // a workflow's runs (parents), so their steps match too
    let runs: Vec<&str> = a.workflow.as_ref().map(|w| sessions.iter().filter(|s| field(s.ext.get("wisp.workflows"), "workflow") == Some(w.as_str())).map(|s| s.id.as_str()).collect()).unwrap_or_default();
    let mut out = Vec::new();
    for s in sessions {
        let sp = spec(s);
        if let Some(x) = &a.agent
            && sp.agent != *x
            && s.agent != *x
        {
            continue;
        }
        if let Some(c) = &a.crew {
            let ext = s.ext.get("wisp.crew");
            if sp.crew.as_deref() != Some(c.as_str()) && field(ext, "id") != Some(c.as_str()) && field(ext, "name") != Some(c.as_str()) {
                continue;
            }
        }
        if a.workflow.is_some() && !runs.contains(&s.id.as_str()) && !sp.lineage.workflow_run.as_deref().is_some_and(|r| runs.contains(&r)) {
            continue;
        }
        if let Some(p) = &a.project
            && s.cwd != *p
            && !s.cwd.ends_with(&format!("/{p}"))
            && !sp.cwd.ends_with(&format!("/{p}"))
        {
            continue;
        }
        if a.since.is_some_and(|t| s.created_at < t) {
            continue;
        }
        if !a.profiles.is_empty() && !sp.formula.as_deref().and_then(&mut *snapshot).is_some_and(|f| ran_with(&f, &a.profiles)) {
            continue;
        }
        out.push(HistoryRow {
            id: s.id.as_str().to_owned(),
            title: s.title.clone(),
            state: serde_json::to_value(s.state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
            agent: if sp.agent.is_empty() { s.agent.clone() } else { sp.agent.clone() },
            harness: s.agent.clone(),
            cwd: s.cwd.clone(),
            created_at: s.created_at,
            cost_usd: costs.get(s.id.as_str()).copied(),
            formula: sp.formula.clone(),
            lineage: sp.lineage.clone(),
            parent_id: s.parent_id.as_ref().map(|p| p.as_str().to_owned()),
        });
        if a.limit.is_some_and(|l| out.len() >= l as usize) {
            break;
        }
    }
    out
}

/// A session run outside wisp as `runtime.adopt`'s args (ADR-0035): its prompts are the spec's steps,
/// its answers the turns, its id what the next follow-up resumes there.
pub fn adopted(s: &wisp_runtime_api::harness::sessions::OutsideSession, turns: &[wisp_runtime_api::harness::sessions::SessionTurn]) -> wisp_runtime_api::spec::AdoptArgs {
    let from = match s.harness.as_str() {
        "claude" => "claude-code",
        other => other,
    };
    let tv: Vec<Value> = turns
        .iter()
        .enumerate()
        .map(|(i, t)| json!({ "id": wisp_kernel::ids::uuid7(), "sessionId": "", "idx": i, "prompt": t.prompt, "agent": s.harness, "model": t.model, "effort": "", "mode": "auto", "attachments": [], "status": "done", "startedAt": t.started_at, "endedAt": t.ended_at, "text": t.text, "resumeId": s.id, "isError": false }))
        .collect();
    let spec = TaskSpec { prompt: turns.first().map(|t| t.prompt.clone()).unwrap_or_default(), steps: turns.iter().skip(1).map(|t| t.prompt.clone()).collect(), agent: s.harness.clone(), cwd: s.cwd.clone(), ..TaskSpec::default() };
    let mut ext = Map::new();
    ext.insert("wisp.adopted".into(), json!({ "from": from, "session": s.id, "at": s.started_at }));
    wisp_runtime_api::spec::AdoptArgs { title: if s.title.is_empty() { format!("{from} session") } else { s.title.clone() }, agent: s.harness.clone(), cwd: s.cwd.clone(), turns: tv, spec, ext, resume_id: Some(s.id.clone()) }
}


#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// A relative folder (`src`, `tests`: both in the crate's folder the test runs in) passed `metadata` against
    /// the server's own folder: refused like a missing one. An empty one still gets its own scratch folder.
    #[tokio::test]
    async fn a_task_started_in_a_relative_folder_is_refused_and_one_with_none_gets_scratch() {
        for cwd in ["src", ".", "tests", "./src"] {
            let mut a = StartArgs { cwd: Some(cwd.into()), ..StartArgs::default() };
            let e = folder(None, &mut a).await.unwrap_err();
            assert!(e.message.contains("Not a project folder"), "{cwd}: {e:?}");
        }
        let mut a = StartArgs::default();
        folder(None, &mut a).await.unwrap();
        let made = std::path::PathBuf::from(a.cwd.unwrap());
        assert!(made.is_absolute() && made.is_dir(), "{}", made.display());
        std::fs::remove_dir_all(made).ok();
    }

    #[test]
    fn the_same_formula_hashes_the_same() {
        let a = json!({ "agents": [{ "name": "reviewer", "harness": "codex" }], "connectors": ["linear"] });
        let b: Value = serde_json::from_str(&a.to_string()).unwrap();
        assert_eq!(hash(&a), hash(&b));
        assert_ne!(hash(&a), hash(&json!({ "agents": [] })));
    }

    #[test]
    fn history_filters_by_what_made_each_task() {
        let mk = |id: &str, agent: &str, spec: Value, ext: Value| {
            let mut s = Session { id: id.into(), agent: agent.into(), cwd: "/w/api".into(), created_at: 100, ..Session::default() };
            s.ext.insert("wisp.runtime".into(), json!({ "spec": spec }));
            if let Some(o) = ext.as_object() {
                for (k, v) in o {
                    s.ext.insert(k.clone(), v.clone());
                }
            }
            s
        };
        let sessions = vec![
            mk("run", "claude", json!({ "prompt": "wf" }), json!({ "wisp.workflows": { "workflow": "release" } })),
            mk("a", "codex", json!({ "prompt": "x", "agent": "reviewer", "formula": "h1", "lineage": { "workflowRun": "run" } }), Value::Null),
            mk("b", "claude", json!({ "prompt": "y", "agent": "fixer", "formula": "h2", "crew": "Ada" }), Value::Null),
        ];
        let snaps = |h: &str| Some(if h == "h1" { json!({ "agents": [{ "name": "reviewer", "harness": "codex", "effort": "high" }] }) } else { json!({ "agents": [{ "name": "fixer", "harness": "claude" }] }) });
        let ids = |a: HistoryArgs| history(&sessions, &std::collections::HashMap::new(), &a, &mut |h: &str| snaps(h)).into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(HistoryArgs { agent: Some("reviewer".into()), ..HistoryArgs::default() }), ["a"]);
        assert_eq!(ids(HistoryArgs { crew: Some("Ada".into()), ..HistoryArgs::default() }), ["b"]);
        assert_eq!(ids(HistoryArgs { workflow: Some("release".into()), ..HistoryArgs::default() }), ["run", "a"]);
        assert_eq!(ids(HistoryArgs { project: Some("api".into()), since: Some(50), ..HistoryArgs::default() }).len(), 3);
        assert_eq!(ids(HistoryArgs { since: Some(200), ..HistoryArgs::default() }), Vec::<String>::new());
        let p = vec![json!({ "name": "reviewer", "harness": "codex", "effort": "high" })];
        assert_eq!(ids(HistoryArgs { profiles: p, ..HistoryArgs::default() }), ["a"]);
        let changed = vec![json!({ "name": "reviewer", "harness": "codex", "effort": "low" })];
        assert_eq!(ids(HistoryArgs { profiles: changed, ..HistoryArgs::default() }), Vec::<String>::new(), "another setup");
    }

    #[test]
    fn a_task_from_before_specs_gets_one_from_its_turns() {
        let s = Session { agent: "claude".into(), cwd: "/w".into(), ..Session::default() };
        let t = |p: &str, by: Option<&str>| Turn { prompt: p.into(), by: by.map(str::to_owned), ..Turn::default() };
        let spec = spec_of(&s, &[t("fix it", None), t("check", Some("wisp")), t("now the tests", None)]);
        assert_eq!((spec.prompt.as_str(), spec.steps.as_slice(), spec.agent.as_str()), ("fix it", &["now the tests".to_owned()][..], "claude"));
    }
}
