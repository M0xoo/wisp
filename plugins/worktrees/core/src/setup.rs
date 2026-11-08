//! A repo's setup for a new worktree, and the one place that decides it (the trust card lists the same):
//! `.wisp/worktree.json` `{ "setup": "npm ci" | [...] }`, else Cursor's `.cursor/worktrees.json`
//! `{ "setup-worktree": [...] }`, else the first contributed source (Conductor's, from the plugin that
//! reads it). A repo that works keeps what it runs and isn't asked again. Also the app's run command for
//! the panel's Preview. Inputs are file contents the host read; nothing here touches the disk.

use serde_json::Value;
use wisp_worktrees_api::SourceScripts;

pub const OWN_FILE: &str = ".wisp/worktree.json";
pub const CURSOR_FILE: &str = ".cursor/worktrees.json";
/// a setup step is killed after this long
pub const SETUP_TIMEOUT_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoSetup {
    pub file: Option<String>,
    pub commands: Vec<String>,
    pub problem: Option<String>,
}

fn json(text: Option<&str>) -> Option<Value> {
    serde_json::from_str(text?.trim_start_matches('\u{feff}')).ok()
}

/// A string or a list of strings; blanks and non-strings dropped.
fn steps(v: &Value) -> Vec<String> {
    let list = match v {
        Value::Array(a) => a.iter().collect::<Vec<_>>(),
        other => vec![other],
    };
    list.into_iter()
        .filter_map(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// `own`, `cursor`: the files' text when there. `other`: the first contributed source that had one.
pub fn repo_setup(
    own: Option<&str>,
    cursor: Option<&str>,
    other: Option<&SourceScripts>,
) -> RepoSetup {
    if let Some(v) = json(own)
        .as_ref()
        .and_then(|j| j.get("setup"))
        .filter(|v| !v.is_null())
    {
        return RepoSetup {
            file: Some(OWN_FILE.into()),
            commands: steps(v),
            problem: None,
        };
    }
    if let Some(v) = json(cursor)
        .as_ref()
        .and_then(|j| j.get("setup-worktree"))
        .filter(|v| !v.is_null())
    {
        return RepoSetup {
            file: Some(CURSOR_FILE.into()),
            commands: steps(v),
            problem: None,
        };
    }
    match other {
        Some(s) => RepoSetup {
            file: Some(s.file.clone()),
            commands: s
                .setup
                .iter()
                .filter(|c| !c.trim().is_empty())
                .cloned()
                .collect(),
            problem: s.problem.clone(),
        },
        None => RepoSetup::default(),
    }
}

/// A step can be a whole script: a problem names its first line.
pub fn first_line(cmd: &str) -> String {
    let t = cmd.trim();
    let mut lines = t.lines();
    let first = lines.next().unwrap_or("");
    if lines.next().is_some() {
        format!("{first}…")
    } else {
        first.to_owned()
    }
}

/// What the task says about a failed step: its first line and the last three lines of what it said.
pub fn step_failed(cmd: &str, stderr: &str, fallback: &str) -> String {
    let said = if stderr.trim().is_empty() {
        fallback
    } else {
        stderr
    };
    let lines: Vec<&str> = said.trim().lines().collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    format!("setup `{}` failed: {tail}", first_line(cmd))
}

/// The shell a step runs in: `$SHELL -c`, `cmd.exe /d /s /c` on Windows.
pub fn shell_argv(
    windows: bool,
    shell: Option<&str>,
    comspec: Option<&str>,
    cmd: &str,
) -> (String, Vec<String>) {
    if windows {
        let bin = comspec.filter(|s| !s.is_empty()).unwrap_or("cmd.exe");
        (
            bin.to_owned(),
            vec!["/d".into(), "/s".into(), "/c".into(), cmd.to_owned()],
        )
    } else {
        let bin = shell.filter(|s| !s.is_empty()).unwrap_or("/bin/sh");
        (bin.to_owned(), vec!["-c".into(), cmd.to_owned()])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunCommand {
    pub command: Option<String>,
    pub port: Option<u16>,
    /// config | conductor | package.json
    pub source: &'static str,
    pub file: Option<String>,
    pub cwd: Option<String>,
    pub problem: Option<String>,
}

/// How to run the app from a folder: own `run` (and `port`), else the contributed source's run script
/// (its problem refuses it: a guess wouldn't be what the repo asked for), else package.json's dev, then
/// start, marked as a guess. None: nothing to go on.
pub fn run_command(
    own: Option<&str>,
    other: Option<&SourceScripts>,
    package_json: Option<&str>,
) -> Option<RunCommand> {
    let own = json(own);
    let port = own
        .as_ref()
        .and_then(|j| j.get("port"))
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p > 0);
    let base = |source, command: Option<String>| RunCommand {
        command,
        port,
        source,
        file: None,
        cwd: None,
        problem: None,
    };
    if let Some(cmd) = own
        .as_ref()
        .and_then(|j| j.get("run"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        return Some(base("config", Some(cmd.to_owned())));
    }
    if let Some(s) = other {
        if s.problem.is_some() {
            return Some(RunCommand {
                file: Some(s.file.clone()),
                problem: s.problem.clone(),
                ..base("conductor", None)
            });
        }
        if let Some(r) = &s.run {
            return Some(RunCommand {
                file: Some(s.file.clone()),
                cwd: r.cwd.clone(),
                ..base("conductor", Some(r.command.clone()))
            });
        }
    }
    let scripts = json(package_json).and_then(|p| p.get("scripts").cloned())?;
    if scripts.get("dev").is_some_and(Value::is_string) {
        return Some(base("package.json", Some("npm run dev".into())));
    }
    scripts
        .get("start")
        .is_some_and(Value::is_string)
        .then(|| base("package.json", Some("npm start".into())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wisp_worktrees_api::RunScript;

    fn conductor(setup: Option<&str>, problem: Option<&str>) -> SourceScripts {
        SourceScripts {
            file: ".conductor/settings.toml".into(),
            setup: setup.map(str::to_owned),
            run: Some(RunScript {
                command: "bin/dev".into(),
                cwd: Some("web".into()),
            }),
            problem: problem.map(str::to_owned),
        }
    }

    #[test]
    fn own_file_then_cursor_then_a_contributed_source() {
        let cursor = r#"{"setup-worktree":["npm ci"]}"#;
        assert_eq!(repo_setup(None, Some(cursor), None).commands, ["npm ci"]);
        let own = r#"{"setup":"pnpm i"}"#;
        let s = repo_setup(Some(own), Some(cursor), None);
        assert_eq!(
            (s.file.as_deref(), s.commands),
            (Some(OWN_FILE), vec!["pnpm i".to_owned()])
        );
        let c = conductor(Some("make"), None);
        assert_eq!(
            repo_setup(None, Some(cursor), Some(&c)).file.as_deref(),
            Some(CURSOR_FILE),
            "Cursor stays ahead of Conductor"
        );
        assert_eq!(repo_setup(None, None, Some(&c)).commands, ["make"]);
        assert_eq!(
            repo_setup(Some("{not json"), None, None),
            RepoSetup::default()
        );
        assert_eq!(
            repo_setup(Some(r#"{"setup":["a", 3, "  ", "b"]}"#), None, None).commands,
            ["a", "b"]
        );
    }

    #[test]
    fn an_unreadable_source_is_said_and_runs_nothing() {
        let c = conductor(None, Some("couldn't read .conductor/settings.toml: bad"));
        let s = repo_setup(None, None, Some(&c));
        assert!(s.commands.is_empty());
        assert!(s.problem.is_some());
        let r = run_command(None, Some(&c), Some(r#"{"scripts":{"dev":"vite"}}"#)).unwrap();
        assert_eq!((r.command, r.source), (None, "conductor"));
    }

    #[test]
    fn failures_name_the_first_line_and_the_tail() {
        assert_eq!(first_line("echo a\necho b"), "echo a…");
        assert_eq!(
            step_failed("false", "", "exit 1"),
            "setup `false` failed: exit 1"
        );
        assert_eq!(
            step_failed("x", "1\n2\n3\n4\n", ""),
            "setup `x` failed: 2 3 4"
        );
        assert_eq!(shell_argv(false, None, None, "ls").0, "/bin/sh");
        assert_eq!(
            shell_argv(true, None, None, "dir").1,
            ["/d", "/s", "/c", "dir"]
        );
    }

    #[test]
    fn run_command_own_then_source_then_a_package_json_guess() {
        let own = r#"{"run":" npm run dev ","port":5173}"#;
        let r = run_command(Some(own), None, None).unwrap();
        assert_eq!(
            (r.command.as_deref(), r.port, r.source),
            (Some("npm run dev"), Some(5173), "config")
        );
        let c = conductor(None, None);
        let r = run_command(Some(r#"{"port":70000}"#), Some(&c), None).unwrap();
        assert_eq!(
            (r.command.as_deref(), r.cwd.as_deref(), r.port),
            (Some("bin/dev"), Some("web"), None)
        );
        assert_eq!(
            run_command(None, None, Some(r#"{"scripts":{"start":"node ."}}"#))
                .unwrap()
                .command
                .as_deref(),
            Some("npm start")
        );
        assert_eq!(
            run_command(
                None,
                None,
                Some(r#"{"scripts":{"dev":"vite","start":"x"}}"#)
            )
            .unwrap()
            .command
            .as_deref(),
            Some("npm run dev")
        );
        assert_eq!(run_command(None, None, Some("{}")), None);
    }
}
