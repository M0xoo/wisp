//! One-click setup for people with no harness yet (v1 server/services/install.js). opencode is the one wisp
//! installs: its free models work without an account, so a fresh computer can run a task right away. It
//! goes into wisp's own folder (`~/.wisp/tools`) through npm, which every wisp install already has: no
//! sudo, no shell profile edits, the same on Windows. The opencode harness finds it there.

/// A harness wisp can install: its id, npm package and display name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Installable {
    pub id: &'static str,
    pub pkg: &'static str,
    pub name: &'static str,
}

pub const INSTALLABLE: &[Installable] = &[Installable { id: "opencode", pkg: "opencode-ai", name: "opencode" }];
pub const NPM_TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// npm's output kept for the error message
pub const OUTPUT_TAIL: usize = 4000;

pub fn installable(id: &str) -> Option<&'static Installable> {
    INSTALLABLE.iter().find(|i| i.id == id)
}

/// The refusal for anything else (400).
pub fn not_installable(id: &str) -> String {
    format!("wisp can’t install {id}. Install it yourself, then re-check.")
}

/// `npm install --prefix <dir> --no-audit --no-fund --loglevel=error <pkg>@latest`
pub fn npm_args(pkg: &str, dir: &str) -> Vec<String> {
    ["install", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel=error"]
        .iter()
        .map(|s| (*s).to_owned())
        .chain([format!("{pkg}@latest")])
        .collect()
}

/// npm couldn't be started at all (424: offline or a broken npm isn't a wisp bug).
pub fn npm_missing() -> String {
    "npm isn’t on PATH, so wisp can’t install it. Install Node.js (it comes with npm), then try again.".into()
}

/// npm ran and failed, or ran out of time (424), with the tail of its own words.
pub fn npm_failed(pkg: &str, timed_out: bool, output: &str) -> String {
    let lines: Vec<&str> = output.trim().lines().filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    let what = if timed_out { "timed out" } else { "failed" };
    if tail.is_empty() { format!("npm install {pkg} {what}") } else { format!("npm install {pkg} {what}: {tail}") }
}

/// Installed, but detection still can't start it (500).
pub fn installed_but_broken(name: &str, error: Option<&str>) -> String {
    format!("{name} was installed but doesn’t start: {}", error.unwrap_or("unknown error"))
}

/// Keeps the last `max` bytes of `s` on a char boundary (npm's output tail).
pub fn tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut i = s.len() - max;
    while !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
}
