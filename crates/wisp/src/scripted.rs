//! The curated verbs that read and steer tasks (ls, show, wait, reply, btw), on v2's commands
//! (`runtime.*` over `POST /api/cmd`) and topics: no v1 route (ADR-0031).
use std::io::Write;
use std::time::Duration;

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

/// `runtime.create`'s args for a launch from the command line (the `default` profile fills what's left).
pub fn launch_args(f: &Flags, prompt: &str, cwd: &str) -> Value {
    let also: Vec<String> = f.also.iter().map(|p| p.display().to_string()).collect();
    let mut a = json!({ "prompt": prompt, "cwd": cwd });
    for (k, v) in [("agent", &f.agent), ("model", &f.model), ("effort", &f.effort), ("mode", &f.mode)] {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty() && *v != "auto") {
            a[k] = json!(v);
        }
    }
    if !also.is_empty() {
        a["dirs"] = json!(also);
    }
    if let Some(w) = f.worktree {
        a["worktree"] = json!(w);
    }
    a
}

/// Until the task needs you (it isn't running), from its topic: no polling.
pub async fn wait(c: &Client, id: &str, timeout: Duration) -> Result<Value> {
    let done = crate::attach::until(c, id, |s| !matches!(s.get("state").and_then(Value::as_str), Some("running") | None));
    match tokio::time::timeout(timeout, done).await {
        Ok(v) => v,
        Err(_) => Ok(json!({ "id": id, "timedOut": true })),
    }
}

/// `wisp show <id>`: its state and its last answer, drawn for the terminal (`--json`: the task and the
/// presentation).
pub async fn show(c: &Client, f: &Flags, id: &str, summary: Option<Value>) -> Result<()> {
    let task = c.cmd("runtime.get", json!({ "id": id })).await?;
    let p = c.cmd("runtime.presentation", json!({ "id": id })).await.unwrap_or(Value::Null);
    let still = if summary.as_ref().and_then(|x| x.get("timedOut")).and_then(Value::as_bool) == Some(true) { ", still running" } else { "" };
    if f.json {
        let mut all = task.clone();
        if let Some(o) = all.as_object_mut() {
            o.insert("presentation".into(), p);
        }
        say(&serde_json::to_string_pretty(&all).unwrap_or_default());
        return Ok(());
    }
    let st = crate::cli::style();
    let family = crate::history_cli::lineage_line(c, id).await.map_or_else(String::new, |l| format!("\n{l}"));
    let blocks = p.get("blocks").and_then(Value::as_array).cloned().unwrap_or_default();
    let body = if blocks.is_empty() { String::new() } else { wisp_cli_core::Renderers::builtin().answer(&blocks, &st).join("\n") };
    say(&format!("◌ {}  [{}{still}]  {id}{family}\n\n{body}", s(&task, "title"), s(&task, "state")));
    Ok(())
}

