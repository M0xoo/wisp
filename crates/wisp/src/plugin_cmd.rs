//! `wisp plugin …` (v1's `wisp spell …`: spells are plugins now), `wisp crew …` and `wisp computer …`.
//! `plugin new` writes files and needs no running wisp; everything else goes over v1's routes.
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::args::Parsed;
use crate::client::{CliError, Client, Result};
use crate::scripted::{need, out, say};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn enc(x: &str) -> String {
    x.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// A file or a link (https, gist:<id>) as the import routes take it.
fn source(src: &str) -> Result<Value> {
    let lower = src.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("gist:") {
        return Ok(json!({"url": src}));
    }
    let text = std::fs::read_to_string(src).map_err(|e| CliError::said(format!("{src}: {e}")))?;
    let name = Path::new(src).file_name().map(|n| n.to_string_lossy().into_owned());
    Ok(json!({"text": text, "name": name}))
}

fn line(p: &Value) -> String {
    let on = if p.get("enabled") == Some(&json!(true)) { "●" } else { "○" };
    let desc = if s(p, "description").is_empty() { String::new() } else { format!(" — {}", s(p, "description")) };
    format!("{on} {:<24} {:<8} {:<5}  {}{desc}", s(p, "id"), format!("v{}", s(p, "version")), s(p, "kind"), s(p, "name"))
}

#[allow(clippy::many_single_char_names)]
pub async fn run(c: &Client, p: &Parsed, args: &[String]) -> Result<()> {
    let f = &p.flags;
    let sub = args.first().map_or("ls", String::as_str);
    let rest = &args[args.len().min(1)..];
    match sub {
        "ls" | "list" => {
            let r = c.get("/spells").await?;
            let mut lines: Vec<String> = Vec::new();
            if r.get("safe") == Some(&json!(true)) {
                lines.push("! safe mode: every plugin of yours is off".into());
            }
            lines.extend(r.get("spells").and_then(Value::as_array).into_iter().flatten().map(line));
            lines.extend(r.get("broken").and_then(Value::as_array).into_iter().flatten().map(|b| format!("! {}: {}", s(b, "id"), s(b, "error"))));
            out(f, &r, &if lines.is_empty() { "No plugins of yours yet. Start one: wisp plugin new my-button".into() } else { lines.join("\n") });
            Ok(())
        }
        "install" | "add" => {
            let body = source(need(rest.first(), "a plugin file or a link")?)?;
            let check = c.post("/spells/check", body.clone()).await?;
            if check.get("ok") != Some(&json!(true)) {
                let probs: Vec<&str> = check.get("problems").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                return Err(CliError::said(format!("That plugin has problems:\n- {}", probs.join("\n- "))));
            }
            let mut b = body;
            b["enable"] = json!(f.on);
            let r = c.post("/spells", b).await?;
            let sp = r.get("spell").cloned().unwrap_or_default();
            let state = if sp.get("enabled") == Some(&json!(true)) { ", on".to_owned() } else { format!(" — off; turn it on with: wisp plugin enable {}", s(&sp, "id")) };
            out(f, &r, &format!("  ✓ {} {} ({} v{}){state}", if r.get("updated") == Some(&json!(true)) { "updated" } else { "added" }, s(&sp, "name"), s(&sp, "id"), s(&sp, "version")));
            Ok(())
        }
        "on" | "off" | "enable" | "disable" => {
            let on = matches!(sub, "on" | "enable");
            if !on && f.all {
                let r = c.post("/spells/off", json!({})).await?;
                out(f, &r, "  ✓ every plugin of yours is off");
                return Ok(());
            }
            let id = need(rest.first(), "plugin id")?;
            let r = c.request("PATCH", &format!("/spells/{}", enc(id)), Some(json!({"enabled": on}))).await?;
            out(f, &r, &format!("  ✓ {} is {}", if s(&r, "name").is_empty() { id } else { s(&r, "name") }, if on { "on" } else { "off" }));
            Ok(())
        }
        "rm" | "remove" => {
            let r = c.request("DELETE", &format!("/spells/{}", enc(need(rest.first(), "plugin id")?)), None).await?;
            out(f, &r, "  ✓ removed");
            Ok(())
        }
        "export" => {
            let r = c.get(&format!("/spells/{}/export", enc(need(rest.first(), "plugin id")?))).await?;
            say(&serde_json::to_string_pretty(&r).unwrap_or_default());
            Ok(())
        }
        "cast" => {
            let what = rest.join(" ");
            let body = json!({"prompt": need(Some(&what), "what to change")?, "kind": "spell", "agent": f.agent, "model": f.model, "effort": f.effort});
            let r = c.post("/sessions", body).await?;
            out(f, &r, &format!("  🧙 casting: {}  ({})\n  Try it and keep it from its card in wisp.", s(&r, "title"), s(&r, "id")));
            Ok(())
        }
        other => Err(CliError::said(format!("unknown: wisp plugin {other} (ls, new, enable, disable, install, rm, export, cast)"))),
    }
}

pub async fn crew(c: &Client, p: &Parsed, args: &[String], cwd: &str) -> Result<()> {
    let f = &p.flags;
    match args.first().map_or("ls", String::as_str) {
        "ls" | "list" => {
            let list = c.get("/crew").await?;
            let lines: Vec<String> = list.as_array().into_iter().flatten().map(|m| {
                let on = if m.get("paused") == Some(&json!(true)) { "○" } else { "●" };
                let cron = if s(m, "cron").is_empty() { "on call" } else { s(m, "cron") };
                format!("{on} {:<24} {:<20} {cron}", s(m, "name"), s(m, "role"))
            }).collect();
            out(f, &list, &if lines.is_empty() { "No crew yet. Add someone in wisp, or import a shared one: wisp crew import scout.crew.json".into() } else { lines.join("\n") });
            Ok(())
        }
        "import" => {
            let src = need(args.get(1), "a .crew.json file or a link")?;
            let mut body = source(src)?;
            body["dryRun"] = json!(true);
            let review = c.post("/crew/import", body.clone()).await?;
            if review.get("spell").is_some_and(|v| !v.is_null()) {
                return Err(CliError::said(format!("That is a plugin: wisp plugin install {src}")));
            }
            let choices: serde_json::Map<String, Value> = review.get("members").and_then(Value::as_array).into_iter().flatten().map(|m| (s(m, "key").to_owned(), json!({"cwd": cwd}))).collect();
            body["dryRun"] = json!(false);
            body["choices"] = Value::Object(choices);
            let r = c.post("/crew/import", body).await?;
            let mut lines: Vec<String> = r.get("members").and_then(Value::as_array).into_iter().flatten().map(|m| format!("  ✓ added {}, paused", s(m, "name"))).collect();
            lines.push("  Resume them in wisp to start.".into());
            out(f, &r, &lines.join("\n"));
            Ok(())
        }
        "export" => {
            let r = c.post("/crew/export", json!({"ids": &args[1..], "kit": f.kit, "notebook": f.notebook, "team": f.team, "gist": f.gist})).await?;
            for n in r.get("notes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                eprintln!("  · {n}");
            }
            if let Some(g) = r.get("gist").filter(|g| !g.is_null()) {
                out(f, &r, &format!("  ✓ secret gist: {}\n  Share it as {}: they run  wisp crew import {}", s(g, "url"), s(g, "ref"), s(g, "ref")));
            } else {
                say(&serde_json::to_string_pretty(r.get("bundle").unwrap_or(&Value::Null)).unwrap_or_default());
            }
            Ok(())
        }
        other => Err(CliError::said(format!("unknown: wisp crew {other} (ls, import, export)"))),
    }
}

fn host_of(u: &str) -> String {
    let u = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(u);
    u.split('/').next().unwrap_or(u).to_owned()
}

fn computer_line(v: &Value) -> String {
    if v.get("cloud") == Some(&json!(true)) {
        return "  ● this is a cloud computer: it’s on its grid already".into();
    }
    if v.get("on") == Some(&json!(true)) {
        let err = if s(v, "error").is_empty() { String::new() } else { format!(" ({})", s(v, "error")) };
        return format!("  ● {} is on {}: {}{err}\n    {}", s(v, "name"), host_of(s(v, "grid")), s(v, "state"), s(v, "url"));
    }
    let why = if s(v, "error").is_empty() { String::new() } else { format!("{} ", s(v, "error")) };
    match v.get("account").filter(|a| !a.is_null()) {
        Some(a) => format!("  ○ off. {why}Signed in to {} as {}: wisp computer on adds it", host_of(s(a, "grid")), s(a, "handle")),
        None => format!("  ○ off. {why}wisp computer on signs in to a wisp Grid and adds it"),
    }
}

pub async fn computer(c: &Client, p: &Parsed, args: &[String]) -> Result<()> {
    let f = &p.flags;
    match args.first().map_or("status", String::as_str) {
        "status" => {
            let v = c.get("/computer").await?;
            out(f, &v, &computer_line(&v));
            Ok(())
        }
        "off" => {
            let r = c.post("/computer", json!({"on": false})).await?;
            out(f, &r, "  ✓ off: this computer left the grid");
            Ok(())
        }
        "on" => {
            let mut v = c.get("/computer").await?;
            if v.get("cloud") != Some(&json!(true)) {
                let at = if v.get("on") == Some(&json!(true)) { s(&v, "grid").to_owned() } else { v.pointer("/account/grid").and_then(Value::as_str).unwrap_or("").to_owned() };
                if let (Some(want), false) = (f.grid.as_deref().map(host_of), at.is_empty())
                    && host_of(&at) != want {
                        return Err(CliError::said(format!("this computer uses {}. To move it, run wisp computer off and sign out of {} in Machines first.", host_of(&at), host_of(&at))));
                    }
                if v.get("account").is_none_or(Value::is_null) {
                    sign_in(c, f.grid.as_deref().unwrap_or("grid.trywisp.dev")).await?;
                }
                if c.get("/computer").await?.get("on") != Some(&json!(true)) {
                    c.post("/computer", json!({"on": true})).await?;
                }
                // the tunnel comes up a moment after the grid has the computer: wait a little for it
                let end = Instant::now() + Duration::from_secs(15);
                v = c.get("/computer").await?;
                while v.get("on") == Some(&json!(true)) && s(&v, "state") != "online" && Instant::now() < end {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    v = c.get("/computer").await?;
                }
            }
            out(f, &v, &computer_line(&v));
            Ok(())
        }
        other => Err(CliError::said(format!("unknown: wisp computer {other} (status, on, off)"))),
    }
}

/// The device sign-in from the terminal: print the code, wait for the browser.
async fn sign_in(c: &Client, grid: &str) -> Result<()> {
    let mut f = c.post("/cloud/signin", json!({"url": grid, "addComputer": true})).await?;
    eprintln!("\n  Sign in to {} and allow this code: {}\n    {}\n\n  Waiting for the browser… (Ctrl-C cancels)", host_of(s(&f, "grid")), s(&f, "userCode"), s(&f, "verifyUrl"));
    let id = s(&f, "id").to_owned();
    while s(&f, "state") == "waiting" {
        tokio::time::sleep(Duration::from_secs(1)).await;
        f = c.get(&format!("/cloud/signin/{id}")).await?;
    }
    if s(&f, "state") != "done" {
        return Err(CliError::said(if s(&f, "error").is_empty() { format!("sign-in {}", s(&f, "state")) } else { s(&f, "error").to_owned() }));
    }
    eprintln!("  ✓ signed in as {}", f.pointer("/user/handle").and_then(Value::as_str).unwrap_or("you"));
    Ok(())
}

/// `wisp plugin new <name>`: a declarative plugin of your own, off until you switch it on.
pub fn new_plugin(home: &Path, name: &str) -> Result<std::path::PathBuf> {
    let slug: String = name.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().trim_matches('-').to_owned();
    if slug.is_empty() {
        return Err(CliError::said("a plugin name has letters or digits"));
    }
    let dir = home.join("plugins").join(&slug);
    if dir.join("wisp-plugin.json").exists() {
        return Err(CliError::said(format!("{} exists already", dir.display())));
    }
    std::fs::create_dir_all(&dir)?;
    let manifest = json!({
        "wispPlugin": 1, "id": format!("user.{slug}"), "name": name, "version": "0.1.0", "api": "^1",
        "description": "", "kind": "plugin", "permissions": [], "activation": [], "contributes": {}
    });
    std::fs::write(dir.join("wisp-plugin.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n")?;
    std::fs::write(dir.join("README.md"), format!("# {name}\n\nA wisp plugin. Its whole static truth is `wisp-plugin.json`: what it adds (`contributes`) and what it may do (`permissions`).\nSwitch it on with `wisp plugin enable user.{slug}`.\n"))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_plugin_writes_a_valid_manifest() {
        let home = std::env::temp_dir().join(format!("wisp-pnew-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = new_plugin(&home, "My Button!").unwrap();
        assert!(dir.ends_with("plugins/my-button"));
        let m = wisp_kernel::Manifest::parse(&std::fs::read_to_string(dir.join("wisp-plugin.json")).unwrap()).unwrap();
        assert_eq!(m.id, "user.my-button");
        assert!(new_plugin(&home, "my button").is_err(), "never overwrites");
        assert!(new_plugin(&home, "!!!").is_err());
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://grid.trywisp.dev/x"), "grid.trywisp.dev");
        assert_eq!(host_of("grid.example"), "grid.example");
    }
}
