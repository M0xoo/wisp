//! The built-in `term.block@1` renderers: each answer block type drawn for the terminal (hero, markdown, steps,
//! tests, diff, files, stats, callout, checklist, question, code, terminal, commits, compare, next, actions, and a
//! one-line fallback for the rest). Lines come unwrapped: the pane wraps them at its own width.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;

use crate::theme::Theme;
use crate::{TermBlock, diff};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn items(v: &Value) -> Vec<Value> {
    v.get("items").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn num(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

/// A status word as a glyph and colour.
fn status(st: &str, th: &Theme) -> (&'static str, Style) {
    match st {
        "done" | "pass" | "ok" | "good" | "success" => ("✓", Style::default().fg(th.good)),
        "failed" | "fail" | "bad" | "error" | "blocked" | "danger" => ("✗", Style::default().fg(th.bad)),
        "skipped" | "pending" => ("○", th.dim()),
        "partial" | "warn" => ("◐", Style::default().fg(th.warn)),
        _ => ("•", th.dim()),
    }
}

/// Markdown, lightly: headings, lists, quotes, fenced code (coloured), `inline code` and **bold**.
pub fn markdown(text: &str, th: &Theme) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let mut fence = false;
    for raw in text.lines() {
        if raw.trim_start().starts_with("```") {
            fence = !fence;
            continue;
        }
        if fence {
            let mut spans = vec![Span::styled("  ", th.text())];
            spans.extend(diff::highlight(raw, th, th.text()));
            out.push(Line::from(spans));
            continue;
        }
        let t = raw.trim_end();
        if let Some(h) = t.strip_prefix("### ").or_else(|| t.strip_prefix("## ")).or_else(|| t.strip_prefix("# ")) {
            out.push(Line::from(Span::styled(h.to_owned(), th.strong())));
        } else if let Some(q) = t.strip_prefix("> ") {
            out.push(Line::from(vec![Span::styled("│ ", th.dim()), Span::styled(q.to_owned(), th.dim())]));
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            let mut spans = vec![Span::styled("• ", th.dim())];
            spans.extend(inline(rest, th));
            out.push(Line::from(spans));
        } else {
            out.push(Line::from(inline(t, th)));
        }
    }
    out
}

/// `code` and **bold** inside a line.
pub fn inline(t: &str, th: &Theme) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    let mut rest = t;
    while !rest.is_empty() {
        let tick = rest.find('`');
        let bold = rest.find("**");
        match (tick, bold) {
            (Some(i), b) if b.is_none_or(|b| i < b) => {
                out.push(Span::styled(rest[..i].to_owned(), th.text()));
                let after = &rest[i + 1..];
                let Some(j) = after.find('`') else {
                    out.push(Span::styled(rest[i..].to_owned(), th.text()));
                    break;
                };
                out.push(Span::styled(after[..j].to_owned(), th.accent()));
                rest = &after[j + 1..];
            }
            (_, Some(b)) => {
                out.push(Span::styled(rest[..b].to_owned(), th.text()));
                let after = &rest[b + 2..];
                let Some(j) = after.find("**") else {
                    out.push(Span::styled(rest[b..].to_owned(), th.text()));
                    break;
                };
                out.push(Span::styled(after[..j].to_owned(), th.strong()));
                rest = &after[j + 2..];
            }
            _ => {
                out.push(Span::styled(rest.to_owned(), th.text()));
                break;
            }
        }
    }
    out
}

fn title(t: &str, th: &Theme) -> Option<Line<'static>> {
    (!t.is_empty()).then(|| Line::from(Span::styled(t.to_owned(), th.strong())))
}

