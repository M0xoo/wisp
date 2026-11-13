//! What Ship it needs on this computer (v1 tools()): git, and gh signed in to GitHub, with how to get
//! what's missing on this OS; and the words for a clone that failed.

use wisp_git_api::{ToolSetup, ToolState};

fn setup(tip: &str, command: &str, url: &str) -> ToolSetup {
    ToolSetup { tip: tip.into(), command: command.into(), url: url.into() }
}

/// How to install `id` ("git" | "gh") on `platform` ("macos" | "windows" | anything else = linux).
pub fn tool_setup(id: &str, platform: &str) -> ToolSetup {
    match (id, platform) {
        ("git", "macos") => {
            setup("Install Apple’s command line tools: they include git", "xcode-select --install", "https://git-scm.com/downloads/mac")
        }
        ("git", "windows") => setup(
            "Install Git for Windows, then restart wisp",
            "winget install --id Git.Git -e --source winget",
            "https://git-scm.com/downloads/win",
        ),
        ("git", _) => setup(
            "Install git with your package manager (apt, dnf, pacman…)",
            "sudo apt install -y git",
            "https://git-scm.com/downloads/linux",
        ),
        (_, "macos") => setup("Install the GitHub CLI, then sign in here", "brew install gh", "https://cli.github.com"),
        (_, "windows") => setup(
            "Install the GitHub CLI, then restart wisp and sign in here",
            "winget install --id GitHub.cli -e --source winget",
            "https://cli.github.com",
        ),
        _ => setup(
            "Install the GitHub CLI with your package manager, then sign in here",
            "sudo apt install -y gh",
            "https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
        ),
    }
}

/// `git --version`: macOS ships a git that only offers to install the tools, so it must say "git version".
pub fn git_state(ok: bool, out: &str, platform: &str) -> ToolState {
    let installed = ok && out.contains("git version");
    ToolState { installed, signed_in: None, setup: (!installed).then(|| tool_setup("git", platform)) }
}

/// `gh auth status --hostname github.com`: signed in, out, or None when the answer is unknown (offline).
pub fn gh_state(missing: bool, ok: bool, out: &str, platform: &str) -> ToolState {
    let low = out.to_ascii_lowercase();
    let signed_in = if missing {
        None
    } else if ok {
        Some(true)
    } else if ["not logged in", "no longer valid", "invalid", "gh auth login"].iter().any(|p| low.contains(p)) {
        Some(false)
    } else {
        None
    };
    ToolState { installed: !missing, signed_in, setup: missing.then(|| tool_setup("gh", platform)) }
}

/// The words for a clone that failed (both gh and git tried).
pub fn clone_error(what: &str, message: &str, via_gh: bool) -> String {
    let low = message.to_ascii_lowercase();
    let hidden = ["not found", "does not exist", "could not read username", "authentication", "permission denied", "403"]
        .iter()
        .any(|p| low.contains(p));
    if hidden {
        let hint = if via_gh { " Private repo? Check `gh auth status`." } else { "" };
        format!("Couldn’t clone {what}: it doesn’t exist, or this login can’t see it.{hint}")
    } else {
        format!("Couldn’t clone {what}: {message}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_needs_its_version_line() {
        assert!(git_state(true, "git version 2.46.0", "macos").installed);
        let shim = git_state(false, "xcode-select: note: no developer tools were found", "macos");
        assert!(!shim.installed);
        assert_eq!(shim.setup.map(|s| s.command).as_deref(), Some("xcode-select --install"));
        assert_eq!(git_state(false, "", "freebsd").setup.map(|s| s.command).as_deref(), Some("sudo apt install -y git"));
    }

    #[test]
    fn gh_signed_in_out_or_unknown() {
        assert_eq!(gh_state(false, true, "Logged in to github.com", "linux").signed_in, Some(true));
        assert_eq!(gh_state(false, false, "You are not logged into any GitHub hosts. Run gh auth login", "linux").signed_in, Some(false));
        assert_eq!(gh_state(false, false, "error connecting to api.github.com", "linux").signed_in, None, "offline: nothing nags");
        let missing = gh_state(true, false, "", "windows");
        assert!(!missing.installed && missing.signed_in.is_none());
        assert!(missing.setup.is_some_and(|s| s.command.starts_with("winget")));
    }

    #[test]
    fn clone_errors() {
        assert_eq!(
            clone_error("o/r", "Repository not found.", true),
            "Couldn’t clone o/r: it doesn’t exist, or this login can’t see it. Private repo? Check `gh auth status`."
        );
        assert_eq!(
            clone_error("u", "fatal: could not read Username", false),
            "Couldn’t clone u: it doesn’t exist, or this login can’t see it."
        );
        assert_eq!(clone_error("u", "disk full", false), "Couldn’t clone u: disk full");
    }
}
