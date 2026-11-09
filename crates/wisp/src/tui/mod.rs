//! `wisp tui` (ADR-0024): wisp full-screen in the terminal, a client of the sync protocol like the CLI and the phone.
//! The task list on the left (the runtime's list topic, live), the selected task's last answer on the right (its
//! blocks through the CLI's renderers: `term.block`, the same text `wisp show` prints), and a composer at the
//! bottom for a new task or a reply. Nothing polls: the list topic says when a task changed, and its answer is read
//! again then.
//!
//! Keys: ↑/↓ or j/k move · n new task · r reply to the selected one · s stop it · PgUp/PgDn scroll · q quit ·
//! Esc closes the composer.
//!
//! The model ([`App`]), drawing ([`draw`]) and keys ([`App::key`]) are pure and tested with ratatui's test backend;
//! [`run`] wires them to the terminal, the sync stream and the commands.

use std::collections::BTreeMap;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use serde_json::{Value, json};

use crate::client::{Client, Result};

/// What the composer is writing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compose {
    New(String),
    Reply(String),
}

/// What a key asks the loop to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Act {
    Nothing,
    Quit,
    /// read the selected task's answer (the selection moved)
    Open(String),
    Start(String),
    Reply { id: String, text: String },
    Stop(String),
}

#[derive(Debug, Default)]
pub struct App {
    pub tasks: BTreeMap<String, Value>,
    pub selected: usize,
    pub answer: Vec<String>,
    /// whose answer `answer` is
    pub answer_of: String,
    pub scroll: u16,
    pub compose: Option<Compose>,
    pub note: String,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// A state as one glyph (the list's left column).
fn glyph(state: &str) -> &'static str {
    match state {
        "running" => "●",
        "waiting" | "asking" => "?",
        "review" => "◆",
        "done" => "✓",
        "error" => "✗",
        _ => "·",
    }
}

impl App {
    /// The tasks, newest first, archived ones left out.
    pub fn list(&self) -> Vec<(&String, &Value)> {
        let mut v: Vec<(&String, &Value)> = self.tasks.iter().filter(|(_, t)| t.get("archived").and_then(Value::as_bool) != Some(true)).collect();
        v.sort_by_key(|(_, t)| std::cmp::Reverse(t.get("updated_at").or_else(|| t.get("updatedAt")).and_then(Value::as_i64).unwrap_or(0)));
        v
    }

    pub fn selected_id(&self) -> Option<String> {
        self.list().get(self.selected).map(|(id, _)| (*id).clone())
    }

    /// A list row changed or arrived; the selection stays on the same task when it can.
    pub fn upsert(&mut self, id: String, v: Value) {
        let keep = self.selected_id();
        self.tasks.insert(id, v);
        if let Some(k) = keep
            && let Some(i) = self.list().iter().position(|(id, _)| **id == k)
        {
            self.selected = i;
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.tasks.remove(id);
        self.selected = self.selected.min(self.list().len().saturating_sub(1));
    }

    fn moved(&mut self, by: isize) -> Act {
        let n = self.list().len();
        if n == 0 {
            return Act::Nothing;
        }
        self.selected = self.selected.saturating_add_signed(by).min(n - 1);
        self.scroll = 0;
        self.selected_id().map_or(Act::Nothing, Act::Open)
    }

    /// One key.
    pub fn key(&mut self, k: KeyEvent) -> Act {
        if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
            return Act::Quit;
        }
        if let Some(c) = self.compose.clone() {
            return self.compose_key(c, k);
        }
        match k.code {
            KeyCode::Char('q') => Act::Quit,
            KeyCode::Down | KeyCode::Char('j') => self.moved(1),
            KeyCode::Up | KeyCode::Char('k') => self.moved(-1),
            KeyCode::PageDown => {
                self.scroll = self.scroll.saturating_add(10);
                Act::Nothing
            }
            KeyCode::PageUp => {
                self.scroll = self.scroll.saturating_sub(10);
                Act::Nothing
            }
            KeyCode::Char('n') => {
                self.compose = Some(Compose::New(String::new()));
                Act::Nothing
            }
            KeyCode::Char('r') if self.selected_id().is_some() => {
                self.compose = Some(Compose::Reply(String::new()));
                Act::Nothing
            }
            KeyCode::Char('s') => self.selected_id().map_or(Act::Nothing, Act::Stop),
            _ => Act::Nothing,
        }
    }

