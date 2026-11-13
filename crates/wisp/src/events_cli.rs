//! `wisp events …` (ADR-0044): the durable event log from the terminal.
//!
//! - `wisp events tail [--type glob] [--subject id] [--since seq] [--limit n] [--follow] [--json]`
//! - `wisp events why <seq>`: what caused it, root first
//! - `wisp events retry <seq>`, `wisp events parked`: what a subscription gave up on
//! - `wisp events ls`: every type wisp emits, durable or not
use serde_json::{Value, json};
use wisp_cli_core::term::{DIM, paint};

use crate::client::{CliError, Client, Result};
use crate::scripted::say;

fn flag<'a>(argv: &'a [String], name: &str) -> Option<&'a str> {
    argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).map(String::as_str)
}

/// One event, as a line: `#12  turn.finished  <subject>  <at>` (or its JSON).
pub fn line(v: &Value, json: bool) -> String {
    if json {
        return v.to_string();
    }
    let st = crate::cli::style();
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(0);
    let cause = v.get("cause").and_then(Value::as_u64).map(|c| format!("  ← #{c}")).unwrap_or_default();
    format!("#{seq:<6} {:<22} {}{}", s("type"), s("subject"), paint(&st, DIM, &cause))
}

/// The topic for a type glob: `events:*`, `events:<area>.*` or `events:<type>`.
pub fn topic_of(glob: &str) -> std::result::Result<String, String> {
    let t = format!("events:{glob}");
    if glob == "*" || glob.strip_suffix(".*").is_some_and(|a| !a.contains('*')) || !glob.contains('*') {
        Ok(t)
    } else {
        Err(format!("--follow takes *, <area>.* or a type (not {glob})"))
    }
}

pub async fn run(c: &Client, argv: &[String], json: bool) -> Result<i32> {
    let at = argv.iter().position(|a| a == "events").map_or(0, |i| i + 1);
    let rest = &argv[at.min(argv.len())..];
    let verb = rest.first().map_or("tail", String::as_str);
    let arg1 = rest.get(1).filter(|a| !a.starts_with('-')).and_then(|a| a.trim_start_matches('#').parse::<u64>().ok());
    match verb {
        "tail" => {
            let ty = flag(rest, "--type").unwrap_or("*");
            let subject = flag(rest, "--subject");
            if rest.iter().any(|a| a == "--follow" || a == "-f") {
                let topic = topic_of(ty).map_err(CliError::said)?;
                return crate::attach::events_follow(c, &topic, subject, json).await;
            }
            let mut args = json!({ "type": ty });
            if let Some(s) = subject {
                args["subject"] = json!(s);
            }
            if let Some(s) = flag(rest, "--since").and_then(|s| s.parse::<u64>().ok()) {
                args["since"] = json!(s);
            }
            if let Some(n) = flag(rest, "--limit").and_then(|s| s.parse::<u32>().ok()) {
                args["limit"] = json!(n);
            }
            let list = c.cmd("events.tail", args).await?;
            for v in list.as_array().into_iter().flatten() {
                say(&line(v, json));
            }
            Ok(0)
        }
        "why" => {
            let seq = arg1.ok_or_else(|| CliError::said("wisp events why <seq>"))?;
            let chain = c.cmd("events.why", json!({ "seq": seq })).await?;
            for (i, v) in chain.as_array().into_iter().flatten().enumerate() {
                say(&format!("{}{}", "  ".repeat(i), line(v, json)));
            }
            Ok(0)
        }
        "retry" => {
            let seq = arg1.ok_or_else(|| CliError::said("wisp events retry <seq>"))?;
            let v = c.cmd("events.retry", json!({ "seq": seq })).await?;
            say(&format!("  ✓ delivered again to {} subscription(s)", v["delivered"]));
            Ok(0)
        }
        "parked" => {
            let v = c.cmd("events.parked", json!({})).await?;
            for p in v.as_array().into_iter().flatten() {
                say(&format!(
                    "#{:<6} {}/{}  {}",
                    p["seq"],
                    p["plugin"].as_str().unwrap_or(""),
                    p["name"].as_str().unwrap_or(""),
                    p["why"].as_str().unwrap_or("")
                ));
            }
            Ok(0)
        }
        "ls" => {
            let v = c.cmd("events.ls", json!({})).await?;
            if json {
                say(&v.to_string());
                return Ok(0);
            }
            for e in v.as_array().into_iter().flatten() {
                let d = if e["durable"] == json!(true) { "durable" } else { "" };
                say(&format!("{:<26} {:<8} {}", e["type"].as_str().unwrap_or(""), d, e["plugin"].as_str().unwrap_or("")));
            }
            Ok(0)
        }
        other => Err(CliError::said(format!("wisp events {other}: tail, why, retry, parked or ls"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follow_takes_the_topics_rows_are_on() {
        assert_eq!(topic_of("*").as_deref(), Ok("events:*"));
        assert_eq!(topic_of("pr.*").as_deref(), Ok("events:pr.*"));
        assert_eq!(topic_of("turn.finished").as_deref(), Ok("events:turn.finished"));
        assert!(topic_of("*.finished").is_err());
    }
}
