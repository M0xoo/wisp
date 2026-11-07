//! The steps that open a command in the user's terminal app (v1 server/terminal.js `terminalPlan`):
//! pure, so every app's command line on every platform is tested without launching anything. The host
//! runs them through proc's `spawn_detached` (`schedule` says when).

use crate::apps::{Lookups, MACOS_WEZTERM, detect_terminal};
use crate::error::TerminalError;
use crate::quote::{as_str, cmd_argument, cmd_command, psq, shq};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// start a program on its own; `cwd` overrides the plan's folder, `verbatim` passes the args to
    /// cmd.exe as written (already quoted for it)
    Run { command: String, args: Vec<String>, cwd: Option<String>, verbatim: bool },
    /// an AppleScript, run with `osascript -e`
    Osa(String),
    /// wait this long (ms) before the steps after it
    Delay(u64),
}

/// What a plan asks for.
#[derive(Debug, Clone, Copy)]
pub struct PlanArgs<'a> {
    pub cwd: &'a str,
    /// the agent's resume command (`claude --resume abc`), or the login shell
    pub argv: &'a [String],
    pub terminal: &'a str,
    /// Settings' custom command line, with `{cwd}`, `{cmd}` and `{line}`
    pub custom: &'a str,
}

const CMUX_CLI: &str = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const CUSTOM_MISSING: &str = "Set a custom terminal command in settings, e.g.  alacritty --working-directory {cwd} -e {cmd}";

fn run(command: &str, args: Vec<String>) -> Step {
    Step::Run { command: command.to_owned(), args, cwd: None, verbatim: false }
}

/// Detached into `cwd`: on Windows that gives the child its own console window.
fn detached(command: &str, args: Vec<String>, cwd: &str, verbatim: bool) -> Step {
    Step::Run { command: command.to_owned(), args, cwd: Some(cwd.to_owned()), verbatim }
}

fn strs(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| (*s).to_owned()).collect()
}

/// The command lines one plan needs, quoted for each shell.
struct Lines {
    /// POSIX: `'codex' 'resume' 'id'`
    cmd: String,
    /// `cd '<cwd>' && <cmd>`
    line: String,
    /// Linux terminals run the command, then leave an interactive shell open in the project
    keep_open: Vec<String>,
    /// PowerShell: `& 'codex' 'resume' 'id'` works for .exe, .cmd and .ps1 alike
    ps: String,
    /// cmd.exe
    cmd_line: String,
}

impl Lines {
    fn new(cwd: &str, argv: &[String]) -> Self {
        let cmd = argv.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ");
        let line = format!("cd {} && {cmd}", shq(cwd));
        let keep_open = vec!["sh".to_owned(), "-c".to_owned(), format!("{cmd}; exec \"${{SHELL:-sh}}\"")];
        let ps = format!("& {}", argv.iter().map(|a| psq(a)).collect::<Vec<_>>().join(" "));
        let first = argv.first().map(|a| cmd_command(a)).unwrap_or_default();
        let cmd_line = std::iter::once(first).chain(argv.iter().skip(1).map(|a| cmd_argument(a, true))).collect::<Vec<_>>().join(" ");
        Self { cmd, line, keep_open, ps, cmd_line }
    }
}