    fn compose_key(&mut self, c: Compose, k: KeyEvent) -> Act {
        let (mut text, new) = match c {
            Compose::New(t) => (t, true),
            Compose::Reply(t) => (t, false),
        };
        match k.code {
            KeyCode::Esc => {
                self.compose = None;
                return Act::Nothing;
            }
            KeyCode::Enter => {
                self.compose = None;
                let t = text.trim().to_owned();
                if t.is_empty() {
                    return Act::Nothing;
                }
                return if new { Act::Start(t) } else { self.selected_id().map_or(Act::Nothing, |id| Act::Reply { id, text: t }) };
            }
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Char(ch) => text.push(ch),
            _ => {}
        }
        self.compose = Some(if new { Compose::New(text) } else { Compose::Reply(text) });
        Act::Nothing
    }
}

/// The screen.
pub fn draw(f: &mut ratatui::Frame<'_>, app: &App) {
    let rows = Layout::default().direction(Direction::Vertical).constraints([Constraint::Min(3), Constraint::Length(3)]).split(f.area());
    let cols = Layout::default().direction(Direction::Horizontal).constraints([Constraint::Percentage(38), Constraint::Percentage(62)]).split(rows[0]);
    let list = app.list();
    let items: Vec<ListItem<'_>> = list.iter().map(|(_, t)| ListItem::new(Line::from(vec![Span::raw(format!("{} ", glyph(s(t, "state")))), Span::raw(s(t, "title").to_owned())]))).collect();
    let mut state = ListState::default().with_selected((!list.is_empty()).then_some(app.selected));
    let title = format!(" wisp · {} task{} ", list.len(), if list.len() == 1 { "" } else { "s" });
    f.render_stateful_widget(List::new(items).block(Block::default().borders(Borders::ALL).title(title)).highlight_style(Style::default().add_modifier(Modifier::REVERSED)), cols[0], &mut state);
    let (head, body) = match list.get(app.selected) {
        Some((id, t)) => (format!(" {} · {} · {} ", s(t, "title"), s(t, "state"), s(t, "agent")), if app.answer_of == **id && !app.answer.is_empty() { app.answer.join("\n") } else { "No answer yet.".to_owned() }),
        None => (" No tasks ".to_owned(), "Press n to start one.".to_owned()),
    };
    f.render_widget(Paragraph::new(body).wrap(Wrap { trim: false }).scroll((app.scroll, 0)).block(Block::default().borders(Borders::ALL).title(head)), cols[1]);
    let bottom: Rect = rows[1];
    let (label, text) = match &app.compose {
        Some(Compose::New(t)) => (" New task (Enter starts, Esc closes) ", format!("{t}▏")),
        Some(Compose::Reply(t)) => (" Reply (Enter sends, Esc closes) ", format!("{t}▏")),
        _ => (" ", if app.note.is_empty() { "↑↓ move · n new · r reply · s stop · PgUp/PgDn scroll · q quit".to_owned() } else { app.note.clone() }),
    };
    f.render_widget(Paragraph::new(text).block(Block::default().borders(Borders::ALL).title(label)), bottom);
}

/// The selected task's last answer, as `wisp show` prints it (without colours: the TUI styles its own frame).
async fn answer(c: &Client, id: &str) -> Vec<String> {
    let p = c.cmd("runtime.presentation", json!({ "id": id })).await.unwrap_or(Value::Null);
    let blocks = p.get("blocks").and_then(Value::as_array).cloned().unwrap_or_default();
    if blocks.is_empty() {
        return Vec::new();
    }
    let plain = wisp_cli_core::Style { width: 80, color: false, links: false, images: wisp_cli_core::Images::None };
    wisp_cli_core::Renderers::builtin().answer(&blocks, &plain)
}

