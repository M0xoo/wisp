//! Tasks as code from the terminal (ADR-0027, ADR-0029):
//!
//! - `wisp task spec <id>`: what was asked (YAML; `--json`); `wisp task export <id> > x.task.yml`: the
//!   spec to share (with the formula it ran under, nothing of its output); `wisp task formula <id>`: the
//!   effective formula it ran with, as a formula you can diff or apply.
//! - `wisp run -f x.task.yml`: a task from a spec file, on your code and accounts.
//! - `wisp rerun <id>`: the same ask from the same commit (`--from latest` for today's code), flags over
//!   the spec (`--agent`, `--model`, `--effort`, `--mode`, `--steps N`); `--formula f.yml` resolves its
//!   names in that formula instead (`--fill-from-snapshot` for the ones it doesn't have); several formulas
//!   are one rerun each; `--last N [--project P]` reruns your last tasks.
//! - `wisp run <name>`: a workflow, or a declared task (`k=v` and words fill its inputs or `{params}`).
use std::path::Path;

use serde_json::{Map, Value, json};
use wisp_cli_core::term::{BOLD, DIM, GREEN, RED, paint};
use wisp_resources_core::export::yaml;
use wisp_resources_core::formula::{self, documents, format_of};

use crate::client::{CliError, Client, Result};
use crate::code::{Files, Opts};
use crate::scripted::say;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `wisp task spec|export|formula <id>`.
pub async fn task(c: &Client, o: &Opts) -> Result<i32> {
    let (verb, id) = match o.words.as_slice() {
        [v, id, ..] => (v.as_str(), id.as_str()),
        _ => return Err(CliError::said("wisp task spec|export|formula <id>")),
    };
    match verb {
        "spec" => {
            let spec = c.cmd("runtime.spec", json!({ "id": id })).await?;
            say(&if o.json { serde_json::to_string_pretty(&spec).unwrap_or_default() } else { yaml(&spec) });
        }
        "export" => {
            let mut spec = c.cmd("runtime.spec", json!({ "id": id })).await?;
            if let Some(b) = spec.get_mut("base").and_then(Value::as_object_mut) {
                b.remove("worktree");
            }
            let hash = spec.as_object_mut().and_then(|o| o.remove("formula"));
            if let Some(o) = spec.as_object_mut() {
                o.remove("lineage");
            }
            let mut doc = Map::new();
            doc.insert("wisp".into(), json!(1));
            doc.insert("task".into(), spec);
            if let Some(h) = hash.as_ref().and_then(Value::as_str)
                && let Ok(snap) = c.cmd("runtime.snapshot", json!({ "of": h })).await
                && snap["formula"].as_object().is_some_and(|f| !f.is_empty())
            {
                doc.insert("formula".into(), snap["formula"].clone());
            }
            say(yaml(&Value::Object(doc)).trim_end());
        }
        "formula" => {
            let snap = c.cmd("runtime.snapshot", json!({ "of": id })).await?;
            let mut doc = Map::new();
            doc.insert("wisp".into(), json!(1));
            if let Some(f) = snap["formula"].as_object() {
                for (k, v) in f.iter().filter(|(k, _)| *k == "agents" || *k == "connectors") {
                    doc.insert(k.clone(), v.clone());
                }
            }
            say(&format!("# the formula {id} ran with (@{})\n{}", s(&snap, "hash"), yaml(&Value::Object(doc)).trim_end()));
        }
        other => return Err(CliError::said(format!("wisp task {other}: spec, export or formula"))),
    }
    Ok(0)
}

/// The agent profiles a formula declares, by name.
fn profiles_in(files: &[String], cwd: &Path) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for f in files {
        let (text, name) = formula::Source::load(&mut Files { cwd: cwd.to_owned() }, f, None).map_err(CliError::said)?;
        for doc in documents(&text, format_of(&name)).map_err(CliError::said)? {
            for a in doc.get("agents").and_then(Value::as_array).into_iter().flatten() {
                if let Some(n) = a.get("name").and_then(Value::as_str) {
                    let mut spec = a.clone();
                    if let Some(o) = spec.as_object_mut() {
                        o.remove("name");
                    }
                    out.insert(n.to_owned(), spec);
                }
            }
            if let Some(m) = doc.get("agents").and_then(Value::as_object) {
                for (n, spec) in m {
                    out.insert(n.clone(), spec.clone());
                }
            }
        }
    }
    Ok(out)
}

