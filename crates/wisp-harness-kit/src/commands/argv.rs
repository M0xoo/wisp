//! The shared vocabulary of the command describer: what a stage's description looks like, and the argv
//! helpers every per-command table reads its flags and operands with (v1 `commands.js` "argv helpers").

use crate::js;
use crate::paths::{RunPaths, rel};
use crate::text::clip;

/// One stage's sentence. `weak` ones (`cd x`, `echo ---`) only count when nothing better was found;
/// `unknown` ones are the raw command echoed back, which the caller may replace with its fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Desc {
    pub text: String,
    pub weak: bool,
    pub unknown: bool,
}

impl Desc {
    pub fn strong(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            weak: false,
            unknown: false,
        }
    }
    pub fn weak(text: impl Into<String>) -> Self {
        Self {
            weak: true,
            ..Self::strong(text)
        }
    }
    pub fn unknown(text: impl Into<String>) -> Self {
        Self {
            unknown: true,
            ..Self::strong(text)
        }
    }
}

/// A table's answer: `None` when the command is not one of its own, else what it says (v1's `null`
/// for "nothing to say", e.g. a bare `cat` that isn't piped).
pub(super) type Known = Option<Option<Desc>>;

pub(super) fn say(text: impl Into<String>) -> Known {
    Some(Some(Desc::strong(text)))
}
pub(super) fn say_weak(text: impl Into<String>) -> Known {
    Some(Some(Desc::weak(text)))
}
pub(super) const fn silent() -> Known {
    Some(None)
}

/// What a per-command describer gets: one stage, already peeled, with its paths.
#[derive(Debug)]
pub(super) struct Ctx<'a> {
    /// The command's base name (`/usr/bin/git` → `git`).
    pub cmd: &'a str,
    pub argv: &'a [String],
    pub args: &'a [String],
    /// The file a `<` redirect reads (v1 tested it for truthiness, so `''` counts as none).
    pub input: Option<&'a str>,
    pub paths: &'a RunPaths,
    /// Whether the stage is one of several in a pipe, where filters say less than producers.
    pub piped: bool,
    /// The stage's operands.
    pub files: Vec<&'a str>,
}

impl Ctx<'_> {
    /// A path as the ticker shows it.
    pub fn f(&self, p: &str) -> String {
        short(p, self.paths)
    }
    /// The first two operands shown as paths, then `+N` (v1's `target`).
    pub fn target(&self) -> String {
        listed(&self.files, self.paths)
    }
    pub fn arg(&self, i: usize) -> Option<&str> {
        self.args.get(i).map(String::as_str)
    }
    pub fn has(&self, flag: &str) -> bool {
        self.args.iter().any(|a| a == flag)
    }
}

/// `path.basename` (POSIX): the last segment, trailing slashes ignored.
pub(super) fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    t.rfind('/').map_or(t, |i| &t[i + 1..])
}

/// `/^-[nABCmdeoItLX]$/`: the short options whose value is the next word.
fn takes_value(a: &str) -> bool {
    matches!(
        a.as_bytes(),
        [b'-', b'n' | b'A' | b'B' | b'C' | b'm' | b'd' | b'e' | b'o' | b'I' | b't' | b'L' | b'X']
    )
}

/// Arguments that aren't flags, skipping the value of `-n 20`-style options.
pub(super) fn operands<S: AsRef<str>>(args: &[S]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_ref();
        if a == "--" {
            out.extend(args[i + 1..].iter().map(AsRef::as_ref));
            break;
        }
        if a.starts_with('-') {
            if takes_value(a) && args.get(i + 1).is_some_and(|n| !n.as_ref().starts_with('-')) {
                i += 1;
            }
        } else {
            out.push(a);
        }
        i += 1;
    }
    out
}

/// Drop leading flags (and --flag=value) so the subcommand comes first.
pub(super) fn strip_flags<S: AsRef<str>>(args: &[S]) -> &[S] {
    let n = args.iter().take_while(|a| a.as_ref().starts_with('-')).count();
    &args[n..]
}