/// One block as lines; `width` decides side-by-side diffs.
pub fn render(b: &Value, width: u16, th: &Theme) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    match s(b, "type") {
        // a bar in the status's tone down the left, the title bold, the summary under it
        "hero" => {
            let (g, st) = status(s(b, "status"), th);
            let bar = Span::styled("▌ ", st);
            out.push(Line::from(vec![bar.clone(), Span::styled(format!("{g} "), st.add_modifier(Modifier::BOLD)), Span::styled(s(b, "title").to_owned(), th.strong())]));
            for l in markdown(s(b, "summary"), th) {
                let mut spans = vec![bar.clone()];
                spans.extend(l.spans.into_iter().map(|x| if x.style.fg == Some(th.ink) { x.style(Style::default().fg(th.ink2)) } else { x }));
                out.push(Line::from(spans));
            }
        }
        "markdown" => out.extend(markdown(s(b, "text"), th)),
        "steps" | "checklist" => {
            out.extend(title(s(b, "title"), th));
            for it in items(b) {
                let (g, st) = if s(b, "type") == "checklist" { if it["done"] == true { ("✓", Style::default().fg(th.good)) } else { ("○", th.dim()) } } else { status(s(&it, "status"), th) };
                let label = if s(&it, "title").is_empty() { s(&it, "text") } else { s(&it, "title") };
                let mut spans = vec![Span::styled(format!("{g} "), st), Span::styled(label.to_owned(), th.text())];
                if !s(&it, "detail").is_empty() {
                    spans.push(Span::styled(format!("  {}", s(&it, "detail")), th.dim()));
                }
                out.push(Line::from(spans));
            }
        }
        "tests" => {
            let (passed, failed, skipped) = (num(b, "passed"), num(b, "failed"), num(b, "skipped"));
            let (g, st) = if failed > 0 { ("✗", Style::default().fg(th.bad)) } else { ("✓", Style::default().fg(th.good)) };
            let tone = |n: i64, c| if n > 0 { Style::default().fg(c).add_modifier(Modifier::BOLD) } else { th.dim() };
            out.push(Line::from(vec![
                Span::styled(format!("{g} "), st.add_modifier(Modifier::BOLD)),
                Span::styled(s(b, "command").to_owned(), th.text()),
                Span::raw("  "),
                Span::styled(format!("{passed} passed"), tone(passed, th.good)),
                Span::styled(" · ", th.dim()),
                Span::styled(format!("{failed} failed"), tone(failed, th.bad)),
                Span::styled(" · ", th.dim()),
                Span::styled(format!("{skipped} skipped"), tone(skipped, th.warn)),
            ]));
            for x in b.get("failures").and_then(Value::as_array).into_iter().flatten() {
                out.push(Line::from(vec![Span::styled("  ✗ ", Style::default().fg(th.bad)), Span::styled(s(x, "name").to_owned(), th.text()), Span::styled(format!("  {}", s(x, "message")), th.dim()), Span::styled(format!("  {}", s(x, "file")), th.dim())]));
            }
        }
        "diff" => {
            let rows = diff::lines(s(b, "before"), s(b, "after"));
            let (a, d) = diff::counts(&rows);
            out.push(Line::from(vec![Span::styled(s(b, "file").to_owned(), th.strong()), Span::styled(format!("  +{a}"), Style::default().fg(th.add)), Span::styled(format!(" −{d}"), Style::default().fg(th.del)), Span::styled(format!("  {}", s(b, "caption")), th.dim())]));
            out.extend(diff::render(&rows, width, th).0);
        }
        "files" | "tree" => {
            out.extend(title(s(b, "title"), th));
            for it in items(b) {
                let (sign, st) = match s(&it, "change") {
                    "added" => ("+", Style::default().fg(th.add)),
                    "deleted" => ("−", Style::default().fg(th.del)),
                    "renamed" => ("→", Style::default().fg(th.info)),
                    _ => ("~", Style::default().fg(th.warn)),
                };
                out.push(Line::from(vec![Span::styled(format!("{sign} "), st), Span::styled(s(&it, "path").to_owned(), th.text()), Span::styled(format!("  {}", s(&it, "note")), th.dim())]));
            }
        }
        "stats" | "chart" => {
            out.extend(title(s(b, "title"), th));
            let line: Vec<Span<'static>> = items(b)
                .iter()
                .flat_map(|it| {
                    let v = it.get("value").map_or_else(String::new, |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
                    let tone = match s(it, "tone") {
                        "good" => Style::default().fg(th.good),
                        "bad" => Style::default().fg(th.bad),
                        _ => th.strong(),
                    };
                    [Span::styled(format!("{v}{} ", s(it, "unit")), tone), Span::styled(format!("{}   ", s(it, "label")), th.dim())]
                })
                .collect();
            out.push(Line::from(line));
        }
        _ => more(b, th, &mut out),
    }
    out
}