/// `runtime.create`'s args from a spec, the flags over it, and the profile it names.
fn start_args(spec: &Value, o: &Opts, profile: Option<Value>, formula: Option<Value>) -> Value {
    let mut a = Map::new();
    for k in ["prompt", "agent", "model", "effort", "mode", "cwd", "dirs", "worktree", "goal", "crew", "team", "connectors"] {
        if let Some(v) = spec.get(k).filter(|v| !v.is_null() && **v != json!("") && **v != json!([])) {
            a.insert(k.to_owned(), v.clone());
        }
    }
    let mut steps: Vec<Value> = spec.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(n) = o.steps {
        steps.truncate(n.saturating_sub(1));
    }
    if !steps.is_empty() {
        a.insert("steps".into(), Value::Array(steps));
    }
    if o.from.as_deref() != Some("latest")
        && let Some(sha) = spec.pointer("/base/sha").and_then(Value::as_str)
    {
        a.insert("base".into(), json!({ "sha": sha }));
    }
    if let Some(p) = profile {
        a.insert("profile".into(), p);
    }
    if let Some(f) = formula {
        a.insert("formula".into(), f);
    }
    // the flags beat the spec
    for (k, v) in &o.over {
        a.insert(k.clone(), v.clone());
        if k == "agent" {
            a.remove("profile");
        }
    }
    Value::Object(a)
}

/// `wisp run -f x.task.yml`.
pub async fn run_file(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let f = o.files.first().ok_or_else(|| CliError::said("wisp run -f x.task.yml"))?;
    let (text, name) = formula::Source::load(&mut Files { cwd: cwd.to_owned() }, f, None).map_err(CliError::said)?;
    let doc = documents(&text, format_of(&name)).map_err(CliError::said)?.into_iter().next().unwrap_or_default();
    let Some(spec) = doc.get("task") else {
        return Err(CliError::said(format!("{name} has no task: (a formula? wisp apply -f {name})")));
    };
    let mut spec = spec.clone();
    if spec.get("cwd").and_then(Value::as_str).is_none_or(|p| !Path::new(p).is_dir()) {
        // the sharer's folder isn't here: run it in this one
        spec["cwd"] = json!(cwd.display().to_string());
        if let Some(o) = spec.as_object_mut() {
            o.remove("base");
        }
    }
    let agent = s(&spec, "agent").to_owned();
    let profile = doc.pointer("/formula/agents").and_then(Value::as_array).and_then(|a| a.iter().find(|x| s(x, "name") == agent)).map(|p| {
        let mut p = p.clone();
        if let Some(o) = p.as_object_mut() {
            o.remove("name");
        }
        p
    });
    let made = c.cmd("runtime.create", start_args(&spec, o, profile, doc.get("formula").cloned())).await?;
    say(&format!("  ◌ started {}  wisp attach {}", s(&made, "id"), s(&made, "id")));
    Ok(0)
}

/// The sections a task reads from its overlay (the rest is only meaningful applied).
const OVERLAY: [(&str, &str); 6] = [("agent", "agents"), ("project", "projects"), ("harness", "harnesses"), ("skill", "skills"), ("team", "teams"), ("connector", "connectors")];

/// `runtime.create`'s overlay from loaded resources: `{agents: [{name, …}], …}`, and what it leaves out.
pub fn overlay_of(resources: &[wisp_resources_api::Resource]) -> (Value, Vec<String>) {
    let mut out = Map::new();
    let mut left = Vec::new();
    for r in resources {
        let Some((_, section)) = OVERLAY.iter().find(|(k, _)| *k == r.kind) else {
            left.push(format!("{}/{}", r.kind, r.name));
            continue;
        };
        let mut spec = r.spec.as_object().cloned().unwrap_or_default();
        spec.insert("name".into(), json!(r.name));
        if let Value::Array(list) = out.entry((*section).to_owned()).or_insert_with(|| json!([])) {
            list.push(Value::Object(spec));
        }
    }
    (Value::Object(out), left)
}

