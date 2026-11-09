//! `wisp trigger …` and `wisp crew wake|graph` (ADR-0043): the one trigger engine from the terminal.
//!
//! - `wisp trigger add <name> <on> [prompt…] [--cron C] [--task T] [--crew M] [--workflow W] [--follow-up]
//!   [--branch B] [--label L] [--every MIN] [--secret S] [--match k=v]… [--if EXPR] [--users a,b] [--rate 5/h]
//!   [--debounce 10m] [--concurrency skip|queue|replace|parallel:N] [--cooldown 30m] [--budget-day USD]
//!   [--approval] [--tz ZONE] [-C dir] [--agent A] [--model M] [--mode M]`: writes the `trigger` resource (what
//!   `wisp apply` would), so the formula, the app and the CLI share one spec. (`--on` is the machine flag: the
//!   source is the second word.)
//! - `wisp trigger ls | rm <name> | fire <name> [--payload @file|JSON] | test <name> [--event @file] [--last N]
//!   | log <name> | resume <name> | approve <name> <job> [--no] | sources`
//! - `wisp crew wake <member> [--why TEXT]`, `wisp crew graph`
use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::args::Parsed;
use crate::client::{CliError, Client, Result};
use crate::scripted::say;

/// The flags `trigger add` takes a value for, and the spec field each sets.
const VALUED: [(&str, &str); 16] = [
    ("--cron", "cron"),
    ("--task", "task"),
    ("--crew", "crew"),
    ("--workflow", "workflow"),
    ("--branch", "branch"),
    ("--label", "label"),
    ("--secret", "secret"),
    ("--if", "if"),
    ("--rate", "rate"),
    ("--debounce", "debounce"),
    ("--concurrency", "concurrency"),
    ("--cooldown", "cooldown"),
    ("--tz", "tz"),
    ("--prompt", "prompt"),
    ("--why", "why"),
    ("--payload", "payload"),
];

/// Flags the global parser already read (their values aren't words here).
const GLOBAL: [&str; 9] = ["--cwd", "-C", "--agent", "-a", "--model", "--mode", "-m", "--port", "-p"];

/// The words and flags after `wisp <area> <verb>`.
#[derive(Debug, Default, PartialEq)]
pub struct Said {
    pub words: Vec<String>,
    pub vals: BTreeMap<String, String>,
    pub matches: Vec<(String, String)>,
    pub on_off: Vec<String>,
    pub every: Option<u32>,
    pub last: Option<u32>,
    pub budget_day: Option<f64>,
    pub users: Vec<String>,
}

pub fn read(rest: &[String]) -> std::result::Result<Said, String> {
    let mut s = Said::default();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        let mut val = |name: &str| it.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        if let Some((_, field)) = VALUED.iter().find(|(f, _)| *f == a) {
            s.vals.insert((*field).to_owned(), val(a)?);
        } else if a == "--match" {
            let v = val(a)?;
            let (k, x) = v.split_once('=').ok_or_else(|| format!("--match takes key=value (not {v})"))?;
            s.matches.push((k.to_owned(), x.to_owned()));
        } else if a == "--every" {
            s.every = Some(val(a)?.parse().map_err(|_| "--every takes minutes".to_owned())?);
        } else if a == "--last" {
            s.last = Some(val(a)?.parse().map_err(|_| "--last takes a number".to_owned())?);
        } else if a == "--budget-day" {
            s.budget_day = Some(val(a)?.trim_start_matches('$').parse().map_err(|_| "--budget-day takes dollars".to_owned())?);
        } else if a == "--users" {
            s.users = val(a)?.split(',').map(|u| u.trim().to_owned()).filter(|u| !u.is_empty()).collect();
        } else if a == "--event" {
            s.vals.insert("event".into(), val(a)?);
        } else if matches!(a.as_str(), "--approval" | "--follow-up" | "--off" | "--no" | "--json") {
            s.on_off.push(a.trim_start_matches('-').to_owned());
        } else if GLOBAL.contains(&a.as_str()) {
            it.next();
        } else if a.starts_with("--") {
            return Err(format!("{a}: not a trigger flag (wisp trigger add --help)"));
        } else {
            s.words.push(a.clone());
        }
    }
    Ok(s)
}

