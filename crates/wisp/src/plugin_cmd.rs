//! `wisp plugin …` and `wisp crew`, on v2's commands (ADR-0031): `plugins.list`, `plugins.setEnabled`,
//! `crew.list`. `plugin new` writes files and needs no running wisp. Sharing a crew is a formula now
//! (`wisp export crew > team.yml`, `wisp apply -f team.yml`).
use std::path::Path;

use serde_json::{Value, json};

use crate::args::Parsed;
use crate::client::{CliError, Client, Result};
use crate::scripted::{need, out};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn line(p: &Value) -> String {
    let on = if p.get("enabled") == Some(&json!(true)) { "●" } else { "○" };
    let desc = if s(p, "description").is_empty() { String::new() } else { format!(" — {}", s(p, "description")) };
    format!("{on} {:<24} {:<8} {:<8}{desc}", s(p, "id"), format!("v{}", s(p, "version")), s(p, "state"))
}

/// `wisp plugin [ls] | enable <id> | disable <id>`.
pub async fn run(c: &Client, p: &Parsed, args: &[String]) -> Result<()> {
    let f = &p.flags;
    match args.first().map_or("ls", String::as_str) {
        "ls" | "list" => {
            let list = c.cmd("plugins.list", json!({})).await?;
            let rows: Vec<String> = list.get("plugins").or(Some(&list)).and_then(Value::as_array).into_iter().flatten().map(line).collect();
            out(f, &list, &if rows.is_empty() { "No plugins.".to_owned() } else { rows.join("\n") });
            Ok(())
        }
        sub @ ("enable" | "disable" | "on" | "off") => {
            let id = need(args.get(1), "plugin id")?;
            let on = matches!(sub, "enable" | "on");
            let r = c.cmd("plugins.setEnabled", json!({ "id": id, "enabled": on })).await?;
            out(f, &r, &format!("  ✓ {id} {}", if on { "on" } else { "off" }));
            Ok(())
        }
        // ADR-0046: from a folder or a git URL, off; it says what it asks for, and `enable` is the consent
        "install" | "add" => {
            let source = need(args.get(1), "a folder or a git URL")?;
            let source = if source.contains("://") || source.starts_with("git@") {
                source.to_owned()
            } else {
                std::path::absolute(source).map_or_else(|_| source.to_owned(), |p| p.display().to_string())
            };
            let r = c.cmd("plugins.install", json!({ "source": source })).await?;
            let asks: Vec<String> = r
                .get("permissions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|x| format!("    {x}"))
                .collect();
            let id = s(&r, "id");
            let what =
                if asks.is_empty() { "It asks for nothing.".to_owned() } else { format!("Switching it on lets it:\n{}", asks.join("\n")) };
            out(
                f,
                &r,
                &format!(
                    "  ✓ {} {} is installed, off.\n  {what}\n  Switch it on with: wisp plugin enable {id}",
                    s(&r, "name"),
                    s(&r, "version")
                ),
            );
            Ok(())
        }
        "remove" | "uninstall" | "rm" => {
            let id = need(args.get(1), "plugin id")?;
            let r = c.cmd("plugins.uninstall", json!({ "id": id })).await?;
            out(f, &r, &format!("  ✓ {id} removed"));
            Ok(())
        }
        other => Err(CliError::said(format!(
            "wisp plugin {other}: ls, install <folder or git URL>, enable <id>, disable <id>, remove <id> or new <name>"
        ))),
    }
}

/// `wisp crew`: your crew members.
pub async fn crew(c: &Client, p: &Parsed, args: &[String]) -> Result<()> {
    if let Some(sub) = args.first().filter(|s| *s != "ls") {
        return Err(CliError::said(format!(
            "wisp crew {sub}: a crew is shared as a formula now: wisp export crew > team.yml, then wisp apply -f team.yml"
        )));
    }
    let list = c.cmd("crew.list", json!({})).await?;
    let rows: Vec<String> =
        list.as_array().into_iter().flatten().map(|m| format!("{:<16} {:<20} {}", s(m, "name"), s(m, "role"), s(m, "agent"))).collect();
    out(&p.flags, &list, &if rows.is_empty() { "No crew yet.".to_owned() } else { rows.join("\n") });
    Ok(())
}

/// `wisp plugin new <name>`: a declarative plugin of your own, off until you switch it on.
pub fn new_plugin(home: &Path, name: &str) -> Result<std::path::PathBuf> {
    let slug: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
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
    std::fs::write(
        dir.join("README.md"),
        format!(
            "# {name}\n\nA wisp plugin. Its whole static truth is `wisp-plugin.json`: what it adds (`contributes`) and what it may do (`permissions`).\nSwitch it on with `wisp plugin enable user.{slug}`.\n"
        ),
    )?;
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
}
