//! Secrets in text about to leave this computer (a shared crew member): API keys, tokens, private keys
//! (v1 web/js/secret-scan.js). Each hit says where, the line and what it looks like, never the secret.

use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Hit {
    #[serde(rename = "where")]
    pub place: String,
    pub line: usize,
    pub what: String,
}

const PATTERNS: [(&str, &str); 14] = [
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
    // key = "value": a name that says secret, then something long enough to be one.
    (
        "a secret value",
        r#"(?i)\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{16,})"#,
    ),
    // A placeholder, not a secret (v1's negative lookahead; checked after the match).
    ("", r"(?i)^(xxx|your[_-]|example|placeholder|changeme)"),
];

fn compiled() -> &'static [(String, Regex)] {
    static RE: OnceLock<Vec<(String, Regex)>> = OnceLock::new();
    RE.get_or_init(|| PATTERNS.iter().filter_map(|(w, p)| Regex::new(p).ok().map(|r| ((*w).to_owned(), r))).collect())
}

fn line_hit(l: &str) -> Option<&'static str> {
    let all = compiled();
    let placeholder = all.last().map(|(_, r)| r);
    for (what, re) in all.iter().take(all.len().saturating_sub(1)) {
        let hit = if what == "a secret value" {
            re.captures_iter(l).any(|c| c.get(3).is_some_and(|v| !placeholder.is_some_and(|p| p.is_match(v.as_str()))))
        } else {
            re.is_match(l)
        };
        if hit {
            return PATTERNS.iter().map(|(w, _)| *w).find(|w| w == what);
        }
    }
    None
}

/// Several named texts → every hit, one per line at most (the first kind that matches it).
pub fn scan_all(texts: &[(String, String)]) -> Vec<Hit> {
    let mut out = Vec::new();
    for (place, text) in texts {
        for (i, l) in text.lines().enumerate() {
            if let Some(what) = line_hit(l) {
                out.push(Hit { place: place.clone(), line: i + 1, what: what.to_owned() });
            }
        }
    }
    out
}
