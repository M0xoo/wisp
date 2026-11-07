//! Paths in messages and stacks would leak usernames and project names (v1 server/telemetry.js, unchanged):
//! wisp's own files keep their package-relative path (`<wisp>/…`), the home folder becomes `~`, and any
//! other absolute path is cut down to its file name (`…/a.ts`). This is v1's regex
//! `(?<![\w<>~.:/\\-])(?:~|[A-Za-z]:)?[/\\](?:[^\s'"`():/\\]+[/\\])+([^\s'"`():/\\]*)` → `…/$1`, written
//! out as a scanner (no regex crate), then cut to 500 UTF-16 units.

use serde_json::{Value, json};

use crate::text::slice_utf16;

#[derive(Debug, Clone, Default)]
pub struct ScrubOptions {
    /// the user's home folder
    pub home: String,
    /// wisp's own install or source folder
    pub root: String,
}

fn slash(c: char) -> bool {
    c == '/' || c == '\\'
}

/// A character of a path segment: not whitespace, a quote, a backtick, a parenthesis, a colon or a slash.
fn seg(c: char) -> bool {
    !(c.is_whitespace() || c == '\u{feff}' || matches!(c, '\'' | '"' | '`' | '(' | ')' | ':' | '/' | '\\'))
}

/// The lookbehind `[\w<>~.:/\\-]` (JS `\w` is ASCII).
fn glued(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '<' | '>' | '~' | '.' | ':' | '/' | '\\' | '-')
}

/// From a slash at `j`: at least one `segment/`, then the base name. Returns (end, where the base starts).
fn path_from(cs: &[char], j: usize) -> Option<(usize, usize)> {
    if !cs.get(j).copied().is_some_and(slash) {
        return None;
    }
    let (mut k, mut base, mut dirs) = (j + 1, j + 1, 0);
    loop {
        let s = k;
        while k < cs.len() && seg(cs[k]) {
            k += 1;
        }
        if k > s && k < cs.len() && slash(cs[k]) {
            k += 1;
            dirs += 1;
            base = k;
        } else {
            break;
        }
    }
    (dirs > 0).then_some((k, base))
}

fn match_at(cs: &[char], i: usize) -> Option<(usize, usize)> {
    if i > 0 && glued(cs[i - 1]) {
        return None;
    }
    let prefixed = match cs[i] {
        '~' => Some(i + 1),
        c if c.is_ascii_alphabetic() && cs.get(i + 1) == Some(&':') => Some(i + 2),
        _ => None,
    };
    prefixed.and_then(|j| path_from(cs, j)).or_else(|| path_from(cs, i))
}

/// Cuts every absolute path outside wisp down to its file name.
fn cut_paths(s: &str) -> String {
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        if let Some((end, base)) = match_at(&cs, i) {
            out.push_str("…/");
            out.extend(&cs[base..end]);
            i = end;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

pub fn scrub(text: &str, o: &ScrubOptions) -> String {
    let mut s = text.to_owned();
    if !o.root.is_empty() {
        s = s.replace(&o.root, "<wisp>");
    }
    if !o.home.is_empty() {
        s = s.replace(&o.home, "~");
    }
    slice_utf16(&cut_paths(&s), 500).to_owned()
}

/// `at fn (file:line:col)` or `at file:line:col` (v1's frame regex): (function, file, line, col).
fn js_frame(line: &str) -> Option<(Option<&str>, &str, u32, u32)> {
    let rest = line.strip_prefix("at ")?;
    let mut from = 0;
    while let Some(k) = rest[from..].find(" (").map(|k| k + from) {
        if k > 0
            && let Some((file, line, col)) = location(&rest[k + 2..])
        {
            return Some((Some(&rest[..k]), file, line, col));
        }
        from = k + 1;
    }
    location(rest).map(|(file, l, c)| (None, file, l, c))
}

/// `file:line:col` with v1's optional closing parenthesis.
fn location(loc: &str) -> Option<(&str, u32, u32)> {
    loc.strip_suffix(')').and_then(file_line_col).or_else(|| file_line_col(loc))
}

/// `file:line:col` with a non-empty file and all-digit line and col.
fn file_line_col(loc: &str) -> Option<(&str, u32, u32)> {
    let (rest, col) = loc.rsplit_once(':')?;
    let (file, line) = rest.rsplit_once(':')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if file.is_empty() || !digits(line) || !digits(col) {
        return None;
    }
    Some((file, line.parse().unwrap_or(u32::MAX), col.parse().unwrap_or(u32::MAX)))
}

/// A stack as `PostHog`'s raw frames, innermost last. `JavaScript` stacks (the page, v1) as v1 sent them;
/// Rust backtraces (`N: function` / `at file:line:col`) the same way, `lang: "rust"`.
pub fn frames(stack: &str, o: &ScrubOptions) -> Vec<Value> {
    let lines: Vec<&str> = stack.split('\n').collect();
    let mut out: Vec<Value> = Vec::new();
    for line in lines.iter().skip(1).take(29) {
        if let Some((func, file, l, c)) = js_frame(line.trim()) {
            let in_app = !o.root.is_empty() && file.contains(&o.root) && !file.contains("node_modules");
            let file = file.strip_prefix("file://").unwrap_or(file);
            out.push(json!({ "platform": "custom", "lang": "javascript", "function": func.unwrap_or("?"), "filename": scrub(file, o), "lineno": l, "colno": c, "in_app": in_app }));
        }
    }
    if out.is_empty() {
        out = rust_frames(&lines, o);
    }
    out.reverse();
    out
}

fn rust_frames(lines: &[&str], o: &ScrubOptions) -> Vec<Value> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() && out.len() < 29 {
        let t = lines[i].trim();
        let func = t.split_once(": ").filter(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).map(|(_, f)| f);
        i += 1;
        let Some(func) = func else { continue };
        let loc = lines.get(i).and_then(|l| l.trim().strip_prefix("at ")).and_then(file_line_col);
        if loc.is_some() {
            i += 1;
        }
        let (file, lineno, colno) = loc.unwrap_or(("?", 0, 0));
        out.push(json!({ "platform": "custom", "lang": "rust", "function": func, "filename": scrub(file, o), "lineno": lineno, "colno": colno, "in_app": func.starts_with("wisp") }));
    }
    out
}
