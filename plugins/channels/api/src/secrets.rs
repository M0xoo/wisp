//! Secrets in text about to leave this computer: API keys, tokens, private keys. The port of v1's
//! `web/js/secret-scan.js`, pattern for pattern and in the same order (the first kind that matches a
//! line names it). Each pattern is a hand-written matcher over bytes: no regex engine on the path
//! every outbound message takes, and JS's `\b` (ASCII word characters) kept exactly.
// b (bytes), i (start), s/e (span), k (keyword at): the matchers read like the regexes they port
#![allow(clippy::many_single_char_names)]

/// What each pattern is called in a hit and in `[redacted: …]`.
pub const KINDS: [&str; 13] = [
    "a private key",
    "a GitHub token",
    "an Anthropic API key",
    "an OpenAI API key",
    "an AWS access key",
    "a Google API key",
    "a Slack token",
    "a Discord bot token",
    "a Stripe key",
    "an npm token",
    "a JSON Web Token",
    "a password in a URL",
    "a secret value",
];

type Matcher = fn(&[u8], usize) -> Option<usize>;

const MATCHERS: [Matcher; 13] =
    [private_key, github, anthropic, openai, aws, google, slack, discord, stripe, npm, jwt, url_password, secret_value];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretHit {
    /// 1-based
    pub line: usize,
    pub what: &'static str,
}

/// One hit per line at most: the first kind (in order) that matches anywhere on it.
pub fn scan(text: &str) -> Vec<SecretHit> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line).as_bytes();
        if let Some(k) = MATCHERS.iter().position(|m| find(line, 0, *m).is_some()) {
            out.push(SecretHit { line: i + 1, what: KINDS[k] });
        }
    }
    out
}

/// True when any pattern matches anywhere: the fast path for text with no secret in it.
pub fn any(text: &str) -> bool {
    let b = text.as_bytes();
    MATCHERS.iter().any(|m| find(b, 0, *m).is_some())
}

/// The text with every secret replaced by `[redacted: what it was]`, pattern after pattern as v1's
/// chain of global replaces does. → (text, hits)
pub fn redact(text: &str) -> (String, usize) {
    let mut out = text.to_owned();
    let mut hits = 0;
    for (k, m) in MATCHERS.iter().enumerate() {
        let b = out.as_bytes();
        let mut next = String::with_capacity(out.len());
        let (mut from, mut last) = (0, 0);
        while let Some((s, e)) = find(b, from, *m) {
            next.push_str(&out[last..s]);
            next.push_str("[redacted: ");
            next.push_str(KINDS[k]);
            next.push(']');
            hits += 1;
            last = e;
            from = e.max(s + 1);
        }
        if last > 0 {
            next.push_str(&out[last..]);
            out = next;
        }
    }
    (out, hits)
}

/// Leftmost match of `m` at or after `from`. Matchers only ever start on an ASCII byte, so the
/// returned range is on char boundaries.
fn find(b: &[u8], from: usize, m: Matcher) -> Option<(usize, usize)> {
    (from..b.len()).find_map(|i| m(b, i).map(|e| (i, e)))
}

// ---------- byte classes, as JS reads them without the `u` flag ----------

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
fn word_dash(c: u8) -> bool {
    word(c) || c == b'-'
}
fn alnum(c: u8) -> bool {
    c.is_ascii_alphanumeric()
}
/// `\b` at `i`: one side a word character, the other not (or the edge).
fn boundary(b: &[u8], i: usize) -> bool {
    let before = i > 0 && word(b[i - 1]);
    let after = i < b.len() && word(b[i]);
    before != after
}
fn starts(b: &[u8], i: usize, lit: &[u8]) -> bool {
    b.len() >= i + lit.len() && &b[i..i + lit.len()] == lit
}
fn starts_ci(b: &[u8], i: usize, lit: &[u8]) -> bool {
    b.len() >= i + lit.len() && b[i..i + lit.len()].eq_ignore_ascii_case(lit)
}
/// End of the run of `class` from `i`.
fn run(b: &[u8], i: usize, class: fn(u8) -> bool) -> usize {
    let mut j = i;
    while j < b.len() && class(b[j]) {
        j += 1;
    }
    j
}
/// `<prefix><class>{min,}` with `\b` before: the greedy end, or None.
fn prefixed(b: &[u8], i: usize, prefix: &[u8], class: fn(u8) -> bool, min: usize) -> Option<usize> {
    if !boundary(b, i) || !starts(b, i, prefix) {
        return None;
    }
    let s = i + prefix.len();
    let e = run(b, s, class);
    (e - s >= min).then_some(e)
}
/// `<class>{n}\b` exactly from `s`.
fn exact_then_boundary(b: &[u8], s: usize, class: fn(u8) -> bool, n: usize) -> Option<usize> {
    let e = s + n;
    (e <= b.len() && b[s..e].iter().all(|c| class(*c)) && boundary(b, e)).then_some(e)
}

