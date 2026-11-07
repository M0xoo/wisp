//! The environment a terminal starts with (v1 server/pty.js), as a patch on the server's own: proc
//! resolves it against the parent's environment, or a test's.

/// What a Claude Code session that started wisp (`npm run dev:web` from its terminal) leaves in the
/// environment. An interactive claude that inherits them thinks it is that session's child and keeps
/// no transcript, so the conversation can't be resumed. Only these: `CLAUDE_CODE_USE_BEDROCK` and such
/// are the user's own settings.
pub const PARENT_SESSION_ENV: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID"];

/// Settings that make Claude Code spend extra model calls on wisp's behalf (progress summaries of its
/// subagents). wisp never asks for them, so an exported value doesn't reach the CLIs it starts.
pub const COSTLY_ENV: &[&str] = &["CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES"];

/// Variables to set and to drop, applied to the parent's environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvPatch {
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

impl EnvPatch {
    /// `base` with the patch applied (what the program sees).
    pub fn apply(&self, base: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = base.into_iter().filter(|(k, _)| !self.remove.contains(k) && !self.set.iter().any(|(s, _)| s == k)).collect();
        out.extend(self.set.iter().cloned());
        out
    }
}

/// A take over drops the costly settings too; a shell beside the task is the user's own and keeps them.
pub fn term_env(takeover: bool) -> EnvPatch {
    let set = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("TERM_PROGRAM", "wisp")].map(|(k, v)| (k.to_owned(), v.to_owned())).to_vec();
    let mut remove: Vec<String> = std::iter::once("NO_COLOR").chain(PARENT_SESSION_ENV.iter().copied()).map(str::to_owned).collect();
    if takeover {
        remove.extend(COSTLY_ENV.iter().map(|k| (*k).to_owned()));
    }
    EnvPatch { set, remove }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
        env.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
    }

    // TS terms.test "termEnv: a Claude Code session that started wisp does not leak; a take over drops
    // costly settings, a shell keeps them" (v1 pty.test.js's two env tests, without a PTY).
    #[test]
    fn parent_session_markers_go_costly_settings_go_for_a_takeover_only() {
        let base: Vec<(String, String)> = [("PATH", "/bin"), ("CLAUDECODE", "1"), ("CLAUDE_CODE_CHILD_SESSION", "1"), ("CLAUDE_CODE_SESSION_ID", "x"), ("CLAUDE_CODE_USE_BEDROCK", "1"), ("CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES", "1"), ("NO_COLOR", "1"), ("TERM", "dumb")].map(|(k, v)| (k.to_owned(), v.to_owned())).to_vec();
        let take = term_env(true).apply(base.clone());
        assert_eq!([get(&take, "CLAUDECODE"), get(&take, "CLAUDE_CODE_CHILD_SESSION"), get(&take, "CLAUDE_CODE_SESSION_ID"), get(&take, "CLAUDE_CODE_USE_BEDROCK")], [None, None, None, Some("1")]);
        assert_eq!(get(&take, "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES"), None, "take over: gone");
        assert_eq!(get(&term_env(false).apply(base), "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES"), Some("1"), "shell: the user's own");
        assert_eq!([get(&take, "TERM"), get(&take, "COLORTERM"), get(&take, "TERM_PROGRAM"), get(&take, "NO_COLOR"), get(&take, "PATH")], [Some("xterm-256color"), Some("truecolor"), Some("wisp"), None, Some("/bin")]);
        assert_eq!(take.iter().filter(|(k, _)| k == "TERM").count(), 1);
    }
}