/// `trigger add`'s spec from what was said.
pub fn spec_of(s: &Said, p: &Parsed, cwd: &str) -> std::result::Result<(String, Value), String> {
    let (Some(name), Some(on)) = (s.words.first(), s.words.get(1)) else {
        return Err("wisp trigger add <name> <on> [prompt…]  (on: schedule, task.finished, ci.failed, … — wisp trigger sources)".into());
    };
    let mut m = Map::new();
    m.insert("on".into(), json!(on));
    let prompt = s.words[2..].join(" ");
    if !prompt.is_empty() {
        m.insert("prompt".into(), json!(prompt));
    }
    for (k, v) in &s.vals {
        if !matches!(k.as_str(), "why" | "payload" | "event") {
            m.insert(k.clone(), json!(v));
        }
    }
    if let Some(e) = s.every {
        m.insert("every".into(), json!(e));
    }
    if !s.users.is_empty() {
        m.insert("users".into(), json!(s.users));
    }
    if !s.matches.is_empty() {
        m.insert("match".into(), Value::Object(s.matches.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
    }
    if let Some(d) = s.budget_day {
        m.insert("budget".into(), json!({ "perDay": d }));
    }
    for (flag, field) in [("approval", "approval"), ("follow-up", "followUp")] {
        if s.on_off.iter().any(|f| f == flag) {
            m.insert(field.into(), json!(true));
        }
    }
    if s.on_off.iter().any(|f| f == "off") {
        m.insert("enabled".into(), json!(false));
    }
    let f = &p.flags;
    for (k, v) in [("agent", &f.agent), ("model", &f.model), ("mode", &f.mode)] {
        if let Some(v) = v {
            m.insert(k.into(), json!(v));
        }
    }
    if f.cwd.is_some() {
        m.insert("project".into(), json!(cwd));
    }
    Ok((name.clone(), Value::Object(m)))
}

/// `@file` read, or the JSON itself.
fn json_arg(v: &str) -> Result<Value> {
    let text = match v.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).map_err(|e| CliError::said(format!("{path}: {e}")))?,
        None => v.to_owned(),
    };
    serde_json::from_str(&text).map_err(|e| CliError::said(format!("not JSON: {e}")))
}

fn line(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn said_out(v: &Value, json: bool) {
    if json {
        say(&v.to_string());
        return;
    }
    let session = v.get("session").and_then(Value::as_str).map(|s| format!("  → {s}")).unwrap_or_default();
    let why = line(v, "why");
    say(&format!("  {}{}{session}", line(v, "result"), if why.is_empty() { String::new() } else { format!(": {why}") }));
}

/// `wisp trigger test`: each event's dry run, and the prompt it would send.
async fn dry_run(c: &Client, name: String, said: &Said, json: bool) -> Result<()> {
    let mut args = json!({ "name": name });
    if let Some(e) = said.vals.get("event") {
        args["event"] = json_arg(e)?;
    }
    if let Some(n) = said.last {
        args["last"] = json!(n);
    }
    let v = c.cmd("automations.trigger.test", args).await?;
    if json {
        say(&v.to_string());
        return Ok(());
    }
    let list = v.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        say("  no recent events of its source to try (give one: --event @event.json)");
    }
    for t in list {
        let why = line(&t, "why");
        say(&format!("  {:<22} {}{}", line(&t, "result"), line(&t, "summary"), if why.is_empty() { String::new() } else { format!("  ({why})") }));
        let prompt = line(&t, "prompt");
        if !prompt.is_empty() && line(&t, "result") != "not for it" {
            say(&format!("      prompt: {}", prompt.lines().next().unwrap_or("")));
        }
    }
    say("  (a dry run: nothing started)");
    Ok(())
}

