//! The commands that belong to other parts of wisp, each loaded only when asked:
//! - `wisp skill [install]`: the agent skill (skills/wisp/SKILL.md, compiled in);
//! - `wisp grid …`: wisp Grid's own binary (apps/grid, `wisp-grid`), beside this one or on PATH;
//! - `wisp mcp`: the MCP server on stdio, from the mcp plugin;
//! - `wisp import`: a v1 home into this wisp, through the import command the store's importers serve;
//! - `wisp desktop`: the desktop window (desktop.rs).
use std::path::{Path, PathBuf};


use crate::args::Flags;
use crate::client::{CliError, Result};
use crate::scripted::say;

pub const SKILL: &str = include_str!("../../../skills/wisp/SKILL.md");
pub const GRID_MISSING: &str = "wisp grid is not in this build: it comes with wisp Grid (the wisp-grid binary, apps/grid)";

/// Where each harness looks for skills.
pub fn skill_targets(home: &Path, base: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, PathBuf)> {
    match base {
        Some(b) => vec![("claude", b.join(".claude/skills")), ("codex", b.join(".codex/skills")), ("opencode", b.join(".opencode/skill"))],
        None => vec![
            ("claude", home.join(".claude/skills")),
            ("codex", env("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from).join("skills")),
            ("opencode", env("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from).join("opencode/skill")),
        ],
    }
}

pub fn skill(sub: Option<&str>, f: &Flags, user_home: &Path, cwd: &Path) -> Result<()> {
    if sub != Some("install") {
        say(SKILL.trim_end());
        return Ok(());
    }
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let targets = skill_targets(user_home, f.project.then_some(cwd), &env);
    let which: Vec<&str> = match f.agent.as_deref() {
        None => vec!["claude"],
        Some("all") => targets.iter().map(|(a, _)| *a).collect(),
        Some(a) => vec![a],
    };
    for a in which {
        let Some((_, dir)) = targets.iter().find(|(n, _)| *n == a) else {
            return Err(CliError::said(format!("no skill location for {a} (try claude, codex, opencode or all)")));
        };
        let dir = dir.join("wisp");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), SKILL)?;
        say(&format!("  ✓ {a}: {}", dir.join("SKILL.md").display()));
    }
    Ok(())
}

/// The wisp-grid binary: beside this one, else on PATH.
fn grid_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "wisp-grid.exe" } else { "wisp-grid" };
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name))).filter(|p| p.is_file());
    beside.or_else(|| std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|p| p.is_file())))
}

/// The grid parses its own flags from the raw arguments after `grid`; its exit code is ours.
pub fn grid(argv: &[String]) -> Result<i32> {
    let Some(bin) = grid_binary() else { return Err(CliError::said(GRID_MISSING)) };
    let at = argv.iter().position(|a| a == "grid").map_or(argv.len(), |i| i + 1);
    let status = std::process::Command::new(bin).args(&argv[at..]).status()?;
    Ok(status.code().unwrap_or(1))
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_is_compiled_in_and_targets_follow_env() {
        assert!(SKILL.contains("wisp"));
        let none = |_: &str| None;
        let t = skill_targets(Path::new("/u"), None, &none);
        assert_eq!(t[1].1, PathBuf::from("/u/.codex/skills"));
        let codex = |k: &str| (k == "CODEX_HOME").then(|| "/c".to_owned());
        assert_eq!(skill_targets(Path::new("/u"), None, &codex)[1].1, PathBuf::from("/c/skills"));
        assert_eq!(skill_targets(Path::new("/u"), Some(Path::new("/p")), &none)[2].1, PathBuf::from("/p/.opencode/skill"));
    }
}
