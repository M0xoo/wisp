//! .env masking (v1 `server/env-mask.js`, ADR-0050): what a task shows of a `.env` / `.env.*` file leaves the
//! server as `KEY=••••`: a step's output when it read one, an edit to one, a code or diff answer block about one,
//! a unified diff's lines of one. The store keeps the real text (rollback, revert and the agent need it); Reveal
//! asks for one item as it is. Pure: no IO, no clock, no state. Every rule here is shared by wisp.git (Changes)
//! and wisp.runtime (turns and their events), so both mask alike.
//!
//! One fix over v1: a CRLF file's line (`K=v\r`) kept its value in v1 (JavaScript's `.` stops at `\r`); here the
//! value goes and the `\r` stays.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

pub const DOTS: &str = "••••";
/// What a changed line that masks like the line it replaced says, so a diff still has a line to show.
pub const CHANGED: &str = " (changed)";

// KEY=value, export KEY=value, KEY: value. The value goes (quotes and all), a trailing comment too. Any other line
// but a comment or a blank one goes whole: an edit's snippet can be a bare value, a command's output anything.
#[allow(clippy::expect_used)] // a literal pattern, checked by every test
static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)(\S.*)$").expect("LINE"));
#[allow(clippy::expect_used)]
static KEPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(#.*|(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)?$").expect("KEPT"));
#[allow(clippy::expect_used)]
static HUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@").expect("HUNK"));

/// `.env`, `.env.local`, `.env.production`…; not the templates people commit (`.env.example`, `.env.sample`).
pub fn is_env_file(path: &str) -> bool {
    let p = path.replace('\\', "/");
    let base = p.rsplit('/').next().unwrap_or(&p);
    let Some(rest) = base.strip_prefix(".env") else {
        return false;
    };
    let shape = rest.is_empty() || (rest.len() > 1 && rest.starts_with('.') && rest[1..].chars().all(word_char));
    let low = base.to_ascii_lowercase();
    shape && !low.ends_with(".example") && !low.ends_with(".sample")
}

/// JavaScript's `[\w.-]`.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// One line of a .env file with its value masked; blanks, comments and `KEY=` with no value stay.
pub fn mask_line(line: &str) -> String {
    // a CRLF file: the value goes, the line ending stays (v1 kept the whole line)
    if let Some(body) = line.strip_suffix('\r') {
        return format!("{}\r", mask_line(body));
    }
    if KEPT.is_match(line) {
        return line.to_owned();
    }
    if let Some(m) = LINE.captures(line).and_then(|c| c.get(1)) {
        return format!("{}{DOTS}", m.as_str());
    }
    let lead = line.len() - line.trim_start().len();
    format!("{}{DOTS}", &line[..lead])
}

/// Every line of a .env file's text masked.
pub fn mask_text(text: &str) -> String {
    text.split('\n').map(mask_line).collect::<Vec<_>>().join("\n")
}

/// One edit's before/after masked on both sides. A line it changed that masks the same as a line it replaced says
/// ` (changed)`, so the diff still has a line to show.
pub fn mask_edit(before: &str, after: &str) -> (String, String) {
    let was: Vec<&str> = before.split('\n').collect();
    let raw: HashSet<&str> = was.iter().copied().collect();
    let masked: HashSet<String> = was.iter().map(|l| mask_line(l)).collect();
    let after = after
        .split('\n')
        .map(|l| {
            let m = mask_line(l);
            if m != l && !raw.contains(l) && masked.contains(&m) { format!("{m}{CHANGED}") } else { m }
        })
        .collect::<Vec<_>>()
        .join("\n");
    (mask_text(before), after)
}

/// The .env files a command line names (`cat .env`, `head -5 apps/web/.env.local`, `Get-Content '.env'`), in
/// order. A name starts the line or follows a space, quote, `=`, bracket, pipe, `;`, `&` or a path separator, and
/// ends the line or meets a space, quote, `)`, `|`, `;`, `&` or `>`.
fn env_words(cmd: &str) -> impl Iterator<Item = &str> {
    let starts = |c: char| c.is_whitespace() || "'\"`=(<>|;&/\\".contains(c);
    let ends = |c: char| c.is_whitespace() || "'\"`)|;&>".contains(c);
    cmd.match_indices(".env").filter_map(move |(at, _)| {
        if at > 0 && !cmd[..at].chars().next_back().is_some_and(starts) {
            return None;
        }
        let rest = &cmd[at + 4..];
        let tail = if rest.starts_with('.') { rest.find(|c: char| !word_char(c)).unwrap_or(rest.len()) } else { 0 };
        let next = rest[tail..].chars().next();
        (tail != 1 && next.is_none_or(ends)).then(|| &cmd[at..at + 4 + tail])
    })
}

/// A command line names a .env file (not a template).
pub fn names_env_file(cmd: &str) -> bool {
    env_files_named(cmd).next().is_some()
}

/// The first .env file a command names (`cat apps/web/.env.local` → `.env.local`).
pub fn env_file_named(cmd: &str) -> Option<&str> {
    env_files_named(cmd).next()
}

fn env_files_named(cmd: &str) -> impl Iterator<Item = &str> {
    env_words(cmd).filter(|w| is_env_file(w))
}

/// A step whose output is a .env file's text: it read one, or its command (detail) or label names one.
pub fn reads_env_file(file: Option<&str>, detail: Option<&str>, label: Option<&str>) -> bool {
    file.is_some_and(is_env_file) || detail.is_some_and(names_env_file) || label.is_some_and(names_env_file)
}

fn head_path(rest: &str) -> Option<String> {
    let p = rest.split('\t').next().unwrap_or("").trim();
    (p != "/dev/null").then(|| p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p).to_owned())
}