/// `wisp run --formula f.yml "task"`: one task under the formula as an overlay. Its agents, projects,
/// harnesses, skills, teams and connectors are that task's alone: nothing is applied or kept (the task's
/// snapshot records what it ran with). No `--agent` and one agent declared: that one.
pub async fn run_overlay(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let st = crate::cli::style();
    let kinds = crate::code::kinds(c).await?;
    let loaded = crate::code::load(&o.formulas, &o.profiles, &kinds, cwd)?;
    let (overlay, left) = overlay_of(&loaded.resources);
    let prompt = o.words.join(" ");
    if prompt.trim().is_empty() {
        return Err(CliError::said("wisp run --formula f.yml \"what to do\""));
    }
    let mut spec = json!({ "prompt": prompt, "cwd": cwd.display().to_string() });
    let agents = overlay.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    if !o.over.contains_key("agent")
        && let [one] = agents.as_slice()
    {
        spec["agent"] = one["name"].clone();
    }
    let made = c.cmd("runtime.create", start_args(&spec, o, None, Some(overlay))).await?;
    if !left.is_empty() {
        say(&format!("  {}", paint(&st, DIM, &format!("not for one task (wisp apply -f to keep them): {}", left.join(", ")))));
    }
    let id = s(&made, "id").to_owned();
    say(&format!("  {} started {id} under {}  wisp attach {id}", paint(&st, GREEN, "◌"), o.formulas.join(", ")));
    if o.wait {
        let t = crate::attach::until(c, &id, |s| !matches!(s.get("state").and_then(Value::as_str), Some("running") | None)).await?;
        say(&format!("  {}  {id}", s(&t, "state")));
    }
    Ok(0)
}

/// One rerun of `id`'s spec, under `formula` (a file) or as it ran (its snapshot).
async fn rerun_one(c: &Client, id: &str, formula: Option<&String>, o: &Opts, cwd: &Path) -> Result<std::result::Result<String, String>> {
    let spec = c.cmd("runtime.spec", json!({ "id": id })).await?;
    let snap = c.cmd("runtime.snapshot", json!({ "of": id })).await.ok();
    let asked = s(&spec, "agent").to_owned();
    let from_snapshot = || {
        snap.as_ref().and_then(|x| x.pointer("/formula/agents")).and_then(Value::as_array).and_then(|a| a.first()).map(|p| {
            let mut p = p.clone();
            if let Some(o) = p.as_object_mut() {
                o.remove("name");
            }
            p
        })
    };
    let (profile, overlay) = match formula {
        None => (from_snapshot(), None),
        Some(f) => {
            let mine = profiles_in(std::slice::from_ref(f), cwd)?;
            match mine.get(&asked) {
                Some(p) => {
                    let mut named = p.as_object().cloned().unwrap_or_default();
                    named.insert("name".into(), json!(asked));
                    (Some(p.clone()), Some(json!({ "agents": [named] })))
                }
                None if asked.is_empty() || o.over.contains_key("agent") => (None, None),
                None if o.fill => (from_snapshot(), None),
                None => return Ok(Err(format!("{f} has no agent named {asked}: add it, or --fill-from-snapshot to use the one {id} ran with"))),
            }
        }
    };
    let mut args = start_args(&spec, o, profile, overlay);
    args["lineage"] = json!({ "rerunOf": id });
    let made = c.cmd("runtime.create", args).await?;
    Ok(Ok(s(&made, "id").to_owned()))
}

