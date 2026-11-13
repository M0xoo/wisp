//! What to spawn for a Claude Code run (v1 adapters/claude.js `run()`): `claude -p --output-format
//! stream-json …`, the prompt on stdin. Plain data from a [`HarnessRun`]; no I/O.

use std::collections::BTreeSet;

use wisp_runtime_api::harness::{HarnessRun, Launch, Stdin};
use wisp_runtime_api::model::{Attachment, Mode};

/// The program when detect found none and `WISP_CLAUDE_BIN` isn't set.
pub const DEFAULT_BIN: &str = "claude";

/// Its own tools wisp's gate always asks about (v1 claude.js:26).
const GATED: [&str; 5] = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
/// A side run that only answers (v1 claude.js:21).
const LEAN: [&str; 7] =
    ["--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--disable-slash-commands", "--no-session-persistence"];
/// A repo the user hasn't trusted: none of its hooks or MCP servers (v1 claude.js:25).
const UNTRUSTED: [&str; 3] = ["--setting-sources", "user", "--strict-mcp-config"];
/// A parent Claude Code session must not leak into the child (v1 pty.js:131), nor costly extras (:135).
pub const ENV_REMOVE: [&str; 10] = [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES",
];
const SUBAGENT_MODELS: [&str; 2] = ["haiku", "sonnet"];
pub const APPROVE_TOOL: &str = "mcp__wisp__approve";

pub(crate) fn permission_mode(mode: Mode) -> &'static str {
    match mode {
        Mode::Plan => "plan",
        Mode::Edits => "acceptEdits",
        Mode::Auto => "bypassPermissions",
    }
}

/// v1 common.js `attachmentNote`, with Claude Code's own words for how to read them.
fn attachment_note(files: &[Attachment]) -> String {
    let with_path: Vec<&Attachment> = files.iter().filter(|f| f.path.is_some()).collect();
    if with_path.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = with_path
        .iter()
        .map(|f| {
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation, clippy::cast_sign_loss)] // sizes in KB, rounded
            let kb = ((f.size as f64 / 1024.0).round() as u64).max(1);
            format!("- {}  ({}, {kb} KB)", f.path.as_deref().unwrap_or_default(), f.mime)
        })
        .collect();
    format!(
        "\n\n<attachments>\nThe user attached these files. Read images and PDFs with the Read tool; for video/audio/other formats use the shell (e.g. ffmpeg, ffprobe) if needed.\n{}\n</attachments>",
        lines.join("\n")
    )
}

fn dir_of(p: &str) -> String {
    match p.rfind(['/', '\\']) {
        Some(0) => "/".to_owned(),
        Some(i) => p[..i].to_owned(),
        None => ".".to_owned(),
    }
}

