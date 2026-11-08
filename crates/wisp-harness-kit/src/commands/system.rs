//! Shell built-ins and system commands: cd, echo, sleep, curl, ps, kill, lsof, ssh, nested shells
//! and the agent CLIs.

use super::argv::{Ctx, Known, operands, say, say_weak};
use super::url::host;
use crate::re::Re;
use crate::text::lower;

static URL: Re = Re::new(r"^https?://");
static BARE_HOST: Re = Re::new(r"^(localhost|127\.0\.0\.1|[A-Za-z0-9_.-]+\.[a-z]{2,})(?:[/:]|$)");
static PORT: Re = Re::new(r"^-?i?:[0-9]+$|^tcp:[0-9]+$");

fn fetching(c: &Ctx) -> Known {
    let url = c
        .args
        .iter()
        .find(|a| URL.is_match(a) || BARE_HOST.is_match(a));
    say(url.map_or_else(
        || "Fetching a URL".into(),
        |u| format!("Fetching {}", host(u)),
    ))
}

/// `while <cond>` / `until <cond>`: say what is being waited on.
fn waiting_on(c: &Ctx) -> Result<Known, super::Empty> {
    let inner = super::describe_words(c.args, c.paths, c.piped)?;
    Ok(say(match inner {
        Some(d) if !d.unknown => format!("Waiting on: {}", lower(&d.text)),
        _ => "Waiting for something to change".into(),
    }))
}

fn lsof(c: &Ctx) -> Known {
    let port = c.args.iter().find(|a| PORT.is_match(a));
    say(port.map_or_else(
        || "Checking open files".into(),
        |p| {
            format!(
                "Checking what is using port {}",
                p.chars().filter(char::is_ascii_digit).collect::<String>()
            )
        },
    ))
}

fn shell(c: &Ctx) -> Known {
    if matches!(c.arg(0), Some("-c" | "-lc")) {
        return Some(Some(super::describe_inner(c.arg(1), c.paths)));
    }
    let ops = operands(c.args);
    say(ops.first().map_or_else(
        || "Running a shell script".into(),
        |f| format!("Running {}", c.f(f)),
    ))
}

fn agent_name(cmd: &str) -> String {
    if cmd == "cursor-agent" {
        return "Cursor".into();
    }
    let mut ch = cmd.chars();
    ch.next()
        .map_or_else(String::new, |f| f.to_uppercase().chain(ch).collect())
}

/// The system commands' answer for `c`, or None when `c.cmd` isn't one of them.
pub(super) fn describe(c: &Ctx) -> Result<Known, super::Empty> {
    let t = c.target();
    Ok(match c.cmd {
        "cd" | "pushd" | "popd" => say_weak(c.arg(0).filter(|a| !a.is_empty()).map_or_else(
            || "Changing folder".into(),
            |a| format!("Going to {}", c.f(a)),
        )),
        "export" | "set" | "unset" | "source" | "." | "true" | "false" | "shift" | "local"
        | "read" | "trap" | ":" | "for" | "case" => say_weak("Setting up the shell"),
        "echo" | "printf" => say_weak("Printing a message"),
        "pwd" => say_weak("Checking the current folder"),
        "curl" | "wget" | "http" | "xh" => fetching(c),
        "open" | "xdg-open" => say(format!(
            "Opening {}",
            if t.is_empty() { "a file" } else { &t }
        )),
        "sleep" => {
            let a = c.arg(0).unwrap_or("");
            let secs = !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit());
            say(crate::js::trim(&format!("Waiting {a}{}", if secs { "s" } else { "" })).to_owned())
        }
        "wait" => say("Waiting for background jobs"),
        "until" | "while" => waiting_on(c)?,
        "if" | "test" | "[" | "[[" => say_weak("Checking a condition"),
        "ps" | "pgrep" | "top" | "htop" => say("Checking running processes"),
        "kill" | "pkill" | "killall" => say("Stopping a process"),
        "lsof" => lsof(c),
        "which" | "whereis" | "type" => say(format!(
            "Checking if {} is installed",
            operands(c.args).first().copied().unwrap_or("a tool")
        )),
        "env" | "printenv" => say("Checking environment variables"),
        "uname" | "sw_vers" | "hostname" | "whoami" | "id" => say("Checking the system"),
        "date" => say_weak("Checking the time"),
        "ssh" => say(format!(
            "Connecting to {}",
            operands(c.args).first().copied().unwrap_or("a server")
        )),
        "scp" => say("Copying files over SSH"),
        "claude" | "codex" | "gemini" | "cursor-agent" | "opencode" => {
            say(format!("Asking {}", agent_name(c.cmd)))
        }
        "bash" | "sh" | "zsh" => shell(c),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_compile() {
        for r in [&URL, &BARE_HOST, &PORT] {
            assert!(r.compiles(), "{}", r.pattern());
        }
    }
}
