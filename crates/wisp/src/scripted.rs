//! The commands that only talk to the API (v1 bin/wisp.js `scripted`): ls, show, wait, reply, btw, stop,
//! ship, merge, run, recipes, usage, and a launch with --json/--wait. Same paths, bodies and output.
use std::io::Write;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::args::{Flags, LS_STATES};
use crate::client::{CliError, Client, Result};

/// The one place the CLI writes to stdout (libraries never do: plan §9.2).
pub fn say(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
}

pub fn out(flags: &Flags, v: &Value, text: &str) {
    if flags.json {
        say(&serde_json::to_string_pretty(v).unwrap_or_default());
    } else {
        say(text);
    }
}

pub fn need<'a>(v: Option<&'a String>, what: &str) -> Result<&'a str> {
    v.map(String::as_str).filter(|s| !s.trim().is_empty()).ok_or_else(|| CliError::said(format!("{what} required — see wisp --help")))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn opt(v: Option<&String>) -> Value {
    v.map_or(Value::Null, |x| json!(x))
}

/// `--try`: the second run's change (v1 client.js tryRuns).
pub fn try_runs(list: &[String]) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for x in list.iter().flat_map(|v| v.split(',')).filter(|x| !x.is_empty()) {
        match x.split_once('=') {
            Some(("subagents", v @ ("haiku" | "sonnet" | "task"))) => {
                out.insert("subagentModel".into(), json!(if v == "task" { "" } else { v }));
            }
            Some(("skills", "off")) => {
                out.insert("skills".into(), json!("off"));
            }
            _ => return Err(CliError::said("Use --try subagents=haiku|sonnet|task or --try skills=off")),
        }
    }
    Ok(Value::Object(out))
}

/// Why `--try` can't go with these flags, said before anything has to start.
pub fn try_problem(f: &Flags) -> Option<&'static str> {
    if f.agent.as_deref().is_none_or(|a| a == "auto") {
        return Some("--try needs --agent: pick a harness first");
    }
    if f.compare.is_some() {
        return Some("--try is its own comparison: leave out --compare");
    }
    if f.mode.as_deref() == Some("plan") {
        return Some("--try needs edits to compare, so it doesn’t run in Plan mode");
    }
    if f.worktree == Some(false) {
        return Some("--try keeps a worktree per run: leave out --no-worktree");
    }
    None
}

pub async fn launch_body(c: &Client, f: &Flags, prompt: String, cwd: &str, tried: Option<Value>) -> Result<Value> {
    let (mut agent, mut mode, mut model) = (f.agent.clone(), f.mode.clone(), f.model.clone());
    if agent.is_none() || mode.is_none() || model.is_none() {
        let cfg = c.get("/config").await.unwrap_or_default();
        let d = cfg.get("defaults").cloned().unwrap_or_default();
        let a = agent.clone().unwrap_or_else(|| d.get("agent").and_then(Value::as_str).unwrap_or("auto").to_owned());
        mode = mode.or_else(|| Some(d.get("mode").and_then(Value::as_str).unwrap_or("auto").to_owned()));
        model = model.or_else(|| d.pointer(&format!("/models/{a}")).and_then(Value::as_str).map(str::to_owned).or_else(|| (Some(a.as_str()) == d.get("agent").and_then(Value::as_str)).then(|| s(&d, "model").to_owned())));
        agent = Some(a);
    }
    let compare = match &tried {
        Some(t) => json!([{ "agent": agent, "model": model, "effort": f.effort, "subagentModel": t.get("subagentModel"), "skills": t.get("skills") }]),
        None => f.compare.as_ref().map_or(Value::Null, |list| list.iter().map(|r| json!({"agent": r.agent, "model": r.model})).collect()),
    };
    let also: Vec<String> = f.also.iter().map(|p| p.display().to_string()).collect();
    Ok(json!({
        "prompt": prompt, "cwd": cwd, "also": if also.is_empty() { Value::Null } else { json!(also) },
        "agent": agent, "mode": mode, "model": model, "effort": opt(f.effort.as_ref()), "worktree": f.worktree,
        "compare": compare, "trial": tried.is_some().then_some(true), "confirmLimit": f.yes.then_some(true),
    }))
}

/// Until the session needs you: long polls of at most 280 s each (fetch gives up on headers at 300 s).
pub async fn wait(c: &Client, id: &str, timeout: Duration) -> Result<Value> {
    let end = Instant::now() + timeout;
    loop {
        let left = end.saturating_duration_since(Instant::now()).as_secs();
        let v = c.get(&format!("/sessions/{id}/wait?timeout={}", left.min(280))).await?;
        if v.get("timedOut").and_then(Value::as_bool) != Some(true) || left <= 280 {
            return Ok(v);
        }
    }
}

pub async fn show(c: &Client, f: &Flags, id: &str, summary: Option<Value>) -> Result<()> {
    let p = c.get(&format!("/sessions/{id}/presentation")).await?;
    let sess = match summary.clone() {
        Some(s) => s,
        None => c.get("/sessions").await?.as_array().and_then(|l| l.iter().find(|x| s(x, "id") == id).cloned()).unwrap_or_default(),
    };
    let still = if summary.as_ref().and_then(|x| x.get("timedOut")).and_then(Value::as_bool) == Some(true) { ", still running" } else { "" };
    let mut all = sess.clone();
    if let Some(o) = all.as_object_mut() {
        o.insert("presentation".into(), p.clone());
    }
    out(f, &all, &format!("◌ {}  [{}{still}]  {id}\n\n{}", s(&sess, "title"), s(&sess, "state"), s(&p, "markdown")));
    Ok(())
}