/// The launch for `run`, with `bin` the program to start.
pub fn launch(run: &HarnessRun, bin: &str) -> Launch {
    let mut args: Vec<String> = vec!["-p".into(), "--output-format".into(), "stream-json".into()];
    args.push(if run.lean { "--system-prompt" } else { "--append-system-prompt" }.into());
    args.push(run.system_prompt.clone());
    args.push("--permission-mode".into());
    args.push(if run.gate { "default" } else { permission_mode(run.mode) }.into());
    if run.gate {
        args.push("--settings".into());
        args.push(serde_json::json!({ "permissions": { "ask": GATED } }).to_string());
    }
    if run.lean {
        args.extend(LEAN.iter().map(|s| (*s).to_owned()));
    } else if run.untrusted {
        args.extend(UNTRUSTED.iter().map(|s| (*s).to_owned()));
    }
    let compact = run.prompt.trim().strip_prefix("/compact").is_some_and(|r| r.is_empty() || r.starts_with(char::is_whitespace));
    if run.skills == "off" && !run.lean && !compact {
        args.push("--disable-slash-commands".into());
    }
    for (flag, v) in [("--model", &run.model), ("--effort", &run.effort)] {
        if !v.is_empty() {
            args.push(flag.into());
            args.push(v.clone());
        }
    }
    if let Some(r) = run.resume_id.as_ref().filter(|r| !r.is_empty()) {
        args.push("--resume".into());
        args.push(r.clone());
        if run.fork {
            args.push("--fork-session".into());
            args.push("--no-session-persistence".into());
        }
    }
    if !run.mcp_servers.is_empty() {
        args.push("--mcp-config".into());
        args.push(serde_json::json!({ "mcpServers": run.mcp_servers }).to_string());
    }
    if run.mcp_servers.contains_key("wisp") && run.mode == Mode::Edits {
        args.push("--permission-prompt-tool".into());
        args.push(APPROVE_TOOL.into());
    }
    let allowed: Vec<String> = run.mcp_servers.keys().map(|n| format!("mcp__{n}")).chain(run.grants.iter().cloned()).collect();
    if !allowed.is_empty() {
        args.push("--allowedTools".into());
        args.extend(allowed);
    }
    if run.delegating {
        args.extend(["--disallowedTools", "Task", "Agent", "Workflow"].map(str::to_owned));
    }
    let mut seen = BTreeSet::new();
    let dirs: Vec<String> = run
        .dirs
        .iter()
        .cloned()
        .chain(run.attachments.iter().filter_map(|a| a.path.as_deref().map(dir_of)))
        .filter(|d| seen.insert(d.clone()))
        .collect();
    if !dirs.is_empty() {
        args.push("--add-dir".into());
        args.extend(dirs);
    }
    args.push("--verbose".into()); // ends the variadic flags above
    let mut env = std::collections::BTreeMap::new();
    if SUBAGENT_MODELS.contains(&run.subagent_model.as_str()) {
        env.insert("CLAUDE_CODE_SUBAGENT_MODEL".to_owned(), run.subagent_model.clone());
        env.insert("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL".to_owned(), run.subagent_model.clone());
    }
    // without the CLI's nonessential traffic (v1 lean.js: a lean side run, or a task Settings or the task made lean)
    if run.quiet {
        env.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_owned(), "1".to_owned());
    }
    let prompt = format!("{}{}", run.prompt, attachment_note(&run.attachments));
    Launch {
        program: bin.to_owned(),
        args,
        env,
        env_remove: ENV_REMOVE.iter().map(|s| (*s).to_owned()).collect(),
        cwd: run.cwd.clone(),
        stdin: Stdin::Bytes(prompt.into_bytes()),
        ..Launch::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> HarnessRun {
        HarnessRun { prompt: "fix the login".into(), cwd: "/w".into(), system_prompt: "SYS".into(), ..HarnessRun::default() }
    }

    #[test]
    fn a_plain_run_is_v1s_argv_with_the_prompt_on_stdin() {
        let l = launch(&run(), "claude");
        assert_eq!(l.program, "claude");
        assert_eq!(
            l.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--append-system-prompt",
                "SYS",
                "--permission-mode",
                "bypassPermissions",
                "--verbose"
            ]
        );
        assert_eq!(l.stdin, Stdin::Bytes(b"fix the login".to_vec()));
        assert_eq!(l.cwd, "/w");
        assert!(l.env_remove.iter().any(|k| k == "CLAUDECODE"));
    }

    #[test]
    fn flags_follow_the_run() {
        let mut r = run();
        r.mode = Mode::Edits;
        r.model = "opus".into();
        r.effort = "high".into();
        r.resume_id = Some("c1".into());
        r.fork = true;
        r.mcp_servers.insert("wisp".into(), serde_json::json!({"command": "x"}));
        r.delegating = true;
        r.dirs = vec!["/a".into()];
        r.attachments =
            vec![Attachment { path: Some("/up/pic.png".into()), mime: "image/png".into(), size: 3000, ..Attachment::default() }];
        let a = launch(&r, "/bin/claude").args.join(" ");
        assert!(a.contains(
            "--permission-mode acceptEdits --model opus --effort high --resume c1 --fork-session --no-session-persistence --mcp-config"
        ));
        assert!(a.contains("--permission-prompt-tool mcp__wisp__approve --allowedTools mcp__wisp --disallowedTools Task Agent Workflow --add-dir /a /up --verbose"));
        let Stdin::Bytes(b) = launch(&r, "claude").stdin else { panic!("stdin") };
        assert!(String::from_utf8_lossy(&b).contains("- /up/pic.png  (image/png, 3 KB)"));
    }

    #[test]
    fn gate_lean_and_skills() {
        let mut r = run();
        r.gate = true;
        r.skills = "off".into();
        let a = launch(&r, "claude").args;
        assert!(a.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert!(a.iter().any(|x| x == "--disable-slash-commands"));
        r.prompt = "/compact".into();
        assert!(!launch(&r, "claude").args.iter().any(|x| x == "--disable-slash-commands"));
        let mut l = run();
        l.lean = true;
        let a = launch(&l, "claude").args;
        assert_eq!(a[3], "--system-prompt");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"));
    }

    /// v1 lean.js `LEAN_ENV`: a quiet run goes without Claude Code's nonessential traffic.
    #[test]
    fn a_quiet_run_turns_the_nonessential_traffic_off() {
        assert!(!launch(&run(), "claude").env.contains_key("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"));
        let q = HarnessRun { quiet: true, ..run() };
        assert_eq!(launch(&q, "claude").env.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").map(String::as_str), Some("1"));
    }
}
