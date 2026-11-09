//! wisp.termctx's pure logic (ADR-0023), sans-IO: which terminal this is and how to read its recent output (each
//! source is the argv of the terminal's own read command, never the user's), the shell hook's scripts and log,
//! the shells' history files, whether a prompt asks about what's above, and the context block and its one-line
//! summary. The CLI runs what's decided here, where the terminal is; the host reads the hook's log for the
//! `terminal.failed` trigger source.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// How many lines of output a context takes by default.
pub const LINES: usize = 200;
/// How long the hook's log keeps a command.
pub const KEEP_MS: i64 = 7 * 86_400_000;
const MAX_CMD: usize = 2000;

/// The environment a source detects its terminal from.
pub trait Env {
    fn var(&self, k: &str) -> Option<String>;
}

impl<S: std::hash::BuildHasher> Env for std::collections::HashMap<String, String, S> {
    fn var(&self, k: &str) -> Option<String> {
        self.get(k).filter(|v| !v.is_empty()).cloned()
    }
}

/// A way to read the terminal's recent output: its own read command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Source {
    pub id: &'static str,
    pub label: &'static str,
}

pub const SOURCES: [Source; 5] = [
    Source { id: "tmux", label: "tmux" },
    Source { id: "wezterm", label: "WezTerm" },
    Source { id: "kitty", label: "kitty" },
    Source { id: "iterm2", label: "iTerm2" },
    Source { id: "apple-terminal", label: "Terminal" },
];

/// The read command for `src` in this terminal, if it is one (`None`: not this terminal). Reading only: none of
/// these runs anything the user typed.
pub fn read_argv(src: &str, env: &dyn Env, lines: usize) -> Option<Vec<String>> {
    let v = |s: &str| s.to_owned();
    let n = lines.max(1);
    match src {
        "tmux" => {
            env.var("TMUX")?;
            let mut a = vec![v("tmux"), v("capture-pane"), v("-p"), v("-J"), v("-S"), format!("-{n}")];
            if let Some(p) = env.var("TMUX_PANE") {
                a.extend([v("-t"), p]);
            }
            Some(a)
        }
        "wezterm" => {
            let pane = env.var("WEZTERM_PANE")?;
            Some(vec![v("wezterm"), v("cli"), v("get-text"), v("--pane-id"), pane, v("--start-line"), format!("-{n}")])
        }
        "kitty" => {
            let win = env.var("KITTY_WINDOW_ID")?;
            env.var("KITTY_LISTEN_ON").or_else(|| env.var("KITTY_PID"))?;
            Some(vec![v("kitty"), v("@"), v("get-text"), v("--extent"), v("all"), v("--match"), format!("id:{win}")])
        }
        "iterm2" => {
            let sid = env.var("ITERM_SESSION_ID")?;
            let uuid = sid.split_once(':').map_or(sid.as_str(), |(_, u)| u).to_owned();
            let script = format!("tell application \"iTerm2\" to repeat with w in windows\n repeat with t in tabs of w\n repeat with s in sessions of t\n if unique id of s is \"{}\" then return contents of s\n end repeat\n end repeat\n end repeat", uuid.replace('"', ""));
            Some(vec![v("osascript"), v("-e"), script])
        }
        "apple-terminal" => {
            (env.var("TERM_PROGRAM")? == "Apple_Terminal").then_some(())?;
            Some(vec![v("osascript"), v("-e"), v("tell application \"Terminal\" to get history of selected tab of front window")])
        }
        _ => None,
    }
}

/// Strips ANSI escapes (CSI and OSC) and carriage-return overwrites.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                while let Some(&d) = it.peek() {
                    it.next();
                    if ('@'..='~').contains(&d) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                while let Some(d) = it.next() {
                    if d == '\u{7}' || (d == '\u{1b}' && it.peek() == Some(&'\\')) {
                        if d == '\u{1b}' {
                            it.next();
                        }
                        break;
                    }
                }
            }
            _ => {
                it.next();
            }
        }
    }
    out.lines().map(|l| l.rsplit('\r').next().unwrap_or(l)).collect::<Vec<_>>().join("\n")
}