#[allow(clippy::many_single_char_names)] // c, p, s as in the rest of the CLI
async fn trigger(c: &Client, p: &Parsed, verb: &str, s: &Said, cwd: &str) -> Result<i32> {
    let json = p.flags.json || s.on_off.iter().any(|f| f == "json");
    let name = || s.words.first().cloned().ok_or_else(|| CliError::said(format!("wisp trigger {verb} <name>")));
    match verb {
        "add" => {
            let (name, spec) = spec_of(s, p, cwd).map_err(CliError::said)?;
            let out = c.cmd("resources.apply", json!({ "resources": [{ "kind": "trigger", "name": name, "spec": spec }], "trust": true })).await?;
            let problems = out.pointer("/plan/problems").and_then(Value::as_array).cloned().unwrap_or_default();
            if !problems.is_empty() {
                for pr in &problems {
                    say(&format!("  ✗ {}", pr.as_str().unwrap_or(&pr.to_string())));
                }
                return Ok(1);
            }
            say(&format!("  ✓ trigger {name} on {}", spec["on"].as_str().unwrap_or("")));
        }
        "rm" | "remove" => {
            let name = name()?;
            c.cmd("resources.apply", json!({ "resources": [], "destroy": [format!("trigger.{name}")], "trust": true })).await?;
            say(&format!("  ✓ removed trigger {name}"));
        }
        "ls" | "list" => {
            let v = c.cmd("automations.trigger.ls", json!({})).await?;
            if json {
                say(&v.to_string());
                return Ok(0);
            }
            for t in v.as_array().into_iter().flatten() {
                let why = line(t, "why");
                let on = t.pointer("/spec/on").and_then(Value::as_str).unwrap_or("");
                say(&format!("{:<28} {:<16} {:<12} {:>4} runs{}", line(t, "name"), on, line(t, "state"), t["runs"], if why.is_empty() { String::new() } else { format!("  {why}") }));
            }
        }
        "fire" => {
            let mut a = json!({ "name": name()? });
            if let Some(pl) = s.vals.get("payload") {
                a["payload"] = json_arg(pl)?;
            }
            said_out(&c.cmd("automations.trigger.fire", a).await?, json);
        }
        "test" => dry_run(c, name()?, s, json).await?,
        "log" => {
            let v = c.cmd("automations.trigger.log", json!({ "name": name()? })).await?;
            for d in v.as_array().into_iter().flatten() {
                if json {
                    say(&d.to_string());
                    continue;
                }
                let session = d.get("session").and_then(Value::as_str).map(|s| format!("  → {s}")).unwrap_or_default();
                say(&format!("{:<14} {:<18} {}{session}", d["at"], line(d, "result"), line(d, "why")));
            }
        }
        "resume" => {
            c.cmd("automations.trigger.resume", json!({ "name": name()? })).await?;
            say("  ✓ resumed");
        }
        "approve" => {
            let job = s.words.get(1).ok_or_else(|| CliError::said("wisp trigger approve <name> <job> [--no]"))?;
            let yes = !s.on_off.iter().any(|f| f == "no");
            said_out(&c.cmd("automations.trigger.approve", json!({ "name": name()?, "job": job, "yes": yes })).await?, json);
        }
        "sources" => {
            let v = c.cmd("automations.sources", json!({})).await?;
            for r in v.as_array().into_iter().flatten() {
                if json {
                    say(&r.to_string());
                    continue;
                }
                let off = if r["available"] == json!(true) { "" } else { "  (its plugin is off)" };
                say(&format!("{:<22} {:<6} {:<18} {}{off}", line(r, "on"), line(r, "mode"), line(r, "plugin"), line(r, "title")));
            }
        }
        other => return Err(CliError::said(format!("wisp trigger {other}: add, ls, rm, fire, test, log, resume, approve or sources"))),
    }
    Ok(0)
}