pub async fn ls(c: &Client, f: &Flags) -> Result<()> {
    let mut states: Vec<String> = Vec::new();
    for x in f.state.iter().flat_map(|st| st.split(',')).map(str::trim).filter(|x| !x.is_empty()) {
        let add: &[&str] = if x == "needs" { &["review", "waiting"] } else { &[x] };
        for a in add {
            if !states.iter().any(|y| y == a) {
                states.push((*a).to_owned());
            }
        }
    }
    if let Some(bad) = Some(states.iter().filter(|x| !LS_STATES.contains(&x.as_str())).cloned().collect::<Vec<_>>()).filter(|b| !b.is_empty()) {
        return Err(CliError::said(format!("unknown state {}: use {} or needs (review + waiting)", bad.join(", "), LS_STATES.join(", "))));
    }
    let mut args = json!({});
    if f.all {
        args["archived"] = json!(true);
    }
    let list = c.cmd("runtime.list", args).await?;
    let cwd = f.cwd.as_ref().map(|p| p.display().to_string());
    let rows: Vec<&Value> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|x| states.is_empty() || states.iter().any(|st| st == s(x, "state")))
        .filter(|x| cwd.as_ref().is_none_or(|c| s(x, "cwd") == c.as_str()))
        .filter(|x| f.all || x.get("archived") != Some(&json!(true)))
        .take(f.limit.map_or(usize::MAX, |l| l as usize))
        .collect();
    let lines: Vec<String> = rows
        .iter()
        .map(|x| {
            let ask = x.get("question").and_then(Value::as_str).filter(|q| !q.is_empty()).map_or(String::new(), |q| format!("  — asks: {q}"));
            let proj = std::path::Path::new(s(x, "cwd")).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            format!("{}  {:<7}  {:<8}  {:<16}  {}{ask}", s(x, "id"), s(x, "state"), s(x, "agent"), proj.chars().take(16).collect::<String>(), s(x, "title"))
        })
        .collect();
    out(f, &json!(rows), &if lines.is_empty() { "No sessions.".to_owned() } else { lines.join("\n") });
    Ok(())
}

#[allow(clippy::many_single_char_names)]
pub async fn reply(c: &Client, f: &Flags, args: &[String]) -> Result<()> {
    let id = need(args.first(), "session id")?;
    let text = args[1..].join(" ");
    let text = need(Some(&text), "text")?;
    let mut a = json!({ "id": id, "text": text });
    if let Some(q) = f.queue {
        a["queue"] = json!(q);
    }
    if let Some(m) = &f.mode {
        a["mode"] = json!(m);
    }
    let pick: serde_json::Map<String, Value> = [("agent", &f.agent), ("model", &f.model), ("effort", &f.effort)].into_iter().filter_map(|(k, v)| v.as_ref().map(|v| (k.to_owned(), json!(v)))).collect();
    if !pick.is_empty() {
        a["run"] = Value::Object(pick);
    }
    let r = c.cmd("runtime.followUp", a).await?;
    if !f.wait {
        let said = if r.get("queued").is_some_and(|v| !v.is_null() && *v != json!(false)) { "  ✓ queued" } else { "  ✓ sent" };
        out(f, &r, said);
        return Ok(());
    }
    let w = wait(c, id, Duration::from_secs(30 * 60)).await?;
    show(c, f, id, Some(w)).await
}

pub fn btw_out(f: &Flags, b: &Value) {
    let text = if b.get("pending") == Some(&json!(true)) { "  … still answering; it will show on the card".to_owned() } else { s(b, "answer").to_owned() };
    out(f, b, &text);
}

/// The side answer, once it's in (the task's `ext["wisp.runtime"].btw`, from its topic; at most 6 minutes).
pub async fn btw_answer(c: &Client, id: &str, btw: &str) -> Result<Value> {
    let entry = |t: &Value| t.pointer("/ext/wisp.runtime/btw").and_then(Value::as_array).and_then(|a| a.iter().find(|x| s(x, "id") == btw)).cloned();
    let done = crate::attach::until(c, id, |t| entry(t).is_some_and(|b| b.get("pending") != Some(&json!(true))));
    match tokio::time::timeout(Duration::from_secs(6 * 60), done).await {
        Ok(t) => Ok(entry(&t?).unwrap_or_else(|| json!({ "id": btw, "answer": "", "error": "It was dismissed." }))),
        Err(_) => Ok(json!({ "id": btw, "answer": "", "pending": true })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_args_leave_the_rest_to_the_default_profile() {
        let mut f = Flags::defaults(None);
        assert_eq!(launch_args(&f, "fix it", "/w"), json!({ "prompt": "fix it", "cwd": "/w" }));
        f.agent = Some("reviewer".into());
        f.worktree = Some(false);
        assert_eq!(launch_args(&f, "x", "/w"), json!({ "prompt": "x", "cwd": "/w", "agent": "reviewer", "worktree": false }));
    }
}
