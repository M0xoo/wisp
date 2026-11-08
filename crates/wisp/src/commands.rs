//! `wisp <command>` for every command that talks to a running wisp (starting a headless one if none
//! answers). Spells are plugins in v2: `wisp spell …` is `wisp plugin …`, over the same v1 routes the
//! plugins plugin keeps (`/api/spells…`).
use std::time::Duration;

use serde_json::{Value, json};

use crate::args::Parsed;
use crate::client::{CliError, Client, Result};
use crate::scripted::{self as sc, need, out};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn enc(x: &str) -> String {
    x.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[allow(clippy::many_single_char_names)]
pub async fn run(p: &Parsed, cmd: &str, args: &[String], cwd: &str, port: u16) -> Result<()> {
    let f = &p.flags;
    let c = Client::connect(port, true).await?;
    match cmd {
        "launch" => launch(&c, p, args, cwd).await,
        "ls" | "list" => sc::ls(&c, f).await,
        "show" => sc::show(&c, f, need(args.first(), "session id")?, None).await,
        "wait" => {
            let id = need(args.first(), "session id")?;
            let w = sc::wait(&c, id, Duration::from_secs(30 * 60)).await?;
            sc::show(&c, f, id, Some(w)).await
        }
        "reply" => sc::reply(&c, f, args).await,
        "btw" => {
            let id = need(args.first(), "session id")?;
            let q = args[1..].join(" ");
            let r = c.post(&format!("/sessions/{id}/btw"), json!({"text": need(Some(&q), "question")?})).await?;
            sc::btw_out(f, &sc::btw_answer(&c, id, s(&r, "id")).await?);
            Ok(())
        }
        "stop" => {
            let r = c.post(&format!("/sessions/{}/stop", need(args.first(), "session id")?), json!({})).await?;
            out(f, &r, "  ✓ stopped");
            Ok(())
        }
        "ship" => {
            let pr = c.post(&format!("/sessions/{}/ship", need(args.first(), "session id")?), json!({"draft": f.draft})).await?;
            let draft = if pr.get("draft") == Some(&json!(true)) { " (draft)" } else { "" };
            out(f, &pr, &format!("  ✓ PR #{}{draft}: {}", pr.get("number").unwrap_or(&Value::Null), s(&pr, "url")));
            Ok(())
        }
        "merge" => {
            let r = c.post(&format!("/sessions/{}/merge", need(args.first(), "session id")?), json!({})).await?;
            let ok = if r.pointer("/sync/ok") == Some(&json!(true)) { "✓" } else { "!" };
            out(f, &r, &format!("  ✓ merged PR #{}\n  {ok} {}", r.pointer("/pr/number").unwrap_or(&Value::Null), r.pointer("/sync/text").and_then(Value::as_str).unwrap_or("")));
            Ok(())
        }
        "recipes" => recipes(&c, f).await,
        "run" => recipe_run(&c, p, args, cwd).await,
        "usage" => usage(&c, f).await,
        "spell" | "spells" | "plugin" | "plugins" => crate::plugin_cmd::run(&c, p, args).await,
        "crew" => crate::plugin_cmd::crew(&c, p, args, cwd).await,
        "computer" => crate::plugin_cmd::computer(&c, p, args).await,
        other => Err(CliError::said(format!("unknown command {other}"))),
    }
}

async fn launch(c: &Client, p: &Parsed, args: &[String], cwd: &str) -> Result<()> {
    let f = &p.flags;
    if let Some(why) = sc::try_problem(f).filter(|_| !f.tries.is_empty()) {
        return Err(CliError::said(why));
    }
    let tried = if f.tries.is_empty() { None } else { Some(sc::try_runs(&f.tries)?) };
    let body = sc::launch_body(c, f, args.join(" "), cwd, tried).await?;
    let sess = c.post("/sessions", body).await?;
    if let (Some(group), false) = (sess.get("group").and_then(Value::as_array), f.wait) {
        out(f, &sess, &group.iter().map(|x| format!("  ◌ launched on {}: {}  ({})", s(x, "agent"), s(x, "title"), s(x, "id"))).collect::<Vec<_>>().join("\n"));
        return Ok(());
    }
    if !f.wait {
        out(f, &sess, &format!("  ◌ launched: {}  ({})", s(&sess, "title"), s(&sess, "id")));
        return Ok(());
    }
    if !f.json {
        eprintln!("  ◌ launched: {}  ({}) — waiting…", s(&sess, "title"), s(&sess, "id"));
    }
    let id = s(&sess, "id").to_owned();
    let w = sc::wait(c, &id, Duration::from_secs(30 * 60)).await?;
    sc::show(c, f, &id, Some(w)).await
}

async fn recipes(c: &Client, f: &crate::args::Flags) -> Result<()> {
    let list = c.get("/recipes").await?;
    let lines: Vec<String> = list
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let params: Vec<String> = r.get("params").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|x| format!("{{{x}}}")).collect();
            let prompt: String = s(r, "prompt").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
            format!("{:<24}  {:<20}  {prompt}", s(r, "name"), params.join(" "))
        })
        .collect();
    out(f, &list, &if lines.is_empty() { "No recipes yet. Save one from wisp (⌘K → Recipes).".into() } else { lines.join("\n") });
    Ok(())
}