/// The steps that open `argv` in `cwd` in the chosen terminal (`auto` detects one).
pub fn terminal_plan(a: PlanArgs<'_>, l: &Lookups<'_>) -> Result<Vec<Step>, TerminalError> {
    let t = if a.terminal == "auto" { detect_terminal(l) } else { a.terminal.to_owned() };
    let x = Lines::new(a.cwd, a.argv);
    let comspec = l.var("ComSpec").or_else(|| l.var("COMSPEC")).unwrap_or_else(|| "cmd.exe".to_owned());
    Ok(match t.as_str() {
        "terminal" => vec![Step::Osa(format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell", as_str(&x.line)))],
        "iterm" => vec![Step::Osa(format!("tell application \"iTerm\"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text {}\nend tell", as_str(&x.line)))],
        // Warp has no scripting API: open a tab in the folder and type via System Events
        "warp" => vec![run("open", strs(&["-a", "Warp", a.cwd])), Step::Delay(1200), Step::Osa(keystroke(&x.cmd))],
        "cmux" => vec![cmux(a.cwd, &x.cmd, l)],
        // `;` separates wt subcommands, so it can't appear unescaped in the command line
        "wt" => vec![detached("wt.exe", strs(&["-d", a.cwd, "powershell.exe", "-NoExit", "-Command", &x.ps.replace(';', "\\;")]), a.cwd, false)],
        "powershell" => vec![detached("powershell.exe", strs(&["-NoExit", "-Command", &x.ps]), a.cwd, false)],
        "cmd" => vec![detached(&comspec, strs(&["/d", "/s", "/k", &format!("\"{}\"", x.cmd_line)]), a.cwd, true)],
        "custom" => vec![custom(a, &x, l, &comspec)?],
        "wisp" => return Err(TerminalError::InWisp),
        other => vec![native(other, a, &x, l)],
    })
}

fn keystroke(cmd: &str) -> String {
    format!("tell application \"System Events\" to keystroke {} & return", as_str(cmd))
}

/// `cmux new-workspace` talks to cmux's socket, which by default only accepts processes started inside
/// cmux. When it is refused (or cmux isn't running), open the folder as a new workspace and type the
/// command, like Warp.
fn cmux(cwd: &str, cmd: &str, l: &Lookups<'_>) -> Step {
    let cli = if (l.has)("cmux") { "cmux" } else { CMUX_CLI };
    let script = "\"$1\" new-workspace --cwd \"$2\" --command \"$3\" >/dev/null 2>&1 && open -a cmux || { open -a cmux \"$2\" && sleep 1.5 && osascript -e \"$4\"; }";
    detached("/bin/sh", strs(&["-c", script, "sh", cli, cwd, cmd, &keystroke(cmd)]), cwd, false)
}

fn custom(a: PlanArgs<'_>, x: &Lines, l: &Lookups<'_>, comspec: &str) -> Result<Step, TerminalError> {
    if a.custom.is_empty() {
        return Err(TerminalError::NoCustom(CUSTOM_MISSING));
    }
    if l.platform == crate::apps::WIN32 {
        let full = a.custom.replace("{cwd}", &format!("\"{}\"", a.cwd)).replace("{cmd}", &x.cmd_line).replace("{line}", &format!("cd /d \"{}\" ^&^& {}", a.cwd, x.cmd_line));
        return Ok(detached(comspec, strs(&["/d", "/s", "/c", &format!("\"{full}\"")]), a.cwd, true));
    }
    let full = a.custom.replace("{cwd}", &shq(a.cwd)).replace("{cmd}", &x.cmd).replace("{line}", &shq(&x.line));
    Ok(detached("sh", strs(&["-c", &full]), a.cwd, false))
}

/// The apps that take a folder and a program on their command line.
fn native(t: &str, a: PlanArgs<'_>, x: &Lines, l: &Lookups<'_>) -> Step {
    let mac = l.platform == crate::apps::DARWIN;
    let win = l.platform == crate::apps::WIN32;
    let cwd = a.cwd;
    let with = |head: &[&str], tail: &[String]| -> Vec<String> { strs(head).into_iter().chain(tail.iter().cloned()).collect() };
    match t {
        "ghostty" if mac => run("open", with(&["-na", "Ghostty", "--args", &format!("--working-directory={cwd}"), "-e"], a.argv)),
        "ghostty" => run("ghostty", with(&[&format!("--working-directory={cwd}"), "-e"], &x.keep_open)),
        "kitty" if mac => run("open", with(&["-na", "kitty", "--args", "--directory", cwd], a.argv)),
        "kitty" => run("kitty", with(&["--directory", cwd], &x.keep_open)),
        "wezterm" if win => detached("wezterm", with(&["start", "--cwd", cwd, "--", "powershell.exe", "-NoExit", "-Command"], std::slice::from_ref(&x.ps)), cwd, false),
        "wezterm" => run(if mac { MACOS_WEZTERM } else { "wezterm" }, with(&["start", "--cwd", cwd, "--"], if mac { a.argv } else { &x.keep_open })),
        "gnome-terminal" => run("gnome-terminal", with(&[&format!("--working-directory={cwd}"), "--"], &x.keep_open)),
        "konsole" => run("konsole", with(&["--workdir", cwd, "-e"], &x.keep_open)),
        "xfce4-terminal" => run("xfce4-terminal", with(&[&format!("--working-directory={cwd}"), "-x"], &x.keep_open)),
        "alacritty" => run("alacritty", with(&["--working-directory", cwd, "-e"], &x.keep_open)),
        // x-terminal-emulator (Debian/Ubuntu alternatives), xterm, and any other name
        other => detached(other, with(&["-e"], &x.keep_open), cwd, false),
    }
}

/// One program to start, and when (ms after the plan began).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub after_ms: u64,
    pub bin: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub verbatim: bool,
}

/// The plan as programs to start: delays add up, AppleScript runs through `osascript -e`.
pub fn schedule(plan: &[Step], cwd: &str) -> Vec<Launch> {
    let mut wait = 0;
    let mut out = Vec::new();
    for step in plan {
        let (bin, args, at, verbatim) = match step {
            Step::Delay(ms) => {
                wait += ms;
                continue;
            }
            Step::Osa(script) => ("osascript".to_owned(), vec!["-e".to_owned(), script.clone()], None, false),
            Step::Run { command, args, cwd, verbatim } => (command.clone(), args.clone(), cwd.clone(), *verbatim),
        };
        out.push(Launch { after_ms: wait, bin, args, cwd: at.unwrap_or_else(|| cwd.to_owned()), verbatim });
    }
    out
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod tests;