/// The last `n` lines of a capture, without escapes or the blank lines at its end.
pub fn tail(text: &str, n: usize) -> String {
    let clean = strip_ansi(text);
    let lines: Vec<&str> = clean.lines().collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty()).map_or(0, |i| i + 1);
    lines[end.saturating_sub(n)..end].join("\n")
}

/// One command the shell ran.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cmd {
    pub cmd: String,
    #[serde(default)]
    pub cwd: String,
    /// None: unknown (from the history file)
    #[serde(default)]
    pub exit: Option<i32>,
    #[serde(default)]
    pub ms: Option<i64>,
    #[serde(default)]
    pub at: i64,
}

/// The hook's log (`~/.wisp/term/<tty>.jsonl`): its commands newer than 7 days, oldest first; a damaged line is
/// skipped.
pub fn parse_log(text: &str, now: i64) -> Vec<Cmd> {
    text.lines().filter_map(|l| serde_json::from_str::<Cmd>(l).ok()).filter(|c| !c.cmd.trim().is_empty() && now - c.at <= KEEP_MS).collect()
}

/// The last `n` commands of a shell's own history file.
pub fn history_tail(shell: &str, text: &str, n: usize) -> Vec<Cmd> {
    #[allow(clippy::match_like_matches_macro, clippy::single_match_else)]
    let cmds: Vec<Cmd> = match shell {
        // `- cmd: git push` / `  when: 1700000000`
        "fish" => {
            let mut out: Vec<Cmd> = Vec::new();
            for l in text.lines() {
                if let Some(c) = l.strip_prefix("- cmd: ") {
                    out.push(Cmd { cmd: c.replace("\\n", "\n").replace("\\\\", "\\"), ..Cmd::default() });
                } else if let (Some(t), Some(last)) = (l.trim().strip_prefix("when: "), out.last_mut()) {
                    last.at = t.parse::<i64>().unwrap_or(0) * 1000;
                }
            }
            out
        }
        // zsh: `: 1700000000:0;git push` (extended), or plain lines; a line ending in `\` goes on
        _ => {
            let mut out: Vec<Cmd> = Vec::new();
            let mut cont = false;
            for l in text.lines() {
                if cont {
                    if let Some(last) = out.last_mut() {
                        last.cmd.push('\n');
                        last.cmd.push_str(l.trim_end_matches('\\'));
                    }
                } else if let Some(rest) = l.strip_prefix(": ").and_then(|r| r.split_once(';')) {
                    let at = rest.0.split(':').next().and_then(|t| t.trim().parse::<i64>().ok()).unwrap_or(0) * 1000;
                    out.push(Cmd { cmd: rest.1.trim_end_matches('\\').to_owned(), at, ..Cmd::default() });
                } else if !l.starts_with('#') && !l.trim().is_empty() {
                    out.push(Cmd { cmd: l.trim_end_matches('\\').to_owned(), ..Cmd::default() });
                }
                cont = shell == "zsh" && l.ends_with('\\');
            }
            out
        }
    };
    let skip = cmds.len().saturating_sub(n);
    cmds.into_iter().skip(skip).collect()
}

/// Whether a prompt asks about what just happened in the terminal.
pub fn wants_context(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    ["above", "that error", "this error", "the error", "what i just ran", "what just happened", "last command", "the output", "just failed", "it failed", "failing command", "scrollback"].iter().any(|w| p.contains(w))
}

/// What the context holds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermContext {
    pub cwd: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub git_status: String,
    #[serde(default)]
    pub commands: Vec<Cmd>,
    /// the source the output came from (`tmux`), "" when none could be read
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub output: String,
    /// where the commands came from: `hook` or `history`
    #[serde(default)]
    pub commands_from: String,
}

impl TermContext {
    /// The failing command: the last one with a non-zero exit.
    pub fn failing(&self) -> Option<&Cmd> {
        self.commands.iter().rev().find(|c| c.exit.is_some_and(|e| e != 0))
    }

