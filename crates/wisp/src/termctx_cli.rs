//! Terminal context from the CLI (ADR-0023): `wisp "check the error above"` attaches what just happened in this
//! terminal, gathered here, where the terminal is.
//!
//! - **When:** the prompt asks about what's above (`wisp_termctx_core::wants_context`), or `--context`;
//!   `--no-context` and the `termctx.enabled` setting (off) win. `--show-context` prints the block; `--lines N`.
//! - **What:** the terminal's own read command (`termctx.sources`, the first that answers; never the user's
//!   command), the opt-in shell hook's log (`wisp shell-init zsh|bash|fish`) or else the shell's history file, the
//!   folder, the shell, the git branch and status.
//! - **Privacy:** everything goes through the share scrub (secret shapes, secret env values) before it leaves.
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use wisp_termctx_core::{self as core, Cmd, TermContext};

use crate::args::Parsed;
use crate::client::Client;

/// How many recent commands the context lists.
const COMMANDS: usize = 10;

/// `wisp shell-init zsh|bash|fish`: the hook to add to the shell's rc file.
pub fn shell_init(shell: &str) -> Result<String, String> {
    core::hook_script(shell).map(str::to_owned).ok_or_else(|| format!("wisp shell-init zsh, bash or fish (not {shell}). Add `eval \"$(wisp shell-init zsh)\"` to ~/.zshrc"))
}

/// Whether to gather: the flags first, then the prompt.
pub fn wanted(p: &Parsed, prompt: &str) -> bool {
    if std::env::var_os("WISP_NO_CONTEXT").is_some() {
        return false;
    }
    p.flags.context.unwrap_or_else(|| core::wants_context(prompt))
}

async fn run(argv: &[String], cwd: &str) -> Option<String> {
    let (prog, rest) = argv.split_first()?;
    let out = tokio::time::timeout(Duration::from_secs(3), tokio::process::Command::new(prog).args(rest).current_dir(cwd).stdin(std::process::Stdio::null()).kill_on_drop(true).output()).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned()).filter(|s| !s.trim().is_empty())
}

fn this_tty() -> Option<String> {
    std::env::var("TTY").ok().filter(|t| !t.is_empty()).or_else(|| std::process::Command::new("tty").stdin(std::process::Stdio::inherit()).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())).map(|t| t.rsplit('/').next().unwrap_or(&t).to_owned())
}

fn history_file(shell: &str, home: &Path) -> Option<std::path::PathBuf> {
    if let Some(h) = std::env::var_os("HISTFILE").filter(|h| !h.is_empty()) {
        return Some(h.into());
    }
    Some(match shell {
        "zsh" => home.join(".zsh_history"),
        "bash" => home.join(".bash_history"),
        "fish" => home.join(".local/share/fish/fish_history"),
        _ => return None,
    })
}

