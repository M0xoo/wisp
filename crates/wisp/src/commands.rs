//! `wisp <command>` for the curated verbs that talk to a running wisp (one starts if none answers), all
//! on v2's commands (ADR-0031): launch, ls, show, wait, reply, btw, stop, ship, merge, recipes, run,
//! plugin, crew.
use std::time::Duration;

use serde_json::{Value, json};

use crate::args::Parsed;
use crate::client::{CliError, Client, Result};
use crate::scripted::{self as sc, need, out};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
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
            let r = c.cmd("runtime.btw", json!({ "id": id, "question": need(Some(&q), "question")? })).await?;
            sc::btw_out(f, &sc::btw_answer(&c, id, s(&r, "id")).await?);
            Ok(())
        }
        "stop" => {
            let r = c.cmd("runtime.stop", json!({ "id": need(args.first(), "session id")? })).await?;
            out(f, &r, "  ✓ stopped");
            Ok(())
        }
        "ship" => {
            let id = need(args.first(), "session id")?;
            let task = c.cmd("runtime.get", json!({ "id": id })).await?;
            let pr = c.cmd("ship.ship", json!({ "session": id, "title": s(&task, "title"), "draft": f.draft })).await?;
            let draft = if f.draft { " (draft)" } else { "" };
            out(
                f,
                &pr,
                &format!("  ✓ shipped{draft}: {}", pr.pointer("/pr/url").or_else(|| pr.get("url")).and_then(Value::as_str).unwrap_or("")),
            );
            Ok(())
        }
        "merge" => {
            let r = c.cmd("ship.merge", json!({ "session": need(args.first(), "session id")? })).await?;
            out(f, &r, "  ✓ merged");
            Ok(())
        }
        "recipes" => recipes(&c, f).await,
        "run" => recipe_run(&c, p, args, cwd).await,
        "plugin" | "plugins" => crate::plugin_cmd::run(&c, p, args).await,
        "crew" => crate::plugin_cmd::crew(&c, p, args).await,
        other => Err(CliError::said(format!("unknown command {other}"))),
    }
}

/// `--compare a[:model],b`: one task per harness, the same ask (ADR-0027: compare is reruns side by side).
async fn launch(c: &Client, p: &Parsed, args: &[String], cwd: &str) -> Result<()> {
    let f = &p.flags;
    if !f.tries.is_empty() {
        return Err(CliError::said("--try was v1's trial run: run it twice with --compare, or wisp rerun <id> --formula f.yml"));
    }
    let prompt = args.join(" ");
    let mut made = Vec::new();
    if let Some(runs) = &f.compare {
        // one group for the runs: the task's More then offers Compare runs (v1 compare.js, F-comp-30)
        let group = format!("g-{}", crate::services::hex(&rand::random::<[u8; 8]>()));
        for r in runs {
            let mut a = sc::launch_args(f, &prompt, cwd);
            a["ext"] = json!({ "wisp.runtime": { "group": group } });
            a["agent"] = json!(r.agent);
            if let Some(m) = &r.model {
                a["model"] = json!(m);
            }
            made.push(c.cmd("runtime.create", a).await?);
        }
    } else {
        let mut a = sc::launch_args(f, &prompt, cwd);
        let home =
            crate::services::home(std::env::var("WISP_HOME").ok().as_deref(), std::env::var_os("HOME").map(std::path::PathBuf::from));
        crate::termctx_cli::attach(c, p, &mut a, &prompt, cwd, &home).await;
        made.push(c.cmd("runtime.create", a).await?);
    }
    if !f.wait {
        let lines: Vec<String> = made.iter().map(|m| format!("  ◌ launched: {}  wisp attach {}", s(m, "id"), s(m, "id"))).collect();
        out(f, &json!(made), &lines.join("\n"));
        return Ok(());
    }
    for m in &made {
        let id = s(m, "id").to_owned();
        if !f.json {
            eprintln!("  ◌ launched: {id} — waiting…");
        }
        let w = sc::wait(c, &id, Duration::from_secs(30 * 60)).await?;
        sc::show(c, f, &id, Some(w)).await?;
    }
    Ok(())
}

/// `wisp recipes`: the declared tasks (`tasks:` in a formula; recipes are tasks with `{params}`).
async fn recipes(c: &Client, f: &crate::args::Flags) -> Result<()> {
    let list = c.cmd("automations.tasks", json!({})).await?;
    let lines: Vec<String> = list
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let params = wisp_automations_params(s(r, "prompt"));
            let prompt: String = s(r, "prompt").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
            format!("{:<24}  {:<20}  {prompt}", s(r, "name"), params)
        })
        .collect();
    out(
        f,
        &list,
        &if lines.is_empty() {
            "No declared tasks yet: add some under tasks: in a formula (wisp apply -f).".into()
        } else {
            lines.join("\n")
        },
    );
    Ok(())
}

fn wisp_automations_params(prompt: &str) -> String {
    let mut out = Vec::new();
    let mut rest = prompt;
    while let Some(a) = rest.find('{') {
        let Some(b) = rest[a..].find('}') else { break };
        out.push(rest[a..=a + b].to_owned());
        rest = &rest[a + b + 1..];
    }
    out.join(" ")
}

/// `wisp run <name> [values]` reached here: no workflow or declared task has that name, so it's a task.
async fn recipe_run(c: &Client, p: &Parsed, args: &[String], cwd: &str) -> Result<()> {
    let mut all = vec!["run".to_owned()];
    all.extend(args.iter().cloned());
    let m = c.cmd("runtime.create", sc::launch_args(&p.flags, &all.join(" "), cwd)).await?;
    out(&p.flags, &m, &format!("  ◌ launched: {}  wisp attach {}", s(&m, "id"), s(&m, "id")));
    Ok(())
}