/// A unified diff with a .env file's +/− lines masked; its headers and every other file's lines as they are. The
/// file comes from `diff --git`, `--- ` or `+++ ` (`/dev/null` for an added or deleted one); `whole`: a diff that
/// names no file is the .env file's. Hunks are walked by their counts, so a changed line that reads like a header
/// (`---token=x`) is still masked.
pub fn mask_diffs(text: &str, whole: bool) -> String {
    let (mut env, mut old, mut neu) = (whole, 0_i64, 0_i64);
    let mut out = Vec::new();
    for l in text.split('\n') {
        out.push(diff_line(l, whole, &mut env, &mut old, &mut neu));
    }
    out.join("\n")
}

fn diff_line(l: &str, whole: bool, env: &mut bool, old: &mut i64, neu: &mut i64) -> String {
    let c = l.chars().next().unwrap_or(' ');
    if *old > 0 || *neu > 0 {
        if matches!(c, ' ' | '-' | '+' | '\\') {
            if c != '+' && c != '\\' {
                *old -= 1;
            }
            if c != '-' && c != '\\' {
                *neu -= 1;
            }
            return if *env && matches!(c, '+' | '-') { format!("{c}{}", mask_line(&l[1..])) } else { l.to_owned() };
        }
        (*old, *neu) = (0, 0);
    }
    // a bare snippet with no hunk header (`-K=old` / `+K=new`): every changed line is the file's
    if whole && matches!(c, '+' | '-') {
        return format!("{c}{}", mask_line(&l[1..]));
    }
    if let Some(h) = HUNK.captures(l) {
        let n = |i: usize| h.get(i).map_or(1, |m| m.as_str().parse().unwrap_or(0));
        (*old, *neu) = (n(1), n(2));
        return l.to_owned();
    }
    if let Some(rest) = l.strip_prefix("diff --git a/") {
        *env = rest.rsplit_once(" b/").is_some_and(|(_, b)| is_env_file(b));
    } else if let Some(rest) = l.strip_prefix("--- ") {
        *env = head_path(rest).is_some_and(|p| is_env_file(&p));
    } else if let Some(rest) = l.strip_prefix("+++ ")
        && let Some(p) = head_path(rest)
    {
        *env = is_env_file(&p);
    }
    l.to_owned()
}

/// A `diff` block's `diff` text names its file (a header) or is a bare snippet of the block's file.
fn names_a_file(diff: &str) -> bool {
    diff.lines().any(|l| l.starts_with("diff --git ") || l.starts_with("--- ") || l.starts_with("+++ "))
}

/// The file an answer block is about (`file`, or `path`).
pub fn block_file(b: &Value) -> Option<&str> {
    b.get("file").or_else(|| b.get("path")).and_then(Value::as_str)
}