// ---------- the patterns ----------

/// `-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----`
fn private_key(b: &[u8], i: usize) -> Option<usize> {
    key_marker(b, i, b"-----BEGIN ")
}

/// `<head>[A-Z ]*PRIVATE KEY( BLOCK)?-----`: a key's first line (`-----BEGIN `) or its last (`-----END `).
pub(crate) fn key_marker(b: &[u8], i: usize, head: &[u8]) -> Option<usize> {
    if !starts(b, i, head) {
        return None;
    }
    let s = i + head.len();
    let e = run(b, s, |c| c.is_ascii_uppercase() || c == b' ');
    // the run is greedy: try the latest `PRIVATE KEY` first, as the regex engine backtracks
    (s..=e).rev().find_map(|k| {
        if !starts(b, k, b"PRIVATE KEY") {
            return None;
        }
        let k = k + 11;
        if starts(b, k, b" BLOCK-----") { Some(k + 11) } else { starts(b, k, b"-----").then_some(k + 5) }
    })
}

/// `\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b`
fn github(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) {
        return None;
    }
    if starts(b, i, b"gh") && b.get(i + 2).is_some_and(|c| b"pousr".contains(c)) && b.get(i + 3) == Some(&b'_') {
        let e = run(b, i + 4, alnum);
        if e - (i + 4) >= 30 && boundary(b, e) {
            return Some(e);
        }
    }
    let e = prefixed(b, i, b"github_pat_", word, 40)?;
    boundary(b, e).then_some(e)
}

/// `\bsk-ant-[A-Za-z0-9_-]{20,}`
fn anthropic(b: &[u8], i: usize) -> Option<usize> {
    prefixed(b, i, b"sk-ant-", word_dash, 20)
}

/// `\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}`: the optional prefix is inside the class, so the
/// greedy end is the same either way and only the run's length decides.
fn openai(b: &[u8], i: usize) -> Option<usize> {
    prefixed(b, i, b"sk-", word_dash, 32)
}

/// `\b(AKIA|ASIA)[0-9A-Z]{16}\b`
fn aws(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !(starts(b, i, b"AKIA") || starts(b, i, b"ASIA")) {
        return None;
    }
    exact_then_boundary(b, i + 4, |c| c.is_ascii_digit() || c.is_ascii_uppercase(), 16)
}

/// `\bAIza[0-9A-Za-z_-]{35}\b`
fn google(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !starts(b, i, b"AIza") {
        return None;
    }
    exact_then_boundary(b, i + 4, word_dash, 35)
}

/// `\bxox[abposr]-[A-Za-z0-9-]{10,}`
fn slack(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !starts(b, i, b"xox") || !b.get(i + 3).is_some_and(|c| b"abposr".contains(c)) || b.get(i + 4) != Some(&b'-') {
        return None;
    }
    let e = run(b, i + 5, |c| alnum(c) || c == b'-');
    (e - (i + 5) >= 10).then_some(e)
}

/// `\b[MNO][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}`
fn discord(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !b.get(i).is_some_and(|c| b"MNO".contains(c)) {
        return None;
    }
    let e = run(b, i + 1, alnum);
    if e - (i + 1) < 23 || b.get(e) != Some(&b'.') {
        return None;
    }
    let mid = e + 1;
    if mid + 6 >= b.len() || !b[mid..mid + 6].iter().all(|c| word_dash(*c)) || b[mid + 6] != b'.' {
        return None;
    }
    let s = mid + 7;
    let end = run(b, s, word_dash);
    (end - s >= 27).then_some(end)
}

