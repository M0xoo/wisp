//! wisp.history's TUI (ADR-0024): a `tui.view@1` the terminal shows like any built-in, `g b` or the palette's
//! "Blame". It asks for a file, reads `history.blame` with `byLine`, and shows every line beside a why-gutter:
//! the task that wrote it (its title on the first line of the run, a rule down the rest), or "by hand". The
//! detail pane says what that task was asked.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{Value, json};
use wisp_tui_api::{Column, Registry, Source, Theme, TuiView};

/// What wisp.history adds to the TUI.
pub fn register(r: &mut Registry) {
    r.view(Blame);
}

/// `wisp blame` in the terminal.
#[derive(Debug)]
pub struct Blame;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

impl TuiView for Blame {
    fn id(&self) -> &'static str {
        "blame"
    }
    fn title(&self) -> &'static str {
        "Blame"
    }
    fn goto(&self) -> Option<char> {
        Some('b')
    }
    fn source(&self) -> Source {
        Source::Command {
            id: "history.blame".into(),
            args: json!({ "target": "{?File}", "repo": "{cwd}", "byLine": true }),
            rows: "/byLine".into(),
        }
    }
    fn columns(&self) -> Vec<Column> {
        vec![
            Column { title: "Why".into(), pointer: "/gutter".into(), width: 26 },
            Column { title: "#".into(), pointer: "/n".into(), width: 5 },
            Column { title: "Line".into(), pointer: "/text".into(), width: 0 },
        ]
    }
    /// The gutter: a run of lines from one task gets its title once, then `│`; lines by hand say so.
    fn shape(&self, rows: Vec<Value>) -> Vec<Value> {
        // the run the previous line was in: `Some(None)` by hand, `Some(Some(id))` a task's, `None` at the start
        let mut prev: Option<Option<String>> = None;
        rows.into_iter()
            .map(|mut r| {
                let who = r.get("task").and_then(Value::as_str).map(str::to_owned);
                let label = match &who {
                    _ if prev.as_ref() == Some(&who) => "│".to_owned(),
                    Some(_) if !s(&r, "title").is_empty() => s(&r, "title").to_owned(),
                    Some(id) => id.chars().take(12).collect(),
                    None => "by hand".to_owned(),
                };
                r["gutter"] = Value::String(label);
                prev = Some(who);
                r
            })
            .collect()
    }
    /// The gutter's title in the accent, "by hand" and the run's rule muted; line numbers muted.
    fn style(&self, row: &Value, column: &Column, th: &Theme) -> Option<Style> {
        match column.pointer.as_str() {
            "/gutter" if row.get("task").and_then(Value::as_str).is_some() && s(row, "gutter") != "│" => {
                Some(th.accent().add_modifier(Modifier::BOLD))
            }
            "/gutter" | "/n" => Some(th.dim()),
            _ => None,
        }
    }
    fn detail(&self, row: &Value, _width: u16, th: &Theme) -> Vec<Line<'static>> {
        let commit = s(row, "commit").to_owned();
        if row.get("task").and_then(Value::as_str).is_none() {
            return vec![Line::from(vec![
                Span::styled("Written by hand", th.strong()),
                Span::styled(format!("  commit {commit}"), th.dim()),
            ])];
        }
        let mut out = vec![Line::from(vec![
            Span::styled(s(row, "title").to_owned(), th.strong()),
            Span::styled(format!("  task {}", s(row, "task").chars().take(12).collect::<String>()), th.dim()),
            Span::styled(format!("  commit {commit}"), th.dim()),
        ])];
        let why = s(row, "why");
        if !why.is_empty() {
            out.push(Line::from(Span::styled("Asked", th.dim().add_modifier(Modifier::BOLD))));
            out.extend(why.lines().map(|l| Line::from(Span::styled(l.to_owned(), th.text()))));
        }
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_why_gutter_names_each_run_once() {
        let rows = vec![
            json!({ "n": 1, "text": "one", "task": "t1", "title": "Fix the login" }),
            json!({ "n": 2, "text": "two", "task": "t1", "title": "Fix the login" }),
            json!({ "n": 3, "text": "TWO", "task": null }),
            json!({ "n": 4, "text": "x", "task": null }),
            json!({ "n": 5, "text": "four", "task": "t1", "title": "Fix the login" }),
        ];
        let g: Vec<String> = Blame.shape(rows).iter().map(|r| s(r, "gutter").to_owned()).collect();
        assert_eq!(g, ["Fix the login", "│", "by hand", "│", "Fix the login"]);
        let mut r = Registry::default();
        register(&mut r);
        let v = r.find("blame").unwrap();
        assert_eq!(
            (
                v.goto(),
                wisp_tui_api::asks(&match v.source() {
                    Source::Command { args, .. } => args,
                    Source::Topic { .. } => Value::Null,
                })
                .as_deref()
            ),
            (Some('b'), Some("File"))
        );
        let d = v.detail(&json!({ "task": "t1abcdef", "title": "Fix", "why": "make login work", "commit": "abc" }), 80, &Theme::DARK);
        assert!(d.iter().any(|l| l.spans.iter().any(|s| s.content == "make login work")));
    }
}