/// A `code` or `diff` answer block about a .env file, masked; `None` when there's nothing to hide.
pub fn mask_block(b: &Value) -> Option<Value> {
    if !block_file(b).is_some_and(is_env_file) {
        return None;
    }
    let mut out = b.clone();
    match b.get("type").and_then(Value::as_str)? {
        "code" => {
            let code = b.get("code")?.as_str()?;
            out["code"] = Value::String(mask_text(code));
        }
        "diff" => {
            let (before, after) = (b.get("before"), b.get("after"));
            let diff = b.get("diff").and_then(Value::as_str);
            if before.is_none() && after.is_none() && diff.is_none() {
                return None;
            }
            if before.is_some() || after.is_some() {
                let s = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_owned);
                let (mb, ma) = mask_edit(&s(before).unwrap_or_default(), &s(after).unwrap_or_default());
                if before.is_some_and(Value::is_string) {
                    out["before"] = Value::String(mb);
                }
                if after.is_some_and(Value::is_string) {
                    out["after"] = Value::String(ma);
                }
            }
            if let Some(d) = diff {
                out["diff"] = Value::String(mask_diffs(d, !names_a_file(d)));
            }
        }
        _ => return None,
    }
    Some(out)
}

/// `git.maskEnvFiles` (Settings → Privacy, "Hide .env values"): on unless switched off (`false`, or v1's `'off'`).
pub fn mask_on(v: Option<&Value>) -> bool {
    !matches!(v, Some(Value::Bool(false))) && v.and_then(Value::as_str) != Some("off")
}

/// The setting's key (wisp.git declares it; every plugin that masks reads it).
pub const SETTING: &str = "git.maskEnvFiles";

// Free text an agent wrote (its thinking, a tool's error): where it quotes a .env value. Not v1's (v1 left both as
// they were, a leak): a value of a .env file the turn read, wherever it shows, and any line that is a .env line
// itself (`API_KEY=sk-…`, alone on its line, maybe a list item or in backticks).

/// A value this short, or one of these words, is no secret and shows in any text: never hidden by itself.
const MIN_VALUE: usize = 6;
const PLAIN: &[&str] = &["true", "false", "null", "none", "yes", "off"];

