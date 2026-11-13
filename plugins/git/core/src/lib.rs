//! wisp-git-core: git's pure logic, sans-IO (no tokio, fs, net or clock). The host asks git; these
//! read the answers and decide. Every v1 git behaviour that isn't a process call lives here, with
//! property tests for the parsers.

pub mod base;
pub mod diff;
pub mod hunks;
pub mod mask;
pub mod ops;
pub mod porcelain;
pub mod repo_url;
pub mod stage;
pub mod tools;

#[cfg(test)]
pub(crate) mod testrng;

/// The environment of every git and gh call (edge case Git 1): never a prompt nobody can see, no
/// editor, and no optional locks, so a polled status never takes index.lock from the agent's own git.
pub const QUIET_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GIT_EDITOR", "true"),
    ("GIT_OPTIONAL_LOCKS", "0"),
];

/// Put before every read: no optional locks (twice over, for gits that ignore the variable) and
/// paths printed as they are (`core.quotePath=false`).
pub const READ_PREFIX: &[&str] = &["--no-optional-locks", "-c", "core.quotePath=false"];

/// Who a snapshot commit is by, so it works where git has no user.name.
pub const SNAPSHOT_ENV: &[(&str, &str)] = &[
    ("GIT_AUTHOR_NAME", "wisp"),
    ("GIT_AUTHOR_EMAIL", "wisp@localhost"),
    ("GIT_COMMITTER_NAME", "wisp"),
    ("GIT_COMMITTER_EMAIL", "wisp@localhost"),
];

/// A read's argv: `READ_PREFIX` then `args`.
pub fn read_args(args: &[&str]) -> Vec<String> {
    READ_PREFIX.iter().chain(args).map(|s| (*s).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn quiet_env_covers_edge_case_git_1() {
        for k in ["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED", "GIT_EDITOR"] {
            assert!(super::QUIET_ENV.iter().any(|(x, _)| *x == k), "{k}");
        }
        assert_eq!(super::read_args(&["status"]), ["--no-optional-locks", "-c", "core.quotePath=false", "status"]);
    }
}
