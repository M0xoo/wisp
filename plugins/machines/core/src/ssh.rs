//! Every argv wisp hands to the system's OpenSSH (it keeps `~/.ssh/config`, agents, `ProxyJump` and
//! FIDO keys). The target is checked by [`crate::shell::is_target`] before it gets here, and comes
//! last before the remote command, so it can never be read as an option.
use crate::shell::shq;

/// The connection: no tty, keys only, new host keys accepted once, dead links noticed in 45 s, and
/// the forward `local → 127.0.0.1:<port>` there (or ssh exits: the port was taken).
pub fn connect_args(target: &str, local_port: u16, remote_port: u16) -> Vec<String> {
    let mut a: Vec<String> = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
    ]
    .map(str::to_owned)
    .to_vec();
    a.extend(["-L".to_owned(), format!("{local_port}:127.0.0.1:{remote_port}"), target.to_owned(), "sh -s".to_owned()]);
    a
}

/// One command over there (stop wisp there): keys only, no forward.
pub fn run_args(target: &str, command: &str) -> Vec<String> {
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target, command].map(str::to_owned).to_vec()
}

/// Stops wisp there by its pid (a number: nothing else reaches the remote shell).
pub fn kill_command(pid: u32) -> String {
    format!("kill {pid} 2>&1 || true")
}

