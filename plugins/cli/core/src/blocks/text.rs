//! The text-shaped blocks: hero, steps, checklist, stats, tests, code, terminal, callout, question,
//! blocked, actions, next.

use serde_json::Value;
use wisp_cli_api::Style;

use super::{caption, items, s, text_of, title};
use crate::term::{self, BLUE, BOLD, DIM, GREEN, RED, YELLOW, paint};

pub fn hero(b: &Value, st: &Style) -> Vec<String> {
    let (mark, color) = match s(b, "status") {
        "done" => ("✓", GREEN),
        "partial" => ("◐", YELLOW),
        "blocked" => ("✗", RED),
        _ => ("●", BLUE),
    };
    let head = format!("{} {}", paint(st, color, mark), paint(st, BOLD, s(b, "title")));
    let mut out = term::wrap(&head, st.width);
    let sum = s(b, "summary");
    if !sum.is_empty() {
        out.extend(term::hang("  ", &crate::md::inline(st, sum), st.width));
    }
    out
}

fn mark(st: &Style, status: &str) -> String {
    match status {
        "done" | "pass" | "passed" | "ok" => paint(st, GREEN, "✓"),
        "failed" | "fail" | "error" => paint(st, RED, "✗"),
        "skipped" | "skip" => paint(st, DIM, "–"),
        "pending" | "running" => paint(st, YELLOW, "◌"),
        _ => paint(st, DIM, "·"),
    }
}

pub fn steps(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    for i in items(b) {
        out.extend(term::hang(&format!("{} ", mark(st, s(i, "status"))), s(i, "title"), st.width));
        let d = s(i, "detail");
        if !d.is_empty() {
            out.extend(term::wrap(d, st.width.saturating_sub(2)).into_iter().map(|l| format!("  {}", paint(st, DIM, &l))));
        }
    }
    out
}

pub fn checklist(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    for i in items(b) {
        let done = i.get("done").and_then(Value::as_bool) == Some(true);
        let m = if done { paint(st, GREEN, "✓") } else { paint(st, DIM, "☐") };
        let t = if done { s(i, "text").to_owned() } else { paint(st, DIM, s(i, "text")) };
        out.extend(term::hang(&format!("{m} "), &t, st.width));
    }
    out
}

pub fn stats(b: &Value, st: &Style) -> Vec<String> {
    let rows: Vec<(String, String, String, &str)> = items(b)
        .iter()
        .map(|i| {
            let value = format!("{}{}", text_of(i.get("value")), s(i, "unit"));
            (s(i, "label").to_owned(), value, s(i, "delta").to_owned(), s(i, "tone"))
        })
        .collect();
    let vw = rows.iter().map(|r| term::width(&r.1)).max().unwrap_or(0);
    let lw = rows.iter().map(|r| term::width(&r.0)).max().unwrap_or(0).min(st.width.saturating_sub(vw + 10).max(8));
    rows.iter()
        .map(|(label, value, delta, tone)| {
            let color = match *tone {
                "good" => GREEN,
                "bad" => RED,
                _ => DIM,
            };
            let d = if delta.is_empty() { String::new() } else { format!("  {}", paint(st, color, delta)) };
            let line = format!("{}  {}{d}", term::pad(&term::truncate(label, lw), lw), paint(st, BOLD, &term::pad_left(value, vw)));
            if term::width(&line) > st.width { term::truncate(&format!("{label} {value} {delta}"), st.width) } else { line }
        })
        .collect()
}

fn secs(ms: f64) -> String {
    if ms >= 1000.0 { format!("{:.1}s", ms / 1000.0) } else { format!("{ms:.0}ms") }
}

pub fn tests(b: &Value, st: &Style) -> Vec<String> {
    let n = |k: &str| b.get(k).and_then(Value::as_u64).unwrap_or(0);
    let (passed, failed, skipped) = (n("passed"), n("failed"), n("skipped"));
    let mut parts = vec![paint(st, GREEN, &format!("{passed} passed"))];
    if failed > 0 {
        parts.push(paint(st, RED, &format!("{failed} failed")));
    }
    if skipped > 0 {
        parts.push(paint(st, DIM, &format!("{skipped} skipped")));
    }
    if let Some(ms) = b.get("durationMs").and_then(Value::as_f64) {
        parts.push(paint(st, DIM, &secs(ms)));
    }
    let m = if failed > 0 { paint(st, RED, "✗") } else { paint(st, GREEN, "✓") };
    let mut out = term::wrap(&format!("{m} {}", parts.join(" · ")), st.width);
    let cmd = s(b, "command");
    if !cmd.is_empty() {
        out.push(paint(st, DIM, &term::truncate(&format!("  $ {cmd}"), st.width)));
    }
    for f in b.get("failures").and_then(Value::as_array).into_iter().flatten() {
        out.extend(term::hang(&format!("  {} ", paint(st, RED, "✗")), s(f, "name"), st.width));
        let m = s(f, "message");
        if !m.is_empty() {
            out.extend(term::wrap(m, st.width.saturating_sub(4)).into_iter().map(|l| format!("    {l}")));
        }
        let file = s(f, "file");
        if !file.is_empty() {
            out.push(paint(st, DIM, &term::truncate(&format!("    {file}"), st.width)));
        }
    }
    out
}