async fn recipe_run(c: &Client, p: &Parsed, args: &[String], cwd: &str) -> Result<()> {
    let f = &p.flags;
    let key = need(args.first(), "recipe name")?;
    let is_kv = |a: &String| a.split_once('=').is_some_and(|(k, _)| k.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    let kv: serde_json::Map<String, Value> = args[1..].iter().filter(|a| is_kv(a)).filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_owned(), json!(v)))).collect();
    let words: Vec<&String> = args[1..].iter().filter(|a| !is_kv(a)).collect();
    let body = json!({"params": kv, "words": words, "cwd": cwd, "agent": f.agent, "model": f.model, "effort": f.effort, "mode": f.mode});
    let sess = match c.post(&format!("/recipes/{}/run", enc(key)), body).await {
        Err(e) if e.status() == 404 => {
            let mut all = vec!["run".to_owned()];
            all.extend(args.iter().cloned());
            c.post("/sessions", sc::launch_body(c, f, all.join(" "), cwd, None).await?).await?
        }
        r => r?,
    };
    if !f.wait {
        out(f, &sess, &format!("  ◌ launched: {}  ({})", s(&sess, "title"), s(&sess, "id")));
        return Ok(());
    }
    let id = s(&sess, "id").to_owned();
    let w = sc::wait(c, &id, Duration::from_secs(30 * 60)).await?;
    sc::show(c, f, &id, Some(w)).await
}

async fn usage(c: &Client, f: &crate::args::Flags) -> Result<()> {
    let u = c.get(&format!("/usage?days={}", f.days.unwrap_or(30))).await?;
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let pct = |v: &Value| v.get("successRate").and_then(Value::as_f64).map_or("—".to_owned(), |x| format!("{}%", (x * 100.0).round()));
    let rows = |key: &str, label: &dyn Fn(&Value) -> String| -> String {
        u.get(key).and_then(Value::as_array).into_iter().flatten().map(|x| format!("  {:<32}  {:>8}  {:>5} turns  {:>4} ok", label(x).chars().take(32).collect::<String>(), format!("${:.2}", num(x, "cost")), num(x, "turns"), pct(x))).collect::<Vec<_>>().join("\n")
    };
    let t = u.get("total").cloned().unwrap_or_default();
    let text = format!(
        "Last {} days: ${:.2} · {} turns in {} sessions · {} worked · {} questions\n\nBy project\n{}\n\nBy harness · model\n{}",
        num(&u, "days"),
        num(&t, "cost"),
        num(&t, "turns"),
        num(&t, "sessions"),
        pct(&t),
        num(&t, "questions"),
        rows("projects", &|x| s(x, "name").to_owned()),
        rows("runners", &|x| format!("{} · {}", s(x, "agent"), if s(x, "model").is_empty() { "default" } else { s(x, "model") })),
    );
    out(f, &u, &text);
    Ok(())
}
