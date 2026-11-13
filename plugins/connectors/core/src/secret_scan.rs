//! Secrets in text: v1's web/js/secret-scan.js patterns, which a connector's command or URL is
//! checked against (a token pasted there would sit in the store, not in the secrets file). A private
//! copy until a shared text crate holds the one list (channels and git need it too).

use std::sync::LazyLock;

use regex::Regex;

/// (what it looks like, pattern). The last one is checked further in [`generic_value`]: the regex
/// crate has no look-ahead, and v1's pattern skips placeholders with one.
const PATTERNS: [(&str, &str); 13] = [
    ("a private key", r"-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----"),
    ("a GitHub token", r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    ("an Anthropic API key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    ("an OpenAI API key", r"\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}"),
    ("an AWS access key", r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("a Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("a Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    ("a Discord bot token", r"\b[MNO][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}"),
    ("a Stripe key", r"\b[sr]k_live_[A-Za-z0-9]{20,}"),
    ("an npm token", r"\bnpm_[A-Za-z0-9]{36}\b"),
    ("a JSON Web Token", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ("a password in a URL", r"(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s/@]{4,}@"),
    (
        "a secret value",
        r#"(?i)\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?(?P<v>[A-Za-z0-9/+_.=-]{16,})"#,
    ),
];

/// What a placeholder starts with (v1's negative look-ahead, case-insensitive).
const PLACEHOLDERS: [&str; 6] = ["xxx", "your_", "your-", "example", "placeholder", "changeme"];

static COMPILED: LazyLock<Vec<(&'static str, Regex)>> =
    LazyLock::new(|| PATTERNS.iter().filter_map(|(what, re)| Regex::new(re).ok().map(|r| (*what, r))).collect());

/// How many patterns compiled (all of them; a test holds it to that).
pub fn pattern_count() -> usize {
    COMPILED.len()
}

fn generic_value(re: &Regex, line: &str) -> bool {
    re.captures_iter(line).any(|c| {
        c.name("v").is_some_and(|v| {
            let v = v.as_str().to_ascii_lowercase();
            !PLACEHOLDERS.iter().any(|p| v.starts_with(p))
        })
    })
}

/// One hit for a line: the first kind that matches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// 1-based
    pub line: usize,
    pub what: &'static str,
}

/// text → one hit per line at most: what it looks like, never the secret.
pub fn scan_secrets(text: &str) -> Vec<Hit> {
    let mut out = Vec::new();
    for (i, l) in text.lines().enumerate() {
        let hit = COMPILED.iter().find(|(what, re)| if *what == "a secret value" { generic_value(re, l) } else { re.is_match(l) });
        if let Some((what, _)) = hit {
            out.push(Hit { line: i + 1, what });
        }
    }
    out
}