/// `\b[sr]k_live_[A-Za-z0-9]{20,}`
fn stripe(b: &[u8], i: usize) -> Option<usize> {
    if !b.get(i).is_some_and(|c| *c == b's' || *c == b'r') {
        return None;
    }
    if !boundary(b, i) || !starts(b, i + 1, b"k_live_") {
        return None;
    }
    let e = run(b, i + 8, alnum);
    (e - (i + 8) >= 20).then_some(e)
}

/// `\bnpm_[A-Za-z0-9]{36}\b`
fn npm(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !starts(b, i, b"npm_") {
        return None;
    }
    exact_then_boundary(b, i + 4, alnum, 36)
}

/// `\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`
fn jwt(b: &[u8], i: usize) -> Option<usize> {
    let e = prefixed(b, i, b"eyJ", word_dash, 10)?;
    if b.get(e) != Some(&b'.') || !starts(b, e + 1, b"eyJ") {
        return None;
    }
    let e2 = run(b, e + 4, word_dash);
    if e2 - (e + 4) < 10 || b.get(e2) != Some(&b'.') {
        return None;
    }
    let e3 = run(b, e2 + 1, word_dash);
    (e3 - (e2 + 1) >= 10).then_some(e3)
}

fn space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// `\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{4,}@`, case-insensitive
fn url_password(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) || !b.get(i).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    let e = run(b, i + 1, |c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'));
    if !starts(b, e, b"://") {
        return None;
    }
    let u = e + 3;
    let ue = run(b, u, |c| !space(c) && !matches!(c, b':' | b'/' | b'@'));
    if ue == u || b.get(ue) != Some(&b':') {
        return None;
    }
    let p = ue + 1;
    let pe = run(b, p, |c| !space(c) && !matches!(c, b'/' | b'@'));
    (pe - p >= 4 && b.get(pe) == Some(&b'@')).then_some(pe + 1)
}

const KEYWORDS: [&[u8]; 9] =
    [b"api_key", b"api-key", b"apikey", b"secret", b"token", b"password", b"passwd", b"private_key", b"private-key"];
const PLACEHOLDERS: [&[u8]; 6] = [b"xxx", b"***", b"your_", b"your-", b"example", b"placeholder"];

fn value_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'/' | b'+' | b'_' | b'.' | b'=' | b'-')
}

/// `\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!…)[A-Za-z0-9/+_.=-]{16,}`, case-insensitive
fn secret_value(b: &[u8], i: usize) -> Option<usize> {
    if !boundary(b, i) {
        return None;
    }
    let name_end = run(b, i, word_dash);
    // `[\w-]*` is greedy: the latest keyword start wins
    (i..=name_end).rev().find_map(|k| KEYWORDS.iter().filter(|kw| starts_ci(b, k, kw)).find_map(|kw| after_name(b, k + kw.len())))
}

fn after_name(b: &[u8], e: usize) -> Option<usize> {
    if !boundary(b, e) {
        return None;
    }
    let mut j = e;
    if matches!(b.get(j), Some(b'"' | b'\'')) {
        j += 1;
    }
    j = run(b, j, space);
    if !matches!(b.get(j), Some(b':' | b'=')) {
        return None;
    }
    j = run(b, j + 1, space);
    if matches!(b.get(j), Some(b'"' | b'\'')) {
        j += 1;
    }
    if placeholder(b, j) {
        return None;
    }
    let v = run(b, j, value_char);
    (v - j >= 16).then_some(v)
}

/// `(?!<|\$\{|\$[A-Z_]|xxx|\*\*\*|your[_-]|example|placeholder|changeme)`, case-insensitive
fn placeholder(b: &[u8], j: usize) -> bool {
    match b.get(j) {
        Some(b'<') => true,
        Some(b'$') => b.get(j + 1).is_some_and(|c| *c == b'{' || *c == b'_' || c.is_ascii_alphabetic()),
        _ => PLACEHOLDERS.iter().any(|p| starts_ci(b, j, p)) || starts_ci(b, j, b"changeme"),
    }
}