async fn act(c: &Client, app: &mut App, a: Act, cwd: &str) -> bool {
    match a {
        Act::Quit => return true,
        Act::Nothing => {}
        Act::Open(id) => {
            app.answer = answer(c, &id).await;
            app.answer_of = id;
        }
        Act::Start(prompt) => {
            app.note = match c.cmd("runtime.create", json!({ "prompt": prompt, "cwd": cwd })).await {
                Ok(v) => format!("started {}", s(&v, "id")),
                Err(e) => format!("didn't start: {e}"),
            };
        }
        Act::Reply { id, text } => {
            app.note = match c.cmd("runtime.followUp", json!({ "id": id, "text": text, "queue": true })).await {
                Ok(_) => "sent".into(),
                Err(e) => format!("not sent: {e}"),
            };
        }
        Act::Stop(id) => {
            app.note = match c.cmd("runtime.stop", json!({ "id": id })).await {
                Ok(_) => "stopped".into(),
                Err(e) => format!("not stopped: {e}"),
            };
        }
    }
    false
}

/// The rows the list topic gave, into the model. → the ids that changed.
fn fold(app: &mut App, got: Vec<crate::attach::Got>) -> Vec<String> {
    let mut changed = Vec::new();
    for g in got {
        match g {
            crate::attach::Got::Snapshot(rows) => {
                app.tasks.clear();
                for r in rows.into_iter().filter(|r| r.e == "session") {
                    changed.push(r.id.clone());
                    app.upsert(r.id, r.v);
                }
            }
            crate::attach::Got::Ops(ops) => {
                for op in ops.into_iter().filter(|o| o.e == "session") {
                    changed.push(op.id.clone());
                    match op.change {
                        wisp_protocol::Change::Upsert { v } => app.upsert(op.id, v),
                        wisp_protocol::Change::Del => app.remove(&op.id),
                        wisp_protocol::Change::Patch { ops } => {
                            let mut v = app.tasks.get(&op.id).cloned().unwrap_or(Value::Null);
                            let _ = wisp_protocol::apply_patch(&mut v, &ops);
                            app.upsert(op.id, v);
                        }
                        wisp_protocol::Change::Append { .. } => {}
                    }
                }
            }
        }
    }
    changed
}

/// `wisp tui`.
pub async fn run(c: &Client, cwd: &str) -> Result<i32> {
    let mut conn = crate::attach::Conn::new(c, &[wisp_runtime_api::TOPIC_LIST.to_owned()]);
    let mut app = App::default();
    let first = conn.start().await?;
    fold(&mut app, first);
    if let Some(id) = app.selected_id() {
        act(c, &mut app, Act::Open(id), cwd).await;
    }
    let (tx, mut keys) = tokio::sync::mpsc::channel::<KeyEvent>(32);
    std::thread::spawn(move || {
        while let Ok(ev) = ratatui::crossterm::event::read() {
            if let ratatui::crossterm::event::Event::Key(k) = ev
                && k.kind == ratatui::crossterm::event::KeyEventKind::Press
                && tx.blocking_send(k).is_err()
            {
                return;
            }
        }
    });
    let mut term = ratatui::init();
    let out = loop {
        if let Err(e) = term.draw(|f| draw(f, &app)) {
            break Err(crate::client::CliError::said(format!("the terminal: {e}")));
        }
        tokio::select! {
            k = keys.recv() => {
                let Some(k) = k else { break Ok(0) };
                let a = app.key(k);
                if act(c, &mut app, a, cwd).await {
                    break Ok(0);
                }
            }
            got = conn.next() => match got {
                Ok(got) => {
                    let changed = fold(&mut app, got);
                    // the selected task changed: its answer is read again
                    if let Some(id) = app.selected_id().filter(|id| changed.contains(id) || app.answer_of != *id) {
                        act(c, &mut app, Act::Open(id), cwd).await;
                    }
                }
                Err(e) => break Err(e),
            },
        }
    };
    ratatui::restore();
    out
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