pub async fn ls(c: &Client, f: &Flags) -> Result<()> {
    let states: Option<Vec<String>> = f.state.as_ref().map(|st| {
        let mut v: Vec<String> = Vec::new();
        for x in st.split(',').map(str::trim).filter(|x| !x.is_empty()) {
            let add: &[&str] = if x == "needs" { &["review", "waiting"] } else { &[x] };
            for a in add {
                if !v.iter().any(|y| y == a) {
                    v.push((*a).to_owned());
                }
            }
        }
        v
    });
    if let Some(bad) = states.as_ref().map(|v| v.iter().filter(|x| !LS_STATES.contains(&x.as_str())).cloned().collect::<Vec<_>>()).filter(|b| !b.is_empty()) {
        return Err(CliError::said(format!("unknown state {}: use {} or needs (review + waiting)", bad.join(", "), LS_STATES.join(", "))));
    }
    let mut q: Vec<String> = Vec::new();
    if let Some(st) = &states {
        q.push(format!("state={}", st.join(",")));
    }
    if let Some(l) = f.limit {
        q.push(format!("limit={l}"));
    }
    if let Some(cwd) = &f.cwd {
        q.push(format!("cwd={}", cwd.display()));
    }
    if !f.all {
        q.push("archived=false".into());
    }
    let list = c.get(&format!("/sessions{}{}", if q.is_empty() { "" } else { "?" }, q.join("&"))).await?;
    let lines: Vec<String> = list.as_array().into_iter().flatten().map(|x| {
        // the summary carries `question: ""` when nothing is asked
        let ask = x.get("question").and_then(Value::as_str).filter(|q| !q.is_empty()).map_or(String::new(), |q| format!("  — asks: {q}"));
        let proj: String = format!("{:<16}", s(x, "project")).chars().take(16).collect();
        format!("{}  {:<7}  {:<8}  {proj}  {}{ask}", s(x, "id"), s(x, "state"), s(x, "agent"), s(x, "title"))
    }).collect();
    out(f, &list, &if lines.is_empty() { "No sessions.".to_owned() } else { lines.join("\n") });
    Ok(())
}

pub async fn reply(c: &Client, f: &Flags, args: &[String]) -> Result<()> {
    let id = need(args.first(), "session id")?;
    let text = args[1..].join(" ");
    let text = need(Some(&text), "text")?;
    let r = c.post(&format!("/sessions/{id}/reply"), json!({"text": text, "queue": f.queue, "mode": f.mode, "agent": f.agent, "model": f.model, "effort": f.effort, "confirmLimit": f.yes.then_some(true)})).await?;
    if let Some(b) = r.pointer("/btw/id").and_then(Value::as_str) {
        btw_out(f, &btw_answer(c, id, b).await?);
        return Ok(());
    }
    if !f.wait {
        let said = if r.get("answered").is_some_and(|v| v == true) { "  ✓ answered" } else if r.get("interrupted").is_some_and(|v| v == true) { "  ✓ interrupted; resuming with your message" } else if r.get("queued").is_some_and(|v| v == true) { "  ✓ queued" } else { "  ✓ sent" };
        out(f, &r, said);
        return Ok(());
    }
    let w = wait(c, id, Duration::from_secs(30 * 60)).await?;
    show(c, f, id, Some(w)).await
}

pub fn btw_out(f: &Flags, b: &Value) {
    let text = match s(b, "status") {
        "done" => s(b, "answer").to_owned(),
        "running" => "  … still answering; it will show on the card".to_owned(),
        _ => format!("  ! {}", s(b, "error")),
    };
    out(f, b, &text);
}

pub async fn btw_answer(c: &Client, id: &str, btw: &str) -> Result<Value> {
    let end = Instant::now() + Duration::from_secs(6 * 60);
    loop {
        let sess = c.get(&format!("/sessions/{id}")).await?;
        let b = sess.get("turns").and_then(Value::as_array).into_iter().flatten().flat_map(|t| t.get("btw").and_then(Value::as_array).cloned().unwrap_or_default()).find(|x| s(x, "id") == btw);
        let Some(b) = b else { return Ok(json!({"id": btw, "status": "error", "error": "It was dismissed."})) };
        if s(&b, "status") != "running" || Instant::now() > end {
            return Ok(b);
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tries() {
        assert_eq!(try_runs(&["subagents=task,skills=off".into()]).unwrap(), json!({"subagentModel": "", "skills": "off"}));
        assert!(try_runs(&["subagents=opus".into()]).is_err());
        let mut f = Flags::defaults(None);
        assert!(try_problem(&f).is_some());
        f.agent = Some("claude".into());
        assert!(try_problem(&f).is_none());
        f.mode = Some("plan".into());
        assert!(try_problem(&f).unwrap().contains("Plan"));
    }
}
