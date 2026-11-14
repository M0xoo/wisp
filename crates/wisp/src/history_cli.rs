//! History as code (ADR-0029) and `wisp import` (ADR-0026):
//!
//! - `wisp ls --formula f.yml | --agent reviewer | --crew Ada | --workflow nightly | --since 7d
//!   [--project api]`: tasks by what made them (`runtime.history`).
//! - `wisp task history <id>`: its spec, its turns, its family (reruns, forks, a workflow's steps, what
//!   it was shared from).
//! - `wisp history export --since 30d > history.jsonl`: one line per task, scrubbed (secrets, secret env
//!   values, home paths) as a share is.
//! - `wisp import [v1 home]`: v1's config as a formula, its plan shown first, applied on yes; then the
//!   tasks' history (`runtime.import`).
use std::io::{IsTerminal, Write};
use std::path::Path;

use serde_json::{Value, json};
use wisp_cli_core::term::{self, BOLD, DIM, GREEN, paint};
use wisp_resources_api::Plan;

use crate::client::{CliError, Client, Result};
use crate::code::Opts;
use crate::scripted::say;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `7d`, `12h`, `30m`, `2w` → ms before `now`; a number alone is days.
pub fn since_ms(text: &str, now: i64) -> Result<i64> {
    let t = text.trim();
    let (n, unit) = t.split_at(t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len()));
    let n: i64 =
        n.parse().map_err(|_| CliError::said(format!("--since {t}: a number of days (7d), hours (12h), minutes (30m) or weeks (2w)")))?;
    let ms = match unit {
        "" | "d" => 86_400_000,
        "h" => 3_600_000,
        "m" => 60_000,
        "w" => 7 * 86_400_000,
        _ => return Err(CliError::said(format!("--since {t}: d, h, m or w"))),
    };
    Ok(now - n * ms)
}

fn now_ms() -> i64 {
    i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())).unwrap_or(0)
}

/// Whether `wisp ls` was asked a history question.
pub fn wants_history(o: &Opts) -> bool {
    !o.formulas.is_empty()
        || o.crew.is_some()
        || o.workflow.is_some()
        || o.since.is_some()
        || o.over.contains_key("agent")
        || o.project.is_some()
}