async fn crew(c: &Client, p: &Parsed, verb: &str, s: &Said) -> Result<i32> {
    match verb {
        "wake" => {
            let id = s.words.first().ok_or_else(|| CliError::said("wisp crew wake <member> [--why TEXT]"))?;
            let why = s.vals.get("why").cloned().unwrap_or_else(|| s.words[1..].join(" "));
            let v = c.cmd("crew.wake", json!({ "id": id, "why": why, "source": "cli" })).await?;
            if p.flags.json {
                say(&v.to_string());
            } else if let Some(q) = v.get("queued").and_then(Value::as_str) {
                say(&format!("  ✓ {id} has it queued ({q})"));
            } else {
                say(&format!("  ✓ {id} is on it{}", v.pointer("/session/id").and_then(Value::as_str).map(|s| format!(" → {s}")).unwrap_or_default()));
            }
        }
        "graph" => {
            let v = c.cmd("crew.graph", json!({})).await?;
            if p.flags.json {
                say(&v.to_string());
                return Ok(0);
            }
            for e in v["edges"].as_array().into_iter().flatten() {
                say(&format!("  {} → {}   ({} wakes on {}'s report)", line(e, "from"), line(e, "to"), line(e, "to"), line(e, "from")));
            }
            for (m, ons) in v["wakes"].as_object().into_iter().flatten() {
                let ons: Vec<&str> = ons.as_array().into_iter().flatten().filter_map(Value::as_str).filter(|o| *o != "crew.reported").collect();
                if !ons.is_empty() {
                    say(&format!("  {m} wakes on {}", ons.join(", ")));
                }
            }
            if let Some(cy) = v["cycle"].as_array() {
                let names: Vec<&str> = cy.iter().filter_map(Value::as_str).collect();
                say(&format!("  ✗ a loop: {}", names.join(" → ")));
                return Ok(1);
            }
        }
        other => return Err(CliError::said(format!("wisp crew {other}: wake or graph"))),
    }
    Ok(0)
}

/// `wisp trigger <verb> …` / `wisp crew <wake|graph> …`
pub async fn run(c: &Client, p: &Parsed, area: &str, cwd: &str) -> Result<i32> {
    let at = p.argv.iter().position(|a| a == area).map_or(0, |i| i + 1);
    let rest = &p.argv[at.min(p.argv.len())..];
    let verb = rest.first().map_or("ls", String::as_str);
    let s = read(rest.get(1..).unwrap_or_default()).map_err(CliError::said)?;
    if area == "crew" { crew(c, p, verb, &s).await } else { trigger(c, p, verb, &s, cwd).await }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn trigger_add_reads_its_flags_into_a_spec() {
        let s = read(&words("nightly schedule review the day --cron 0_2_*_*_* --rate 5/h --match branch=main --approval --users ada,bo -C /w/api")).unwrap();
        let argv: Vec<String> = ["trigger", "add"].iter().map(|s| (*s).to_owned()).chain(words("nightly -C /w/api")).collect();
        let p = crate::args::parse(&argv, None, std::path::Path::new("/h"), std::path::Path::new("/w")).unwrap();
        let (name, spec) = spec_of(&s, &p, "/w/api").unwrap();
        assert_eq!(name, "nightly");
        assert_eq!(spec["on"], "schedule");
        assert_eq!(spec["prompt"], "review the day");
        assert_eq!((spec["rate"].as_str(), spec["approval"].as_bool()), (Some("5/h"), Some(true)));
        assert_eq!(spec["match"]["branch"], "main");
        assert_eq!(spec["users"], json!(["ada", "bo"]));
        assert_eq!(spec["cron"], "0_2_*_*_*");
        assert!(read(&words("x y --nope 1")).is_err(), "an unknown flag is said, not dropped");
        assert!(spec_of(&read(&words("only")).unwrap(), &p, "").is_err(), "needs an on");
        assert_eq!(spec["project"], "/w/api", "-C is the project");
    }
}
