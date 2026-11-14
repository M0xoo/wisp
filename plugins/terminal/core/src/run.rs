//! The side panel's Preview (v1 server/runs.js): the port a task's app gets (stable per task, so a reload finds it),
//! the command to start from (`.wisp/worktree.json`'s `run`, else package.json's `dev` or `start` script, as v1
//! guessed), and the script the PTY runs: `PORT` set, then the command as typed. Pure: the host reads the files.

/// v1 `APP_BASE`, `SPAN`: a task's app port is `41000 + hash(id) % 900`.
const APP_BASE: u16 = 41_000;
const SPAN: u32 = 900;

/// The port task `id`'s app gets (`PORT`).
#[must_use]
pub fn port_for(id: &str) -> u16 {
    let h = id.chars().fold(7_u32, |h, c| h.wrapping_mul(31).wrapping_add(u32::from(c)));
    APP_BASE + u16::try_from(h % SPAN).unwrap_or(0)
}

/// The command to offer: `.wisp/worktree.json`'s `run`, else the package manager's `dev` (or `start`) script.
#[must_use]
pub fn guess(worktree_json: Option<&str>, package_json: Option<&str>, lock: &dyn Fn(&str) -> bool) -> Option<String> {
    if let Some(run) = worktree_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v["run"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
    {
        return Some(run);
    }
    let pkg: serde_json::Value = serde_json::from_str(package_json?).ok()?;
    let script = ["dev", "start"].into_iter().find(|k| pkg["scripts"][k].as_str().is_some_and(|s| !s.trim().is_empty()))?;
    let pm = if lock("pnpm-lock.yaml") {
        "pnpm"
    } else if lock("yarn.lock") {
        "yarn"
    } else if lock("bun.lockb") || lock("bun.lock") {
        "bun"
    } else {
        "npm"
    };
    Some(if pm == "npm" { format!("npm run {script}") } else { format!("{pm} {script}") })
}

/// What the shell runs: `PORT` for the app, then the command (several lines stay several lines).
#[must_use]
pub fn script(command: &str, port: u16) -> String {
    format!("export PORT={port}\n{}", command.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_runs_the_worktree_run_else_the_dev_script_with_a_stable_port() {
        let none = |_: &str| false;
        assert_eq!(guess(Some(r#"{"run":"make serve"}"#), Some(r#"{"scripts":{"dev":"vite"}}"#), &none).as_deref(), Some("make serve"));
        assert_eq!(guess(None, Some(r#"{"scripts":{"dev":"vite","start":"node ."}}"#), &none).as_deref(), Some("npm run dev"));
        assert_eq!(guess(None, Some(r#"{"scripts":{"start":"node ."}}"#), &|f| f == "pnpm-lock.yaml").as_deref(), Some("pnpm start"));
        assert_eq!(guess(None, Some(r#"{"scripts":{"test":"vitest"}}"#), &none), None, "no dev or start: nothing to guess");
        assert_eq!(guess(Some("not json"), None, &none), None);
        let p = port_for("s1");
        assert!((41_000..41_900).contains(&p));
        assert_eq!(port_for("s1"), p, "the same task, the same port");
        assert_eq!(script("  npm run dev \n", 41_234), "export PORT=41234\nnpm run dev");
    }
}