async fn query(c: &Client, o: &Opts, cwd: &Path) -> Result<Vec<Value>> {
    let mut profiles = Vec::new();
    for f in &o.formulas {
        let (text, name) =
            wisp_resources_core::formula::Source::load(&mut crate::code::Files { cwd: cwd.to_owned() }, f, None).map_err(CliError::said)?;
        for doc in wisp_resources_core::formula::documents(&text, wisp_resources_core::formula::format_of(&name)).map_err(CliError::said)? {
            profiles.extend(doc.get("agents").and_then(Value::as_array).cloned().unwrap_or_default());
        }
        if profiles.is_empty() {
            return Err(CliError::said(format!("{f} declares no agents to look for")));
        }
    }
    let since = o.since.as_deref().map(|t| since_ms(t, now_ms())).transpose()?;
    let args = json!({ "agent": o.over.get("agent"), "crew": o.crew, "workflow": o.workflow, "project": o.project, "since": since, "profiles": profiles });
    let v = c.cmd("runtime.history", args).await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

fn lineage_words(l: &Value) -> String {
    let mut w = Vec::new();
    for (k, what) in [
        ("rerunOf", "rerun of"),
        ("forkOf", "fork of"),
        ("workflowRun", "step of"),
        ("triggeredBy", "started by"),
        ("crewJob", "crew job"),
        ("sharedFrom", "shared from"),
    ] {
        if let Some(v) = l.get(k).and_then(Value::as_str) {
            w.push(format!("{what} {v}"));
        }
    }
    w.join(" · ")
}

/// `wisp ls` with history filters.
pub async fn ls(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let rows = query(c, o, cwd).await?;
    if o.json {
        say(&serde_json::to_string_pretty(&rows).unwrap_or_default());
        return Ok(0);
    }
    let st = crate::cli::style();
    if rows.is_empty() {
        say("No tasks.");
    }
    for r in &rows {
        let agent =
            if s(r, "agent") == s(r, "harness") { s(r, "agent").to_owned() } else { format!("{} ({})", s(r, "agent"), s(r, "harness")) };
        let fam = lineage_words(&r["lineage"]);
        let line = format!(
            "{}  {:<7}  {:<18}  {}{}",
            s(r, "id"),
            s(r, "state"),
            term::truncate(&agent, 18),
            s(r, "title"),
            if fam.is_empty() { String::new() } else { paint(&st, DIM, &format!("  {fam}")) }
        );
        say(&term::truncate(&line, st.width.max(60)));
    }
    Ok(0)
}

/// `wisp task history <id>`.
pub async fn task_history(c: &Client, id: &str, json_out: bool) -> Result<i32> {
    let spec = c.cmd("runtime.spec", json!({ "id": id })).await?;
    let turns = c.cmd("runtime.turns", json!({ "id": id })).await?;
    let all = c.cmd("runtime.history", json!({})).await.unwrap_or(json!([]));
    let family: Vec<&Value> = all
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            ["rerunOf", "forkOf", "workflowRun", "sharedFrom"].iter().any(|k| r["lineage"].get(*k).and_then(Value::as_str) == Some(id))
        })
        .collect();
    if json_out {
        say(&serde_json::to_string_pretty(&json!({ "spec": spec, "turns": turns, "family": family })).unwrap_or_default());
        return Ok(0);
    }
    let st = crate::cli::style();
    say(&format!(
        "{} {}",
        paint(&st, BOLD, id),
        paint(
            &st,
            DIM,
            &format!(
                "{}{}",
                s(&spec, "agent"),
                spec.get("formula").and_then(Value::as_str).map(|h| format!(" · ran with @{h}")).unwrap_or_default()
            )
        )
    ));
    let fam = lineage_words(&spec["lineage"]);
    if !fam.is_empty() {
        say(&format!("  {fam}"));
    }
    if let Some(b) = spec.get("base").filter(|b| b.is_object()) {
        say(&format!("  from {} {}", s(b, "branch"), s(b, "sha").get(..10).unwrap_or("")));
    }
    for t in turns.as_array().into_iter().flatten() {
        let mark = if s(t, "status") == "done" { paint(&st, GREEN, "✓") } else { s(t, "status").to_owned() };
        say(&term::truncate(&format!("  {mark} {}  {}", t["idx"], s(t, "prompt").lines().next().unwrap_or("")), st.width.max(60)));
    }
    for f in family {
        say(&format!("  ↳ {}  {}  {}", s(f, "id"), s(f, "state"), lineage_words(&f["lineage"])));
    }
    Ok(0)
}

/// `wisp history export [--since 30d]`: JSONL, scrubbed.
pub async fn export(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let rows = query(c, o, cwd).await?;
    let scrub = wisp_share_core::Scrub {
        env: wisp_share_core::secret_env(std::env::vars()),
        project: String::new(),
        home: std::env::var("HOME").unwrap_or_default(),
        names: Vec::new(),
    };
    let mut out = std::io::stdout().lock();
    for r in rows {
        let id = s(&r, "id").to_owned();
        let spec = c.cmd("runtime.spec", json!({ "id": id })).await.unwrap_or_default();
        let turns = c.cmd("runtime.turns", json!({ "id": id })).await.unwrap_or_default();
        let brief: Vec<Value> = turns.as_array().into_iter().flatten().map(|t| json!({ "idx": t["idx"], "prompt": t["prompt"], "status": t["status"], "text": t["text"], "stats": t["stats"], "startedAt": t["startedAt"], "endedAt": t["endedAt"] })).collect();
        let line = json!({ "task": r, "spec": spec, "turns": brief });
        let clean = wisp_share_core::scrub(&line, &scrub, "", &mut Vec::new());
        let _ = writeln!(out, "{clean}");
    }
    Ok(0)
}