    /// "3 commands, 120 lines from tmux, git status"
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        if !self.commands.is_empty() {
            let n = self.commands.len();
            parts.push(format!("{n} command{}", if n == 1 { "" } else { "s" }));
        }
        if !self.output.is_empty() {
            let n = self.output.lines().count();
            let label = SOURCES.iter().find(|s| s.id == self.source).map_or(self.source.as_str(), |s| s.label);
            parts.push(format!("{n} line{} from {label}", if n == 1 { "" } else { "s" }));
        }
        if !self.branch.is_empty() || !self.git_status.is_empty() {
            parts.push("git status".into());
        }
        if parts.is_empty() { format!("the folder {}", self.cwd) } else { parts.join(", ") }
    }

    /// The block the task gets (Markdown), with what it couldn't read said out loud.
    pub fn block(&self) -> String {
        let mut out = format!("## Terminal context\n\nWhere: `{}`", self.cwd);
        if !self.shell.is_empty() {
            let _ = write!(out, " ({})", self.shell);
        }
        if !self.branch.is_empty() {
            let _ = write!(out, ", on branch `{}`", self.branch);
        }
        out.push('\n');
        if !self.git_status.trim().is_empty() {
            let _ = write!(out, "\ngit status:\n```\n{}\n```\n", self.git_status.trim_end());
        }
        if !self.commands.is_empty() {
            out.push_str("\nLast commands (oldest first):\n");
            for c in &self.commands {
                let ec = c.exit.map_or_else(String::new, |e| format!("  → exit {e}"));
                let cmd: String = c.cmd.chars().take(MAX_CMD).collect();
                let _ = writeln!(out, "- `{}`{ec}", cmd.replace('`', "'"));
            }
        }
        if self.output.is_empty() {
            out.push_str("\nThe terminal's output couldn't be read here, and wisp never runs a command again to see it: work from the commands, their exit codes and the folder.\n");
        } else {
            let label = SOURCES.iter().find(|s| s.id == self.source).map_or(self.source.as_str(), |s| s.label);
            let _ = write!(out, "\nThe terminal's last {} lines (from {label}):\n```\n{}\n```\n", self.output.lines().count(), self.output);
        }
        out
    }
}

/// The hook for a shell (`wisp shell-init zsh|bash|fish`): each command, its cwd, exit code, duration and time, one
/// JSON line in `${WISP_HOME:-~/.wisp}/term/<tty>.jsonl`, created private (umask 077). Nothing else is recorded.
pub fn hook_script(shell: &str) -> Option<&'static str> {
    Some(match shell {
        "zsh" => ZSH,
        "bash" => BASH,
        "fish" => FISH,
        _ => return None,
    })
}