/// The rest of [`render`]'s types.
fn more(b: &Value, th: &Theme, out: &mut Vec<Line<'static>>) {
    match s(b, "type") {
        "callout" => {
            let st = match s(b, "tone") {
                "danger" => Style::default().fg(th.bad),
                "warn" => Style::default().fg(th.warn),
                "success" => Style::default().fg(th.good),
                _ => Style::default().fg(th.info),
            };
            out.push(Line::from(vec![Span::styled("▍ ", st), Span::styled(s(b, "title").to_owned(), st.add_modifier(Modifier::BOLD))]));
            for l in markdown(s(b, "text"), th) {
                let mut spans = vec![Span::styled("▍ ", st)];
                spans.extend(l.spans);
                out.push(Line::from(spans));
            }
        }
        "question" => {
            out.push(Line::from(Span::styled(format!("? {}", s(b, "question")), Style::default().fg(th.warn).add_modifier(Modifier::BOLD))));
            for (i, o) in b.get("options").and_then(Value::as_array).into_iter().flatten().enumerate() {
                out.push(Line::from(vec![Span::styled(format!("  {} ", i + 1), th.accent()), Span::styled(s(o, "label").to_owned(), th.text())]));
            }
        }
        "code" | "terminal" => {
            // a terminal block without its command shows only its output (no lone `$`)
            let head = if s(b, "type") == "terminal" { if s(b, "command").is_empty() { String::new() } else { format!("$ {}", s(b, "command")) } } else { s(b, "caption").to_owned() };
            out.extend(title(&head, th));
            let body = if s(b, "type") == "terminal" { s(b, "output") } else { s(b, "code") };
            for l in body.lines() {
                let mut spans = vec![Span::styled("  ", th.text())];
                spans.extend(diff::highlight(l, th, th.text()));
                out.push(Line::from(spans));
            }
        }
        "commits" => {
            for c in items(b) {
                out.push(Line::from(vec![Span::styled(format!("{} ", s(&c, "hash")), th.accent()), Span::styled(s(&c, "message").to_owned(), th.text())]));
            }
        }
        "compare" => {
            for side in ["before", "after"] {
                let x = &b[side];
                out.push(Line::from(Span::styled(if s(x, "label").is_empty() { side.to_owned() } else { s(x, "label").to_owned() }, th.strong())));
                for i in x.get("items").and_then(Value::as_array).into_iter().flatten() {
                    out.push(Line::from(vec![Span::styled("• ", th.dim()), Span::styled(i.as_str().unwrap_or_default().to_owned(), th.text())]));
                }
            }
        }
        "next" | "actions" => {
            out.extend(title(if s(b, "type") == "next" { "Next" } else { s(b, "title") }, th));
            for i in items(b) {
                let t = i.as_str().map_or_else(|| s(&i, "label").to_owned(), str::to_owned);
                out.push(Line::from(vec![Span::styled("→ ", th.accent()), Span::styled(t, th.text())]));
            }
        }
        "blocked" => {
            for i in items(b) {
                out.push(Line::from(vec![Span::styled("⊘ ", Style::default().fg(th.bad)), Span::styled(format!("{} {}", s(&i, "tool"), s(&i, "detail")), th.text()), Span::styled(format!("  {}", s(&i, "why")), th.dim())]));
            }
        }
        other => {
            let what = ["title", "caption", "path", "url", "question", "text"].iter().map(|k| s(b, k)).find(|t| !t.is_empty()).unwrap_or_default();
            out.push(Line::from(vec![Span::styled(format!("[{other}] "), th.dim()), Span::styled(what.to_owned(), th.text())]));
        }
    }
}

/// The built-in renderers as one `term.block@1` contribution (every type above).
#[derive(Debug, Default)]
pub struct Builtin;

impl TermBlock for Builtin {
    fn kinds(&self) -> &[&str] {
        &["*"]
    }
    fn render(&self, block: &Value, width: u16, th: &Theme) -> Vec<Line<'static>> {
        render(block, width, th)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn text(lines: &[Line<'_>]) -> String {
        lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn every_answer_block_has_a_terminal_form() {
        let th = Theme::DARK;
        let cases = [
            (json!({ "type": "hero", "title": "Login fixed", "status": "done", "summary": "The **redirect** was `wrong`." }), "▌ ✓ Login fixed\n▌ The redirect was wrong."),
            (json!({ "type": "tests", "command": "cargo test", "passed": 41, "failed": 1, "skipped": 0, "failures": [{ "name": "auth", "message": "401", "file": "a.rs:3" }] }), "✗ cargo test  41 passed · 1 failed · 0 skipped\n  ✗ auth  401  a.rs:3"),
            (json!({ "type": "checklist", "items": [{ "text": "merged", "done": true }, { "text": "deployed", "done": false }] }), "✓ merged\n○ deployed"),
            (json!({ "type": "question", "question": "Which?", "options": [{ "label": "A" }, { "label": "B" }] }), "? Which?\n  1 A\n  2 B"),
            (json!({ "type": "files", "items": [{ "path": "a.rs", "change": "added", "note": "new" }] }), "+ a.rs  new"),
            (json!({ "type": "flow", "title": "Data" }), "[flow] Data"),
            (json!({ "type": "terminal", "output": "exit 0" }), "  exit 0"),
        ];
        for (b, want) in cases {
            assert_eq!(text(&render(&b, 80, &th)), want, "{b}");
        }
        // the hero's bar is in its status's tone; the tests' counts are coloured
        let hero = render(&json!({ "type": "hero", "title": "Held", "status": "partial" }), 80, &th);
        assert_eq!(hero[0].spans[0].style.fg, Some(th.warn));
        let tests = render(&json!({ "type": "tests", "command": "t", "passed": 3, "failed": 1 }), 80, &th);
        assert!(tests[0].spans.iter().any(|s| s.content == "1 failed" && s.style.fg == Some(th.bad)));
        assert!(tests[0].spans.iter().any(|s| s.content == "3 passed" && s.style.fg == Some(th.good)));
        let d = render(&json!({ "type": "diff", "file": "a.rs", "before": "x\n", "after": "y\n" }), 80, &th);
        assert!(d.iter().any(|l| l.spans.iter().any(|s| s.style.bg == Some(th.add_bg))), "an added line on add-bg");
        assert!(text(&d).starts_with("a.rs  +1 −1"));
    }
}