/// The lineage line `wisp show` adds.
pub async fn lineage_line(c: &Client, id: &str) -> Option<String> {
    let spec = c.cmd("runtime.spec", json!({ "id": id })).await.ok()?;
    let mut parts = vec![lineage_words(&spec["lineage"])];
    if let Some(h) = spec.get("formula").and_then(Value::as_str) {
        parts.push(format!("ran with @{h}"));
    }
    if let Some(sha) = spec.pointer("/base/sha").and_then(Value::as_str) {
        parts.push(format!("from {}", sha.get(..10).unwrap_or(sha)));
    }
    let l: Vec<String> = parts.into_iter().filter(|p| !p.is_empty()).collect();
    (!l.is_empty()).then(|| format!("  {}", l.join(" · ")))
}

/// `wisp import [v1 home] [--dry-run] [--yes]`.
pub async fn import(c: &Client, o: &Opts, home: &Path) -> Result<i32> {
    let v1 = o.words.first().map_or_else(|| home.to_owned(), |p| Path::new(p).to_owned());
    let file = v1.join("config.json");
    let text =
        std::fs::read_to_string(&file).map_err(|e| CliError::said(format!("{}: {e} (wisp import [v1 home folder])", file.display())))?;
    let cfg: Value = serde_json::from_str(&text).map_err(|e| CliError::said(format!("{}: {e}", file.display())))?;
    let (resources, notes) = crate::v1_formula::formula_of(&cfg);
    let st = crate::cli::style();
    let args = json!({ "resources": resources, "prune": false });
    let plan: Plan = serde_json::from_value(c.cmd("resources.plan", args.clone()).await?).map_err(|e| CliError::said(e.to_string()))?;
    say(&format!("{} {}", paint(&st, BOLD, "Import plan"), paint(&st, DIM, &format!("(v1 home {})", v1.display()))));
    crate::code::show_plan(&plan, &st);
    for n in &notes {
        say(&format!("  {} {n}", paint(&st, DIM, "·")));
    }
    let sessions = v1.join("sessions");
    let n = std::fs::read_dir(&sessions)
        .map_or(0, |d| d.filter_map(std::result::Result::ok).filter(|e| e.path().extension().is_some_and(|x| x == "json")).count());
    say(&format!("  and the history of {n} task{} (tasks are history: they're imported, never planned)", if n == 1 { "" } else { "s" }));
    if o.dry_run {
        return Ok(i32::from(!plan.problems.is_empty()));
    }
    if !plan.problems.is_empty() {
        return Ok(1);
    }
    if !o.yes {
        if !(std::io::stdin().is_terminal() && std::io::stdout().is_terminal()) {
            eprintln!("  ✗ not a terminal: import with --yes");
            return Ok(1);
        }
        let mut line = String::new();
        let mut so = std::io::stdout().lock();
        let _ = write!(so, "\n  Import it? [y/N] ");
        let _ = so.flush();
        let _ = std::io::stdin().read_line(&mut line);
        if !matches!(line.trim(), "y" | "Y" | "yes") {
            say("  nothing imported");
            return Ok(1);
        }
    }
    let done = c.cmd("resources.apply", args).await?;
    say(&format!("  {} applied {} change{}", paint(&st, GREEN, "✓"), done["applied"], if done["applied"] == 1 { "" } else { "s" }));
    if n > 0 {
        let r = c.cmd("runtime.import", json!({ "dir": sessions.display().to_string() })).await?;
        say(&format!(
            "  {} {} task{} imported, {} unchanged",
            paint(&st, GREEN, "✓"),
            r["imported"],
            if r["imported"] == 1 { "" } else { "s" },
            r["skipped"]
        ));
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_reads_days_hours_minutes_weeks() {
        assert_eq!(since_ms("7d", 1_000_000_000).unwrap(), 1_000_000_000 - 7 * 86_400_000);
        assert_eq!(since_ms("12h", 0).unwrap(), -12 * 3_600_000);
        assert_eq!(since_ms("3", 0).unwrap(), -3 * 86_400_000);
        assert!(since_ms("soon", 0).is_err());
    }
}