/// A terminal over there running `command` in the user's own interactive login shell (so its PATH
/// has the harness), wrapped in sh so a fish or nu login shell parses it too.
pub fn terminal_argv(ssh: &str, target: &str, command: &str) -> Vec<String> {
    vec![
        ssh.to_owned(),
        "-t".to_owned(),
        target.to_owned(),
        format!("sh -c {} {}", shq(r#"exec "${SHELL:-/bin/sh}" -lic "$0""#), shq(command)),
    ]
}

/// Adds the key on stdin to `~/.ssh/authorized_keys` there, once, whatever the login shell is.
pub fn add_key_command() -> String {
    format!(
        "sh -c {}",
        shq(
            r#"umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && read -r k && { grep -qxF "$k" ~/.ssh/authorized_keys || printf "%s\n" "$k" >> ~/.ssh/authorized_keys; }"#
        )
    )
}

/// "Let me in" with a password: one auth method per try (after a wrong password some servers fall
/// through to keyboard-interactive and wait forever), no key offered.
pub fn let_in_args(target: &str, method: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-T",
        "-o",
        "BatchMode=no",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "ConnectTimeout=15",
    ]
    .map(str::to_owned)
    .to_vec();
    a.extend(["-o".to_owned(), format!("PreferredAuthentications={method}"), target.to_owned(), add_key_command()]);
    a
}

/// The askpass helper: prints the password from the environment, so it never touches the disk or
/// an argv. `SSH_ASKPASS_REQUIRE=force` makes ssh use it even with a terminal.
pub const ASKPASS_SH: &str = "#!/bin/sh\nprintf \"%s\\n\" \"$WISP_ASKPASS\"\n";
pub const ASKPASS_CMD: &str = "@echo off\r\necho %WISP_ASKPASS%\r\n";

/// The environment of a let-in try (the password only in `WISP_ASKPASS`).
pub fn askpass_env(askpass: &str, password: &str, display: Option<&str>) -> Vec<(String, String)> {
    vec![
        ("SSH_ASKPASS".into(), askpass.into()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        ("DISPLAY".into(), display.unwrap_or(":0").into()),
        ("WISP_ASKPASS".into(), password.into()),
    ]
}

/// The keys tried, in order; none: `ssh-keygen` makes an ed25519 one with no passphrase, once.
pub const KEYS: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

pub fn keygen_args(file: &str, hostname: &str) -> Vec<String> {
    ["-q", "-t", "ed25519", "-N", "", "-C", &format!("wisp@{hostname}"), "-f", file].map(str::to_owned).to_vec()
}

/// What the server accepts, from `Permission denied (publickey,password).`
pub fn offered(out: &str) -> &str {
    let Some(i) = out.find("Permission denied (") else {
        return "";
    };
    let rest = &out[i + "Permission denied (".len()..];
    rest.find(')').map_or("", |j| &rest[..j])
}

/// What one let-in try came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LetInVerdict {
    Ok,
    /// try once more with keyboard-interactive: the server offers nothing else
    TryKeyboard,
    /// 504
    TimedOut,
    /// 400 · `passwords_off`: the server takes no passwords at all, no point retrying
    Refused {
        passwords_off: bool,
    },
    /// 502 with ssh's last line
    Other(String),
}

/// `code`: ssh's exit (`None`: it was killed after 40 s). `first`: this was the password try.
pub fn let_in_verdict(code: Option<i32>, out: &str, first: bool) -> LetInVerdict {
    let off = offered(out);
    match code {
        None => LetInVerdict::TimedOut,
        Some(0) => LetInVerdict::Ok,
        Some(_) if first && off.contains("keyboard-interactive") && !off.contains("password") => LetInVerdict::TryKeyboard,
        Some(_)
            if ["Permission denied", "Authentication failed", "Too many authentication failures"]
                .iter()
                .any(|n| out.to_ascii_lowercase().contains(&n.to_ascii_lowercase())) =>
        {
            LetInVerdict::Refused { passwords_off: !off.is_empty() && !off.contains("password") && !off.contains("keyboard-interactive") }
        }
        Some(c) => LetInVerdict::Other(
            out.lines().rev().find(|l| !l.trim().is_empty()).map_or_else(|| format!("ssh exited ({c})."), |l| l.trim().to_owned()),
        ),
    }
}

/// The words for a refused let-in.
pub fn let_in_refusal(passwords_off: bool) -> &'static str {
    if passwords_off {
        "That computer doesn’t accept passwords over SSH (common on cloud servers). Add this computer’s key there by hand."
    } else {
        "Wrong password. Use the one you sign in to that computer with."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forward_and_the_target_come_last() {
        let a = connect_args("me@devbox", 51234, 4477);
        assert_eq!(a[a.len() - 3..], ["51234:127.0.0.1:4477", "me@devbox", "sh -s"]);
        assert!(a.iter().any(|x| x == "BatchMode=yes") && a.iter().any(|x| x == "ExitOnForwardFailure=yes"));
        assert_eq!(run_args("box", &kill_command(42)).last().map(String::as_str), Some("kill 42 2>&1 || true"));
    }

    #[test]
    fn a_take_over_runs_in_the_login_shell_under_sh() {
        let a = terminal_argv("ssh", "box", "claude --resume 'x'");
        assert_eq!(a[..3], ["ssh", "-t", "box"]);
        assert_eq!(a[3], r#"sh -c 'exec "${SHELL:-/bin/sh}" -lic "$0"' 'claude --resume '\''x'\'''"#);
    }

    #[test]
    fn let_in_is_one_method_per_try_and_the_password_stays_out_of_argv() {
        let a = let_in_args("box", "password");
        assert!(a.iter().any(|x| x == "PreferredAuthentications=password"));
        assert!(a.iter().any(|x| x == "PubkeyAuthentication=no") && a.iter().any(|x| x == "NumberOfPasswordPrompts=1"));
        let env = askpass_env("/tmp/a.sh", "open sesame", None);
        assert!(!a.iter().any(|x| x.contains("open sesame")));
        assert!(
            env.contains(&("SSH_ASKPASS_REQUIRE".into(), "force".into())) && env.contains(&("WISP_ASKPASS".into(), "open sesame".into()))
        );
        assert!(add_key_command().contains("grep -qxF"), "never added twice");
    }

    #[test]
    fn let_in_verdicts() {
        assert_eq!(let_in_verdict(Some(0), "", true), LetInVerdict::Ok);
        assert_eq!(let_in_verdict(None, "", true), LetInVerdict::TimedOut);
        assert_eq!(
            let_in_verdict(Some(255), "me@box: Permission denied (publickey,keyboard-interactive).", true),
            LetInVerdict::TryKeyboard
        );
        assert_eq!(
            let_in_verdict(Some(255), "me@box: Permission denied (publickey,keyboard-interactive).", false),
            LetInVerdict::Refused { passwords_off: false }
        );
        assert_eq!(
            let_in_verdict(Some(255), "Permission denied (publickey,password).", true),
            LetInVerdict::Refused { passwords_off: false }
        );
        assert_eq!(let_in_verdict(Some(255), "Permission denied (publickey).", true), LetInVerdict::Refused { passwords_off: true });
        assert_eq!(
            let_in_verdict(Some(255), "ssh: connect to host x: Connection refused\n", true),
            LetInVerdict::Other("ssh: connect to host x: Connection refused".into())
        );
        assert_eq!(let_in_verdict(Some(1), "", true), LetInVerdict::Other("ssh exited (1).".into()));
        assert!(let_in_refusal(false).starts_with("Wrong password"));
    }
}