const ZSH: &str = r#"# wisp shell-init zsh (ADR-0023): each command, its cwd, exit code, duration and time, kept 7 days in
# ${WISP_HOME:-$HOME/.wisp}/term/<tty>.jsonl, on this machine only. Remove this line from ~/.zshrc to stop.
zmodload zsh/datetime 2>/dev/null
__wisp_esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; print -rn -- "$s"; }
__wisp_preexec() { __wisp_cmd=$1; __wisp_t0=$EPOCHREALTIME; }
__wisp_precmd() {
  local ec=$?
  [[ -z $__wisp_cmd ]] && return
  local d="${WISP_HOME:-$HOME/.wisp}/term" t1=$EPOCHREALTIME tty=${TTY##*/}
  local -i ms=$(( (t1 - ${__wisp_t0:-$t1}) * 1000 )) at=$(( t1 * 1000 ))
  ( umask 077; mkdir -p "$d" && print -r -- "{\"cmd\":\"$(__wisp_esc "$__wisp_cmd")\",\"cwd\":\"$(__wisp_esc "$PWD")\",\"exit\":$ec,\"ms\":$ms,\"at\":$at,\"shell\":\"zsh\"}" >> "$d/${tty:-notty}.jsonl" ) 2>/dev/null
  __wisp_cmd=
}
autoload -Uz add-zsh-hook && add-zsh-hook preexec __wisp_preexec && add-zsh-hook precmd __wisp_precmd
"#;

const BASH: &str = r#"# wisp shell-init bash (ADR-0023): each command, its cwd, exit code, duration and time, kept 7 days in
# ${WISP_HOME:-$HOME/.wisp}/term/<tty>.jsonl, on this machine only. Remove this line from ~/.bashrc to stop.
__wisp_esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/}; printf '%s' "$s"; }
__wisp_ms() { if [ -n "${EPOCHREALTIME:-}" ]; then local t=${EPOCHREALTIME/[.,]/}; echo "${t:0:${#t}-3}"; else echo "$(( $(date +%s) * 1000 ))"; fi; }
__wisp_preexec() { [ -n "${COMP_LINE:-}" ] && return; [ "$BASH_COMMAND" = "__wisp_precmd" ] && return; [ -z "${__wisp_cmd:-}" ] && { __wisp_cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//'); __wisp_t0=$(__wisp_ms); }; }
__wisp_precmd() {
  local ec=$?
  [ -z "${__wisp_cmd:-}" ] && return
  local d="${WISP_HOME:-$HOME/.wisp}/term" t1 tty
  t1=$(__wisp_ms); tty=$(tty 2>/dev/null) || tty=notty; tty=${tty##*/}
  ( umask 077; mkdir -p "$d" && printf '{"cmd":"%s","cwd":"%s","exit":%d,"ms":%d,"at":%d,"shell":"bash"}\n' "$(__wisp_esc "$__wisp_cmd")" "$(__wisp_esc "$PWD")" "$ec" "$(( t1 - __wisp_t0 ))" "$t1" >> "$d/${tty:-notty}.jsonl" ) 2>/dev/null
  __wisp_cmd=
}
trap '__wisp_preexec' DEBUG
PROMPT_COMMAND="__wisp_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

const FISH: &str = r#"# wisp shell-init fish (ADR-0023): each command, its cwd, exit code, duration and time, kept 7 days in
# $WISP_HOME/term (or ~/.wisp/term)/<tty>.jsonl, on this machine only. Remove this line from config.fish to stop.
function __wisp_esc
    string replace -a '\\' '\\\\' -- $argv[1] | string replace -a '"' '\\"' | string replace -a \t '\\t' | string join '\\n'
end
function __wisp_postexec --on-event fish_postexec
    set -l ec $status
    test -z "$argv[1]"; and return
    set -l d (set -q WISP_HOME; and echo $WISP_HOME; or echo $HOME/.wisp)/term
    set -l tty (tty 2>/dev/null); or set tty notty
    set tty (basename $tty)
    set -l at (date +%s)000
    fish -c "umask 077; mkdir -p '$d'" 2>/dev/null
    printf '{"cmd":"%s","cwd":"%s","exit":%d,"ms":%d,"at":%d,"shell":"fish"}\n' (__wisp_esc "$argv[1]") (__wisp_esc "$PWD") $ec $CMD_DURATION $at >> $d/$tty.jsonl 2>/dev/null
    chmod 600 $d/$tty.jsonl 2>/dev/null
end
"#;

/// The `terminal.failed` events in the hook's log after `cursor` (the last `at` seen), and the new cursor. A
/// command that succeeded fires nothing. The first read only sets the cursor.
pub fn failed_since(log: &[Cmd], cursor: &Value, tty: &str) -> (Vec<Value>, Value) {
    let top = log.iter().map(|c| c.at).max().unwrap_or(0);
    let Some(seen) = cursor.get(tty).and_then(Value::as_i64) else {
        let mut c = cursor.as_object().cloned().unwrap_or_default();
        c.insert(tty.to_owned(), json!(top));
        return (Vec::new(), Value::Object(c));
    };
    let out = log
        .iter()
        .filter(|c| c.at > seen && c.exit.is_some_and(|e| e != 0))
        .map(|c| json!({ "key": format!("term:{tty}:{}", c.at), "at": c.at, "summary": format!("`{}` exited {} in {}", c.cmd.lines().next().unwrap_or(""), c.exit.unwrap_or(1), c.cwd), "payload": { "cmd": c.cmd, "cwd": c.cwd, "project": c.cwd, "exit": c.exit, "ms": c.ms, "tty": tty } }))
        .collect();
    let mut c = cursor.as_object().cloned().unwrap_or_default();
    c.insert(tty.to_owned(), json!(top.max(seen)));
    (out, Value::Object(c))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