pub fn code(b: &Value, st: &Style) -> Vec<String> {
    let file = s(b, "file");
    let at = match b.get("line").and_then(Value::as_u64) {
        Some(l) if !file.is_empty() => format!("{file}:{l}"),
        _ => file.to_owned(),
    };
    let first = b.get("line").and_then(Value::as_u64).unwrap_or(1);
    let hl: Vec<usize> = b
        .get("highlight")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .filter_map(|h| usize::try_from(h.saturating_sub(first.saturating_sub(1))).ok())
        .collect();
    let body = s(b, "code");
    let lines: Vec<&str> = body.lines().collect();
    let mut out = crate::md::code(st, s(b, "language"), &at, &lines, &hl);
    caption(st, b, &mut out);
    out
}

pub fn terminal(b: &Value, st: &Style) -> Vec<String> {
    let mut out = vec![term::truncate(&format!("{} {}", paint(st, DIM, "$"), paint(st, BOLD, s(b, "command"))), st.width)];
    let output = s(b, "output");
    for l in output.lines() {
        out.push(format!("{} {}", paint(st, DIM, "│"), term::truncate(l, st.width.saturating_sub(2))));
    }
    if let Some(code) = b.get("exitCode").and_then(Value::as_i64).filter(|c| *c != 0) {
        out.push(paint(st, RED, &format!("exit {code}")));
    }
    out
}

pub fn callout(b: &Value, st: &Style) -> Vec<String> {
    let color = match s(b, "tone") {
        "warn" => YELLOW,
        "danger" => RED,
        "success" => GREEN,
        _ => BLUE,
    };
    let bar = paint(st, color, "▌");
    let mut out = Vec::new();
    let t = s(b, "title");
    if !t.is_empty() {
        out.extend(term::wrap(&paint(st, BOLD, t), st.width.saturating_sub(2)).into_iter().map(|l| format!("{bar} {l}")));
    }
    out.extend(term::wrap(&crate::md::inline(st, s(b, "text")), st.width.saturating_sub(2)).into_iter().map(|l| format!("{bar} {l}")));
    out
}

/// Numbered choices: `1. label`.
fn numbered(st: &Style, labels: &[String]) -> Vec<String> {
    labels
        .iter()
        .enumerate()
        .flat_map(|(n, l)| term::hang(&format!("  {} ", paint(st, BOLD, &format!("{}.", n + 1))), l, st.width))
        .collect()
}

pub fn question(b: &Value, st: &Style) -> Vec<String> {
    let mut out = term::wrap(&format!("{} {}", paint(st, YELLOW, "?"), paint(st, BOLD, s(b, "question"))), st.width);
    let labels: Vec<String> = b
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|o| s(o, "label").to_owned())
        .filter(|l| !l.is_empty())
        .collect();
    out.extend(numbered(st, &labels));
    out
}

pub fn blocked(b: &Value, st: &Style) -> Vec<String> {
    let mut out = vec![paint(st, BOLD, "Blocked")];
    for i in items(b) {
        let why = s(i, "why");
        let line = format!("{}: {}{}", s(i, "tool"), s(i, "detail"), if why.is_empty() { String::new() } else { format!(" — {why}") });
        out.extend(term::hang(&format!("{} ", paint(st, RED, "⊘")), &line, st.width));
    }
    out
}

pub fn actions(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    if out.is_empty() {
        out.push(paint(st, BOLD, "Actions"));
    }
    let labels: Vec<String> = items(b)
        .iter()
        .map(|i| {
            let cmd = s(i, "command");
            if cmd.is_empty() { s(i, "label").to_owned() } else { format!("{}  {}", s(i, "label"), paint(st, DIM, &format!("$ {cmd}"))) }
        })
        .collect();
    out.extend(numbered(st, &labels));
    out
}

pub fn next(b: &Value, st: &Style) -> Vec<String> {
    let labels: Vec<String> = items(b).iter().map(|i| i.as_str().map_or_else(|| s(i, "label").to_owned(), str::to_owned)).collect();
    let mut out = vec![paint(st, BOLD, "Next")];
    out.extend(numbered(st, &labels));
    out
}