/// Everything there is to read here (unscrubbed).
pub async fn gather(c: Option<&Client>, cwd: &str, lines: usize, wisp_home: &Path) -> TermContext {
    let env: BTreeMap<String, String> = wisp_termctx_api::ENV_KEYS.iter().filter_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()).map(|v| ((*k).to_owned(), v))).collect();
    let readers: Vec<(String, Vec<String>)> = match c {
        Some(c) => c.cmd("termctx.sources", json!({ "env": env, "lines": lines })).await.ok().and_then(|v| v.as_array().cloned()).map(|a| a.iter().filter_map(|r| Some((r.get("id")?.as_str()?.to_owned(), serde_json::from_value(r.get("argv")?.clone()).ok()?))).collect()),
        None => None,
    }
    .unwrap_or_else(|| {
        let m: std::collections::HashMap<String, String> = env.clone().into_iter().collect();
        core::SOURCES.iter().filter_map(|s| core::read_argv(s.id, &m, lines).map(|a| (s.id.to_owned(), a))).collect()
    });
    let mut ctx = TermContext { cwd: cwd.to_owned(), ..TermContext::default() };
    for (id, argv) in readers {
        if let Some(out) = run(&argv, cwd).await {
            ctx.output = core::tail(&out, lines);
            ctx.source = id;
            break;
        }
    }
    let shell = std::env::var("SHELL").ok().and_then(|s| s.rsplit('/').next().map(str::to_owned)).unwrap_or_default();
    ctx.shell.clone_from(&shell);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
    let log = this_tty().map(|t| wisp_home.join("term").join(format!("{t}.jsonl")));
    let from_hook = match log {
        Some(f) => tokio::fs::read_to_string(&f).await.ok().map(|t| core::parse_log(&t, now)).filter(|v| !v.is_empty()),
        None => None,
    };
    let user_home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default();
    let (cmds, from): (Vec<Cmd>, &str) = match from_hook {
        Some(v) => (v, "hook"),
        None => match history_file(&shell, &user_home) {
            Some(f) => (tokio::fs::read(&f).await.map(|b| core::history_tail(&shell, &String::from_utf8_lossy(&b), COMMANDS)).unwrap_or_default(), "history"),
            None => (Vec::new(), ""),
        },
    };
    let skip = cmds.len().saturating_sub(COMMANDS);
    ctx.commands = cmds.into_iter().skip(skip).collect();
    if !ctx.commands.is_empty() {
        ctx.commands_from = from.into();
    }
    ctx.branch = run(&["git".into(), "rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()], cwd).await.map(|s| s.trim().to_owned()).unwrap_or_default();
    ctx.git_status = run(&["git".into(), "status".into(), "--short".into()], cwd).await.map(|s| s.lines().take(50).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    ctx
}

/// The context with secrets taken out: secret shapes, and the values of secret-looking env vars.
pub fn scrub(mut ctx: TermContext, env: Vec<(String, String)>) -> (TermContext, usize) {
    let s = wisp_share_core::Scrub { env: wisp_share_core::secret_env(env), ..wisp_share_core::Scrub::default() };
    let mut found = Vec::new();
    ctx.output = wisp_share_core::scrub_text(&ctx.output, &s, "output", &mut found);
    ctx.git_status = wisp_share_core::scrub_text(&ctx.git_status, &s, "git", &mut found);
    for c in &mut ctx.commands {
        c.cmd = wisp_share_core::scrub_text(&c.cmd, &s, "command", &mut found);
    }
    (ctx, found.len())
}

/// Adds the context to a task's `runtime.create` args, when it's wanted; says what it attached.
pub async fn attach(c: &Client, p: &Parsed, args: &mut Value, prompt: &str, cwd: &str, wisp_home: &Path) {
    if !wanted(p, prompt) {
        return;
    }
    if c.cmd("settings.get", json!({ "key": wisp_termctx_api::ENABLED })).await.is_ok_and(|v| v == json!(false) || v.get("value") == Some(&json!(false))) {
        return;
    }
    let lines = p.flags.lines.unwrap_or(core::LINES).clamp(1, 5_000);
    let raw = gather(Some(c), cwd, lines, wisp_home).await;
    let (ctx, hidden) = scrub(raw, std::env::vars().collect());
    let block = ctx.block();
    args["prompt"] = json!(format!("{prompt}\n\n{block}"));
    args["ext"]["wisp.termctx"] = json!({ "source": ctx.source, "commands": ctx.commands.len(), "lines": ctx.output.lines().count(), "from": ctx.commands_from });
    let masked = if hidden > 0 { format!(", {hidden} secret{} masked", if hidden == 1 { "" } else { "s" }) } else { String::new() };
    eprintln!("  ◌ with terminal context: {}{masked}  (--show-context to see it, --no-context to leave it out)", ctx.summary());
    if p.flags.show_context {
        eprintln!("{block}");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn secrets_in_scrollback_are_masked_before_they_leave() {
        let ctx = TermContext {
            cwd: "/w".into(),
            output: "$ deploy\nusing key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\nDB=postgres://u:hunter2hunter2@db/x\nerror: boom".into(),
            commands: vec![Cmd { cmd: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789".into(), exit: Some(0), ..Cmd::default() }],
            source: "tmux".into(),
            ..TermContext::default()
        };
        let (out, n) = scrub(ctx, vec![("DB_PASSWORD".into(), "hunter2hunter2".into()), ("EDITOR".into(), "vim-is-not-a-secret".into())]);
        assert!(!out.output.contains("sk-ant-api03") && !out.output.contains("hunter2hunter2"), "{}", out.output);
        assert!(out.output.contains("error: boom"), "the rest stays");
        assert!(!out.commands[0].cmd.contains("ghp_"), "{}", out.commands[0].cmd);
        assert!(n >= 3, "{n}");
        assert!(out.block().contains("<secret>") || out.block().contains("<env:DB_PASSWORD>"));
    }

    #[test]
    fn shell_init_knows_three_shells() {
        assert!(shell_init("zsh").unwrap().contains("add-zsh-hook"));
        assert!(shell_init("fish").unwrap().contains("fish_postexec"));
        assert!(shell_init("tcsh").unwrap_err().contains("zsh, bash or fish"));
    }
}