/// `wisp rerun <id>… | --last N [--project P]`.
pub async fn rerun(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let st = crate::cli::style();
    let mut ids: Vec<String> = o.words.iter().skip(1).cloned().collect();
    if let Some(n) = o.last {
        let list = c.cmd("runtime.list", json!({})).await?;
        let want = o.project.clone();
        ids.extend(
            list.as_array()
                .into_iter()
                .flatten()
                .filter(|t| t.get("parentId").is_none())
                .filter(|t| want.as_ref().is_none_or(|p| s(t, "cwd") == p.as_str() || s(t, "cwd").ends_with(&format!("/{p}"))))
                .take(n)
                .map(|t| s(t, "id").to_owned()),
        );
    }
    if ids.is_empty() {
        return Err(CliError::said("wisp rerun <id> (or --last N): nothing to rerun"));
    }
    let formulas: Vec<Option<&String>> = if o.formulas.is_empty() { vec![None] } else { o.formulas.iter().map(Some).collect() };
    let mut failed = 0;
    let mut made: Vec<(String, String, String)> = Vec::new();
    for id in &ids {
        for f in &formulas {
            let label = f.map_or_else(|| "as it ran".to_owned(), String::clone);
            match rerun_one(c, id, *f, o, cwd).await? {
                Ok(new) => {
                    say(&format!("  {} {id} → {new}  ({label})", paint(&st, GREEN, "◌")));
                    made.push((id.clone(), label, new));
                }
                Err(why) => {
                    failed += 1;
                    say(&format!("  {} {id}: {why}", paint(&st, RED, "✗")));
                }
            }
        }
    }
    if o.wait && !made.is_empty() {
        say(&format!("\n{}", paint(&st, BOLD, "Reruns")));
        for (of, label, id) in &made {
            let t = crate::attach::until(c, id, |s| !matches!(s.get("state").and_then(Value::as_str), Some("running") | None)).await?;
            say(&format!("  {of}  {}  {}  {}", paint(&st, DIM, label), s(&t, "state"), id));
        }
    } else if !made.is_empty() {
        say(&format!("  {}", paint(&st, DIM, "wisp attach <id> to follow one; --wait waits for all and compares")));
    }
    Ok(i32::from(failed > 0))
}

/// `wisp run <name> [k=v…] [words…]`: a workflow, else a declared task. None: neither has that name.
#[allow(clippy::many_single_char_names)]
pub async fn run_named(c: &Client, words: &[String], o: &Opts) -> Result<Option<i32>> {
    let Some(name) = words.first() else { return Ok(None) };
    let st = crate::cli::style();
    let mut kv = Map::new();
    let mut rest = Vec::new();
    for w in &words[1..] {
        match w.split_once('=') {
            Some((k, v)) if !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') => {
                kv.insert(k.to_owned(), json!(v));
            }
            _ => rest.push(w.clone()),
        }
    }
    let project = o.project.clone();
    match c.cmd("workflows.run", json!({ "name": name, "inputs": kv, "project": project })).await {
        Ok(v) => {
            let id = s(&v, "id").to_owned();
            say(&format!("  {} workflow {name}: {id}", paint(&st, GREEN, "◌")));
            if o.wait {
                let t = crate::attach::until(c, &id, |s| matches!(s.pointer("/ext/wisp.workflows/state").and_then(Value::as_str), Some("done" | "failed"))).await?;
                let w = t.pointer("/ext/wisp.workflows").cloned().unwrap_or_default();
                for step in w.get("steps").and_then(Value::as_array).into_iter().flatten() {
                    let mark = match s(step, "state") {
                        "done" => paint(&st, GREEN, "✓"),
                        "failed" => paint(&st, RED, "✗"),
                        _ => paint(&st, DIM, "–"),
                    };
                    let why = s(step, "why");
                    say(&format!("  {mark} {}{}", s(step, "id"), if why.is_empty() { String::new() } else { paint(&st, DIM, &format!("  {why}")) }));
                }
                say(&format!("  {}", s(&w, "state")));
                return Ok(Some(i32::from(s(&w, "state") != "done")));
            }
            say(&format!("    wisp attach {id}"));
            return Ok(Some(0));
        }
        Err(e) if e.status() != 404 => return Err(e),
        Err(_) => {}
    }
    let params: Map<String, Value> = kv;
    match c.cmd("automations.task.run", json!({ "name": name, "params": params, "words": rest, "over": o.over })).await {
        Ok(v) => {
            say(&format!("  {} {name}: {}  wisp attach {}", paint(&st, GREEN, "◌"), s(&v, "id"), s(&v, "id")));
            Ok(Some(0))
        }
        Err(e) if e.status() == 404 => Ok(None),
        Err(e) => Err(e),
    }
}