/// The value after the first of `names` (`-m msg`, `--message=msg`); `None` when it has none.
pub(super) fn value_of<'a>(args: &'a [String], names: &[&str]) -> Option<&'a str> {
    for (i, a) in args.iter().enumerate() {
        if names.contains(&a.as_str()) {
            return args.get(i + 1).map(String::as_str);
        }
        for n in names.iter().filter(|n| n.starts_with("--")) {
            if let Some(v) = a.strip_prefix(n).and_then(|r| r.strip_prefix('=')) {
                return Some(v);
            }
        }
    }
    None
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `head -n 20`, `head -20`, `head -n20`, `--lines=20`.
pub(super) fn count_arg(args: &[String]) -> Option<&str> {
    for (i, a) in args.iter().enumerate() {
        let next = args.get(i + 1).map_or("", String::as_str);
        if (a == "-n" || a == "-c") && all_digits(next.strip_prefix('+').unwrap_or(next)) {
            return Some(next.strip_prefix('+').unwrap_or(next));
        }
        let n = a
            .strip_prefix("-n")
            .filter(|d| all_digits(d))
            .or_else(|| a.strip_prefix('-').filter(|d| all_digits(d)))
            .or_else(|| a.strip_prefix("--lines=").filter(|d| all_digits(d)));
        if n.is_some() {
            return n;
        }
    }
    None
}

/// Paths relative to the project, and long ones shortened to their tail. An empty cwd means "don't
/// relativise" (v1 called this without one for `python -m <tool>`, and with none at all when the run
/// had no cwd). v1 also turned `\` back into `/` when the input had none: only `path.relative` on
/// Windows could add one, so on POSIX that is a no-op and is left out.
pub(super) fn short(p: &str, paths: &RunPaths) -> String {
    if p.is_empty() {
        return String::new();
    }
    let s = if paths.cwd.is_empty() {
        p.to_owned()
    } else {
        rel(p, paths)
    };
    if js::len16(&s) <= 48 {
        return s;
    }
    let parts: Vec<&str> = s.split(['\\', '/']).filter(|x| !x.is_empty()).collect();
    if parts.len() > 2 {
        format!("…/{}", parts[parts.len() - 2..].join("/"))
    } else {
        clip(&s, 48)
    }
}

/// Up to two paths, then `+N` for the rest: `a.js, b.js +3`.
pub(super) fn listed(files: &[&str], paths: &RunPaths) -> String {
    let mut out = shown(files, paths);
    if files.len() > 2 {
        out.push_str(&format!(" +{}", files.len() - 2));
    }
    out
}

/// The first two paths, comma separated (v1 `files.map(f).slice(0, 2).join(', ')`).
pub(super) fn shown(files: &[&str], paths: &RunPaths) -> String {
    files
        .iter()
        .take(2)
        .map(|p| short(p, paths))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `s || fallback`
pub(super) fn or<'a>(s: &'a str, fallback: &'a str) -> &'a str {
    if s.is_empty() { fallback } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn operands_skip_flag_values() {
        assert_eq!(operands(&v(&["-n", "20", "a.js", "--", "-x"])), ["a.js", "-x"]);
        assert_eq!(operands(&v(&["-n", "-v", "a"])), ["a"]);
    }

    #[test]
    fn counts() {
        assert_eq!(count_arg(&v(&["-n", "+3"])), Some("3"));
        assert_eq!(count_arg(&v(&["-n20"])), Some("20"));
        assert_eq!(count_arg(&v(&["-20"])), Some("20"));
        assert_eq!(count_arg(&v(&["--lines=5"])), Some("5"));
        assert_eq!(count_arg(&v(&["-n"])), None);
    }

    #[test]
    fn basenames() {
        assert_eq!(basename("/usr/bin/git"), "git");
        assert_eq!(basename("a/"), "a");
        assert_eq!(basename("/"), "");
        assert_eq!(basename(""), "");
    }
}