#[allow(clippy::expect_used)] // a literal pattern, checked by every test
static SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:[-*>]\s+)?`*(?:export\s+)?[A-Z_][A-Z0-9_]*=([^\s`][^`]*?)`*\s*$").expect("SHAPE"));

/// The values of a .env file's text (`K=v`, `export K="v"`, `K: v`): each as written and without its quotes, the
/// short and plain ones left out. A quoted value that runs over several lines (a PEM key in quotes) gives each of its
/// lines and the whole. What the turn machine keeps (in memory only) of a .env file a call read.
pub fn env_values(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |x: &str| {
        if x.chars().count() >= MIN_VALUE && !PLAIN.contains(&x.to_ascii_lowercase().as_str()) && !out.iter().any(|o| o == x) {
            out.push(x.to_owned());
        }
    };
    // a quoted value that runs on past its line (a PEM key in quotes): its quote and the lines read so far
    let mut open: Option<(char, Vec<String>)> = None;
    for l in text.split('\n').map(|l| l.trim_end_matches('\r')) {
        if let Some((q, lines)) = open.as_mut() {
            // every line of it is a value of its own (each shows alone in a later text), and so is the whole
            let (piece, closed) = l.split_once(*q).map_or((l, false), |(p, _)| (p, true));
            push(piece.trim());
            lines.push(piece.to_owned());
            if closed {
                push(&lines.join("\n"));
                open = None;
            }
            // a quote never closed swallows what follows: its `K=v` lines still count as lines (fail closed)
            if let Some(v) = LINE.captures(l).and_then(|c| c.get(2)) {
                let v = v.as_str().trim();
                push(v);
                push(v.trim_matches(|c| c == '"' || c == '\''));
            }
            continue;
        }
        let Some(v) = LINE.captures(l).and_then(|c| c.get(2)) else { continue };
        let v = v.as_str().trim();
        // `"sec ret" # c` → `sec ret`; `abc123 # prod` → `abc123`
        let bare = match v.chars().next() {
            Some(q @ ('"' | '\'')) => {
                let rest = &v[1..];
                if !rest.contains(q) {
                    open = Some((q, vec![rest.to_owned()]));
                }
                rest.split(q).next().unwrap_or_default()
            }
            _ => v.split(" #").next().unwrap_or(v).trim_end(),
        };
        push(v);
        push(bare);
    }
    // never closed: what it ran on to is all its value (fail closed), and each line already counts
    if let Some((_, lines)) = open {
        push(&lines.join("\n"));
    }
    out
}

/// Byte ranges `[start, end)` of `text` to hide: every place it quotes one of `values`, and the value of each line
/// shaped like a .env line. Sorted, merged, on char boundaries.
pub fn quote_spans(text: &str, values: &[String]) -> Vec<[u32; 2]> {
    let mut spans = value_hits(text, values);
    let mut at = 0;
    for l in text.split('\n') {
        if let Some(m) = SHAPE.captures(l).and_then(|c| c.get(1)) {
            spans.push((at + m.start(), at + m.end()));
        }
        at += l.len() + 1;
    }
    merged(spans)
}

/// Byte ranges of `text` that quote one of `values`, and nothing else: for a tool call's command line, label or
/// output, where `NODE_ENV=test npm test` or a build's `VERSION=1.2` is no secret. Sorted, merged.
pub fn value_spans(text: &str, values: &[String]) -> Vec<[u32; 2]> {
    let mut spans = value_hits(text, values);
    spans.extend(cut_hits(text, values));
    merged(spans)
}

/// Where a value was cut (a label clipped to its first characters, an output to its head and tail): the part of it
/// that ends the text or meets a `…`, and the part that starts the text or follows one, `MIN_VALUE` characters or more.
fn cut_hits(text: &str, values: &[String]) -> Vec<(usize, usize)> {
    let mut ends = vec![text.len()];
    let mut starts = vec![0];
    for (at, m) in text.match_indices('…') {
        ends.push(text[..at].trim_end().len());
        starts.push(at + m.len());
    }
    let mut out = Vec::new();
    for v in values {
        // `at[j]`: where the value's j-th character starts; a part is `MIN_VALUE` characters or more, never all of it
        let at: Vec<usize> = v.char_indices().map(|(i, _)| i).collect();
        let Some(last) = at.len().checked_sub(MIN_VALUE).filter(|&l| l >= 1) else { continue };
        for &e in &ends {
            // the longest start of the value that ends here
            if let Some(&k) = at[MIN_VALUE..].iter().rev().find(|&&k| text[..e].ends_with(&v[..k])) {
                out.push((e - k, e));
            }
        }
        for &b in &starts {
            let from = b + (text[b..].len() - text[b..].trim_start().len());
            // the longest end of the value that starts here
            if let Some(&i) = at[1..=last].iter().find(|&&i| text[from..].starts_with(&v[i..])) {
                out.push((from, from + v.len() - i));
            }
        }
    }
    out
}

fn value_hits(text: &str, values: &[String]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for v in values.iter().filter(|v| !v.is_empty()) {
        spans.extend(text.match_indices(v.as_str()).map(|(at, m)| (at, at + m.len())));
    }
    spans
}

/// Byte ranges of `text` that `mask_text` would hide: a whole error text from a call that read a .env file.
pub fn text_spans(text: &str) -> Vec<[u32; 2]> {
    let mut spans = Vec::new();
    let mut at = 0;
    for l in text.split('\n') {
        let body = l.strip_suffix('\r').unwrap_or(l);
        if !KEPT.is_match(body) {
            let from = LINE.captures(body).and_then(|c| c.get(1)).map_or(body.len() - body.trim_start().len(), |m| m.end());
            spans.push((at + from, at + body.len()));
        }
        at += l.len() + 1;
    }
    merged(spans)
}

fn merged(mut spans: Vec<(usize, usize)>) -> Vec<[u32; 2]> {
    spans.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (a, b) in spans.into_iter().filter(|(a, b)| a < b) {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out.into_iter().filter_map(|(a, b)| Some([u32::try_from(a).ok()?, u32::try_from(b).ok()?])).collect()
}

/// `text` with each of `spans` (from `quote_spans` / `text_spans`) as `••••`. Spans that don't fit the text (out of
/// order, past its end, inside a character: a text changed since) hide the whole text: fail closed.
pub fn mask_spans(text: &str, spans: &[[u32; 2]]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    for &[a, b] in spans {
        let (a, b) = (a as usize, b as usize);
        if a < from || b <= a || b > text.len() || !text.is_char_boundary(a) || !text.is_char_boundary(b) {
            return DOTS.to_owned();
        }
        out.push_str(&text[from..a]);
        out.push_str(DOTS);
        from = b;
    }
    out.push_str(&text[from..]);
    out
}
