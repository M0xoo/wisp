#![allow(clippy::unwrap_used)]

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

use super::*;

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn app() -> App {
    let mut a = App::default();
    a.upsert("t1".into(), json!({ "title": "Fix the login", "state": "review", "agent": "claude", "updated_at": 10 }));
    a.upsert("t2".into(), json!({ "title": "Add dark mode", "state": "running", "agent": "codex", "updated_at": 20 }));
    a.upsert("t3".into(), json!({ "title": "Old one", "state": "done", "archived": true, "updated_at": 30 }));
    a
}

fn screen(a: &App) -> String {
    let mut t = Terminal::new(TestBackend::new(100, 20)).unwrap();
    t.draw(|f| draw(f, a)).unwrap();
    let buf = t.backend().buffer().clone();
    (0..buf.area.height).map(|y| (0..buf.area.width).map(|x| buf[(x, y)].symbol().to_owned()).collect::<String>()).collect::<Vec<_>>().join("\n")
}

#[test]
fn the_tui_lists_tasks_and_shows_the_selected_answer() {
    let mut a = app();
    a.selected = 0;
    a.answer = vec!["Fixed the redirect.".into()];
    a.answer_of = "t2".into();
    let s = screen(&a);
    assert!(s.contains("wisp · 2 tasks"), "archived ones are left out:\n{s}");
    assert!(s.contains("● Add dark mode") && s.contains("◆ Fix the login"));
    assert!(s.find("● Add dark mode").unwrap() < s.find("◆ Fix the login").unwrap(), "newest first");
    assert!(s.contains("Add dark mode · running · codex"), "the selected task's head:\n{s}");
    assert!(s.contains("Fixed the redirect."));
    assert!(s.contains("n new · r reply"));
}

#[test]
fn keys_move_compose_and_act() {
    let mut a = app();
    assert_eq!(a.key(key(KeyCode::Char('j'))), Act::Open("t1".into()));
    assert_eq!(a.key(key(KeyCode::Char('j'))), Act::Open("t1".into()), "the last row stays");
    assert_eq!(a.key(key(KeyCode::Char('s'))), Act::Stop("t1".into()));
    // a reply to the selected task
    assert_eq!(a.key(key(KeyCode::Char('r'))), Act::Nothing);
    for ch in "ok go".chars() {
        a.key(key(KeyCode::Char(ch)));
    }
    assert!(screen(&a).contains("ok go"), "what's typed shows");
    assert_eq!(a.key(key(KeyCode::Enter)), Act::Reply { id: "t1".into(), text: "ok go".into() });
    // a new task; q while composing is a letter, not quit
    a.key(key(KeyCode::Char('n')));
    a.key(key(KeyCode::Char('q')));
    assert_eq!(a.key(key(KeyCode::Enter)), Act::Start("q".into()));
    a.key(key(KeyCode::Char('n')));
    assert_eq!(a.key(key(KeyCode::Esc)), Act::Nothing);
    assert_eq!(a.compose, None);
    assert_eq!(a.key(key(KeyCode::Char('q'))), Act::Quit);
    assert_eq!(a.key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)), Act::Quit);
}

#[test]
fn a_changed_row_keeps_the_selection_on_its_task() {
    let mut a = app();
    a.key(key(KeyCode::Char('j')));
    assert_eq!(a.selected_id().as_deref(), Some("t1"));
    // t1 moves to the top (it changed): the selection follows it
    a.upsert("t1".into(), json!({ "title": "Fix the login", "state": "running", "updated_at": 99 }));
    assert_eq!((a.selected, a.selected_id().as_deref()), (0, Some("t1")));
    a.remove("t1");
    assert_eq!(a.selected_id().as_deref(), Some("t2"));
}
