//! What a failed `ssh` most likely needs, from its stderr, in words for someone who has never used
//! SSH. `let_in`: the page offers the password-once box; `command`: the by-hand way.
use wisp_machines_api::Hint;

use crate::shell::host_of;

fn has(e: &str, needles: &[&str]) -> bool {
    let low = e.to_ascii_lowercase();
    needles
        .iter()
        .any(|n| low.contains(&n.to_ascii_lowercase()))
}

pub fn ssh_hint(stderr: &str, target: &str) -> Option<Hint> {
    let host = host_of(target);
    if has(
        stderr,
        &[
            "Permission denied",
            "Too many authentication failures",
            "publickey",
        ],
    ) {
        return Some(Hint {
            command: Some(format!("ssh-copy-id {target}")),
            let_in: true,
            ..Hint::titled(
                "This computer isn’t allowed in yet",
                format!(
                    "{host} doesn’t know this computer yet. Type your password on {host} once and wisp sets up a key there, so it won’t ask again."
                ),
            )
        });
    }
    if has(
        stderr,
        &[
            "Host key verification failed",
            "REMOTE HOST IDENTIFICATION HAS CHANGED",
        ],
    ) {
        return Some(Hint {
            command: Some(format!("ssh {target}")),
            ..Hint::titled(
                "It looks different from last time",
                format!(
                    "{host} looks different from last time (its SSH identity changed). If you reinstalled it, that’s expected: check it once in a terminal, then connect again."
                ),
            )
        });
    }
    if has(
        stderr,
        &[
            "Could not resolve hostname",
            "Name or service not known",
            "nodename nor servname",
        ],
    ) {
        return Some(Hint {
            tailscale: true,
            ..Hint::titled(
                "Computer not found",
                format!(
                    "wisp can’t find a computer called {host}. Check the spelling, or use its IP address. Not on the same network? Put both computers on Tailscale and use its Tailscale name."
                ),
            )
        });
    }
    if has(stderr, &["Connection refused"]) {
        return Some(Hint::titled(
            "SSH is off there",
            format!(
                "{host} answered, but SSH is off there. On a Mac: System Settings → General → Sharing → Remote Login. On Linux: install openssh-server. Then connect again."
            ),
        ));
    }
    if has(
        stderr,
        &[
            "timed out",
            "No route to host",
            "Network is unreachable",
            "Connection closed",
            "Broken pipe",
        ],
    ) {
        return Some(Hint {
            tailscale: true,
            ..Hint::titled(
                "No answer",
                format!(
                    "{host} doesn’t answer. Is it on and awake, and on the same network as this computer? From anywhere else, put both on Tailscale."
                ),
            )
        });
    }
    if has(stderr, &["Address already in use", "forwarding failed"]) {
        return Some(Hint {
            text: "The local end of the tunnel was taken. Connect again to pick another port."
                .into(),
            ..Hint::default()
        });
    }
    None
}

/// The hint for a bootstrap step that failed for good (v1: `node`, now the wisp binary).
pub fn step_hint(step: &str) -> Option<Hint> {
    (step == crate::bootstrap::INSTALL).then(|| Hint {
        url: Some("https://github.com/M0xoo/wisp/releases".into()),
        ..Hint::titled("wisp couldn’t be installed there", "wisp couldn’t install itself there (see above). Install wisp on that computer by hand (npm i -g wisp-agents, or the download for its system), then Try again.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_from_stderr() {
        let h = ssh_hint("me@box: Permission denied (publickey).", "me@box").unwrap_or_default();
        assert_eq!(h.command.as_deref(), Some("ssh-copy-id me@box"));
        assert!(h.let_in);
        assert!(h.title.unwrap_or_default().contains("isn’t allowed in yet"));
        assert!(
            ssh_hint("ssh: Could not resolve hostname nope", "nope")
                .unwrap_or_default()
                .text
                .contains("can’t find a computer called nope")
        );
        assert!(
            ssh_hint(
                "ssh: connect to host box port 22: Operation timed out",
                "me@box"
            )
            .unwrap_or_default()
            .tailscale
        );
        assert!(
            ssh_hint(
                "ssh: connect to host box port 22: Connection refused",
                "me@box"
            )
            .unwrap_or_default()
            .text
            .contains("Remote Login")
        );
        assert!(
            ssh_hint(
                "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
                "me@box"
            )
            .unwrap_or_default()
            .command
            .is_some_and(|c| c == "ssh me@box")
        );
        assert!(
            ssh_hint("bind [127.0.0.1]:5555: Address already in use", "box")
                .unwrap_or_default()
                .text
                .contains("another port")
        );
        assert_eq!(ssh_hint("something else", "box"), None);
    }
}
