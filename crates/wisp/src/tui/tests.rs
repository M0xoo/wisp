#![allow(clippy::unwrap_used, clippy::many_single_char_names)] // `a` the app, `t` a terminal, `w`×`h`, as through the TUI's code

use std::fmt::Write as _;

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use serde_json::{Value, json};
use wisp_protocol::Row;
use wisp_tui_api::Theme;

use super::app::{App, Effect, Overlay, Then, Zone};
use super::draw;
use super::model::Transcript;

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn ch(c: char) -> KeyEvent {
    key(KeyCode::Char(c))
}

fn row(e: &str, id: &str, v: Value) -> Row {
    Row { e: e.into(), id: id.into(), v }
}

const DIFF: &str = "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n import { session } from './session';\n-export const ttl = 60;\n+export const ttl = 3600;\n export function login() {}\n";

/// The clock the fixtures read: 2026-11-09 12:00 UTC.
const NOW: i64 = 1_793_966_400_000;
const MIN: i64 = 60_000;

fn app() -> App {
    let mut a = App::new(super::views::registry(), Theme::DARK, "/w/api");
    a.now = NOW;
    a.tasks.rows.insert("t1".into(), json!({ "id": "t1", "title": "Fix the login", "state": "review", "agent": "claude", "cwd": "/w/api", "updated_at": NOW - 12 * MIN }));
    a.tasks.rows.insert("t2".into(), json!({ "id": "t2", "title": "Add dark mode", "state": "running", "agent": "codex", "cwd": "/w/web", "updated_at": NOW - 2 * MIN }));
    a.tasks.rows.insert("t0".into(), json!({ "id": "t0", "title": "Old one", "state": "done", "agent": "claude", "cwd": "/w/api", "updated_at": NOW - 3 * 24 * 60 * MIN }));
    a.tasks.rows.insert("t3".into(), json!({ "id": "t3", "title": "Archived", "state": "done", "archived": true, "updated_at": NOW - MIN }));
    a
}

/// `app()` with t2 open: a finished turn with an answer, and a running one with an edit, streaming text and an ask.
fn opened() -> App {
    let mut a = app();
    let fx = a.listed(&[]);
    assert_eq!(fx, vec![Effect::Watch(Some("t2".into()))]);
    let long = "The session cookie now lives for an hour instead of a minute, and the refresh path reads the same constant, so the two can't drift again.";
    let t = a.open.as_mut().unwrap();
    t.snapshot(vec![
        row("session", "t2", json!({ "id": "t2", "title": "Add dark mode", "state": "running", "cwd": "/w/api", "agent": "codex", "body": { "model": "gpt-5", "branch": "wisp/dark", "ext": { "wisp.goal": { "state": "judging", "rounds": 1 }, "wisp.runtime": { "ask": { "id": "q1", "question": "Use the system theme by default?", "options": ["Yes", "No, dark"] } } }, "queue": [{ "id": "u1", "text": "then add a toggle", "at": 1 }] } })),
        row("turn", "T1", json!({ "id": "T1", "idx": 0, "body": { "status": "done", "prompt": "Make sessions last longer", "presentation": { "blocks": [{ "type": "hero", "title": "Sessions last an hour", "status": "done", "summary": "ttl 60 → 3600" }, { "type": "markdown", "text": long }] } } })),
        row("turn", "T2", json!({ "id": "T2", "idx": 1, "body": { "status": "running", "prompt": "Add dark mode" } })),
        row("event", "1", json!({ "seq": 1, "turn_id": "T1", "body": { "kind": "tool", "tool": "edit", "label": "Edit", "file": "/w/api/src/auth.ts", "detail": DIFF } })),
        row("event", "2", json!({ "seq": 2, "turn_id": "T2", "body": { "kind": "tool", "tool": "read", "label": "Read", "file": "/w/api/src/theme.ts" } })),
        row("event", "3", json!({ "seq": 3, "turn_id": "T2", "body": { "kind": "text", "text": "Reading the theme tokens first." } })),
    ]);
    a
}

fn screen(a: &App, w: u16, h: u16) -> String {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| {
        draw::draw(f, a);
    })
    .unwrap();
    let buf = t.backend().buffer().clone();
    (0..buf.area.height).map(|y| (0..buf.area.width).map(|x| buf[(x, y)].symbol().to_owned()).collect::<String>().trim_end().to_owned()).collect::<Vec<_>>().join("\n")
}

/// A golden under `crates/wisp/tests/goldens/tui/`: written when missing (or with `WISP_GOLDENS=update`), compared
/// otherwise. Changing one is a deliberate act in the PR.
fn golden(name: &str, got: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/tui").join(format!("{name}.txt"));
    if std::env::var("WISP_GOLDENS").as_deref() == Ok("update") || !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap();
    assert_eq!(got, want, "{name} changed; WISP_GOLDENS=update rewrites it");
}

#[test]
fn the_list_starts_on_the_newest_task_in_its_sections() {
    // round-6 nit: the selection started on whichever task the snapshot gave first (the oldest)
    let mut a = app();
    a.listed(&[]);
    assert_eq!(a.sel.as_deref(), Some("t2"), "running and newest: the top row");
    assert_eq!(a.order(), vec!["t2", "t1", "t0"], "Running, then Done newest first; archived left out");
    let s = screen(&a, 160, 48);
    assert!(s.contains("RUNNING") && s.contains("DONE"), "the sections:\n{s}");
    assert!(s.find("Add dark mode").unwrap() < s.find("Fix the login").unwrap());
}

#[test]
fn answers_wrap_at_the_panes_width_not_eighty() {
    // round-6 nit: answers were rendered at 80 columns and wrapped again inside a wider pane
    let a = opened();
    let (lines, _) = draw::transcript(&a, a.open.as_ref().unwrap(), 140);
    let text: Vec<String> = lines.iter().map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect()).collect();
    let long = text.iter().find(|l| l.contains("The session cookie")).unwrap();
    assert!(long.chars().count() > 100 && long.contains("drift again."), "one line at 140: {long}");
    let (narrow, _) = draw::transcript(&a, a.open.as_ref().unwrap(), 40);
    assert!(narrow.iter().all(|l| l.spans.iter().map(|s| s.content.chars().count()).sum::<usize>() <= 40), "and wrapped at a narrow one");
}

#[test]
fn a_tool_step_shows_its_counts_and_opens_to_its_diff() {
    let mut a = opened();
    a.focus = Zone::Task;
    let s = screen(&a, 160, 48);
    assert!(s.contains("✓ Edit src/auth.ts  +1 −1"), "collapsed, with its counts:\n{s}");
    assert!(!s.contains("ttl = 3600"), "closed: no diff");
    a.key(ch('k'));
    a.key(ch('k'));
    assert_eq!(a.cursor, Some(1), "k walks back to the edit");
    a.key(ch('o'));
    let s = screen(&a, 160, 48);
    assert!(s.contains("ttl = 60;") && s.contains("ttl = 3600;"), "open: the diff, side by side when wide:\n{s}");
    a.key(ch(' '));
    assert!(!screen(&a, 160, 48).contains("ttl = 3600"));
}

#[test]
fn an_ask_is_answered_by_number_and_an_approval_by_y_a_n() {
    let mut a = opened();
    a.focus = Zone::Task;
    assert!(screen(&a, 160, 48).contains("Use the system theme by default?"));
    let fx = a.key(ch('2'));
    assert_eq!(fx, vec![Effect::Cmd { id: "runtime.answer".into(), args: json!({ "id": "t2", "text": "No, dark" }), then: Then::Nothing }]);
    let fx = a.key(ch('a'));
    assert_eq!(fx, vec![Effect::Cmd { id: "runtime.answer".into(), args: json!({ "id": "t2", "text": "always" }), then: Then::Nothing }]);
}

#[test]
fn a_follow_up_shows_at_once_and_a_refused_one_comes_back() {
    let mut a = opened();
    a.key(ch('i'));
    assert_eq!(a.focus, Zone::Composer);
    for c in "use tokens".chars() {
        a.key(ch(c));
    }
    let fx = a.key(key(KeyCode::Enter));
    let Some(Effect::Send { task, text, queue, local, .. }) = fx.first().cloned() else { panic!("{fx:?}") };
    assert_eq!((task.as_deref(), text.as_str(), queue), (Some("t2"), "use tokens", true), "queued: a turn runs");
    assert!(a.composer.is_empty() && screen(&a, 160, 48).contains("↑ sending  use tokens"), "the box clears and the follow-up shows at once");
    a.done(Then::Sent(local), Err("the task is gone".into()));
    assert_eq!(a.composer.text(), "use tokens", "refused: the text is back");
    assert!(a.toasts.iter().any(|t| t.bad && t.text.contains("Not sent")));
}

#[test]
fn a_new_task_appears_at_once_and_the_real_one_replaces_it() {
    let mut a = opened();
    a.focus = Zone::List;
    a.key(ch('n'));
    for c in "write docs".chars() {
        a.key(ch(c));
    }
    let fx = a.key(key(KeyCode::Enter));
    let Some(Effect::Send { task: None, local, mode, .. }) = fx.first().cloned() else { panic!("{fx:?}") };
    assert_eq!(mode, super::app::Mode::Auto);
    assert_eq!(a.sel.as_deref(), Some(local.as_str()), "selected at once");
    assert!(screen(&a, 160, 48).contains("write docs"));
    let fx = a.done(Then::Created(local.clone()), Ok(json!({ "id": "t9", "title": "write docs" })));
    assert_eq!((a.sel.as_deref(), fx), (Some("t9"), vec![Effect::Watch(Some("t9".into()))]));
    assert!(!a.tasks.rows.contains_key(&local));
}

#[test]
fn shift_tab_cycles_the_mode_and_esc_interrupts_a_running_turn() {
    let mut a = opened();
    a.key(key(KeyCode::BackTab));
    assert_eq!(a.mode, super::app::Mode::Plan);
    a.focus = Zone::Task;
    let fx = a.key(key(KeyCode::Esc));
    assert_eq!(fx, vec![Effect::Cmd { id: "runtime.stop".into(), args: json!({ "id": "t2" }), then: Then::Stopped("t2".into()) }]);
    assert!(a.key(key(KeyCode::Esc)).is_empty(), "one stop on its way at a time");
    assert!(screen(&a, 160, 48).contains("(stopping)"), "pending, on the row");
}

#[test]
fn the_composer_opens_the_at_and_slash_pickers() {
    let mut a = opened();
    a.catalogue = vec![("goal.set".into(), "Set a goal".into())];
    a.key(ch('i'));
    a.key(ch('/'));
    assert!(matches!(a.overlay, Some(Overlay::Palette(_, super::app::For::Slash))));
    a.key(ch('g'));
    a.key(ch('o'));
    a.key(key(KeyCode::Enter));
    assert_eq!(a.composer.text(), "/goal.set ");
    a.composer.clear();
    let fx = a.key(ch('@'));
    assert!(fx.contains(&Effect::Files) && fx.contains(&Effect::Cmd { id: "crew.list".into(), args: json!({}), then: Then::Mentions("crew".into()) }), "{fx:?}");
    a.done(Then::Mentions("file".into()), Ok(json!(["src/auth.ts"])));
    a.key(ch('f'));
    a.key(ch('i'));
    a.key(ch('x'));
    a.key(key(KeyCode::Enter));
    assert_eq!(a.composer.text(), "@[Fix the login](task:t1) ");
    // files come from `git ls-files`
    a.key(ch('@'));
    for c in "auth".chars() {
        a.key(ch(c));
    }
    a.key(key(KeyCode::Enter));
    assert_eq!(a.composer.text(), "@[Fix the login](task:t1) @src/auth.ts ");
}

#[test]
fn the_palette_goes_to_a_view_and_its_row_actions_run() {
    let mut a = opened();
    a.focus = Zone::List;
    a.key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
    for c in "crew".chars() {
        a.key(ch(c));
    }
    let fx = a.key(key(KeyCode::Enter));
    assert_eq!(fx, vec![Effect::Cmd { id: "crew.list".into(), args: json!({}), then: Then::View("crew".into()) }]);
    a.done(Then::View("crew".into()), Ok(json!([{ "id": "m1", "name": "Ada", "role": "reviewer", "running": 1, "jobs": 4 }])));
    let s = screen(&a, 160, 48);
    assert!(s.contains("Ada") && s.contains("reviewer") && s.contains("w wake"), "{s}");
    let fx = a.key(ch('w'));
    assert_eq!(fx, vec![Effect::Cmd { id: "crew.wake".into(), args: json!({ "id": "m1" }), then: Then::View("crew".into()) }]);
    a.key(key(KeyCode::Esc));
    assert_eq!(a.screen, None);
    // g then a letter goes straight there
    assert_eq!(a.key(ch('g')), vec![]);
    assert_eq!(a.key(ch('m')), vec![Effect::Cmd { id: "machines.list".into(), args: json!({}), then: Then::View("machines".into()) }]);
}

#[test]
fn the_mouse_picks_a_row_and_drags_a_border() {
    let mut a = opened();
    let mut t = Terminal::new(TestBackend::new(160, 48)).unwrap();
    t.draw(|f| a.hit = draw::draw(f, &a)).unwrap();
    let list = a.hit.list;
    let at = |col, row, kind| MouseEvent { kind, column: col, row, modifiers: KeyModifiers::NONE };
    let row = a.hit.rows.iter().find(|(_, id)| *id == "t1").map(|(y, _)| *y).unwrap();
    assert_eq!(a.hit.rows.values().filter(|id| *id == "t1").count(), 2, "a task is two lines, both of them click");
    let fx = a.mouse(at(list.x + 3, row + 1, MouseEventKind::Down(MouseButton::Left)));
    assert_eq!((a.sel.as_deref(), fx), (Some("t1"), vec![Effect::Watch(Some("t1".into()))]));
    a.mouse(at(list.x + list.width, list.y + 2, MouseEventKind::Down(MouseButton::Left)));
    a.mouse(at(list.x + 50, list.y + 2, MouseEventKind::Drag(MouseButton::Left)));
    a.mouse(at(list.x + 50, list.y + 2, MouseEventKind::Up(MouseButton::Left)));
    assert_eq!((a.widths.0, a.dragging), (50, None), "the border follows the drag");
}

#[test]
fn the_help_is_the_keymap() {
    let mut a = opened();
    a.key(ch('?'));
    let s = screen(&a, 160, 48);
    for (_, k, _) in super::keys::KEYS.iter().take(10) {
        assert!(s.contains(k), "{k} in the help:\n{s}");
    }
    a.key(ch('x'));
    assert_eq!(a.overlay, None, "any key closes it");
    // at 100×30 it's taller than the screen: j scrolls to what's below, and it says how much is left
    a.key(ch('?'));
    let s = screen(&a, 100, 30);
    assert!(s.contains("more") && !s.contains("the row's action"), "{s}");
    for _ in 0..30 {
        a.key(ch('j'));
    }
    assert!(screen(&a, 100, 30).contains("the row's action"), "scrolled to the end");
    assert!(a.overlay.is_some(), "j scrolls, it doesn't close");
}

#[test]
fn one_zone_under_a_hundred_columns() {
    let mut a = opened();
    a.focus = Zone::List;
    let s = screen(&a, 80, 24);
    assert!(s.contains("Fix the login") && !s.contains("Sessions last an hour"), "the list alone:\n{s}");
    a.key(key(KeyCode::Enter));
    let s = screen(&a, 80, 24);
    assert!(!s.contains("Fix the login") && s.contains("Add dark mode"), "the task alone:\n{s}");
}

#[test]
fn goldens_at_80x24_and_160x48() {
    let mut a = opened();
    a.focus = Zone::Task;
    golden("task-80x24", &screen(&a, 80, 24));
    golden("task-160x48", &screen(&a, 160, 48));
    a.focus = Zone::List;
    golden("list-80x24", &screen(&a, 80, 24));
    a.side = Some(super::app::Side::Changes);
    golden("changes-160x48", &screen(&a, 160, 48));
    a.side = None;
    a.open_view("crew");
    a.done(Then::View("crew".into()), Ok(json!([{ "id": "m1", "name": "Ada", "role": "reviewer", "running": 1, "jobs": 4 }, { "id": "m2", "name": "Lin", "role": "docs", "running": 0, "jobs": 2, "machine": "box" }])));
    golden("crew-80x24", &screen(&a, 80, 24));
    golden("crew-160x48", &screen(&a, 160, 48));
    a.open_view("blame");
    a.overlay = None;
    a.views.entry("blame".into()).or_default().asked = Some("src/auth.ts".into());
    a.done(Then::View("blame".into()), Ok(blame_answer()));
    golden("blame-160x48", &screen(&a, 160, 48));
    a.screen = None;
    a.key(ch('?'));
    golden("help-160x48", &screen(&a, 160, 48));
    let t: &Transcript = a.open.as_ref().unwrap();
    assert_eq!(t.task, "t2");
}

/// The screen as styled HTML (each cell's colours and weight), for looking at it in a browser: the owner's
/// "visual check every round" (docs/v2-tui-design.md, "The look"). PNGs come from it outside the repo.
fn html(a: &App, w: u16, h: u16) -> String {
    use ratatui::style::{Color, Modifier};
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| {
        draw::draw(f, a);
    })
    .unwrap();
    let buf = t.backend().buffer().clone();
    let css = |c: Color, dflt: Color| -> String {
        match if c == Color::Reset { dflt } else { c } {
            Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
            // xterm's 256: the 16, the 6×6×6 cube, the grey ramp (what Terminal.app draws)
            Color::Indexed(i) => {
                let (r, g, b) = match i {
                    0..=15 => [(0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229), (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)][usize::from(i)],
                    16..=231 => {
                        let step = |v: u8| if v == 0 { 0 } else { 55 + 40 * v };
                        let n = i - 16;
                        (step(n / 36), step(n / 6 % 6), step(n % 6))
                    }
                    _ => {
                        let v = 8 + 10 * (i - 232);
                        (v, v, v)
                    }
                };
                format!("#{r:02x}{g:02x}{b:02x}")
            }
            other => format!("{other:?}").to_lowercase(),
        }
    };
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut out = format!(
        "<!doctype html><meta charset=utf-8><style>body{{margin:0;background:{bg}}}pre{{display:inline-block;margin:0;padding:12px;font:15px/1.25 'SF Mono',Menlo,monospace;background:{bg}}}span{{white-space:pre}}</style><pre>",
        bg = css(a.th.bg, a.th.bg)
    );
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            let c = &buf[(x, y)];
            let (mut fg, mut bg) = (css(c.fg, a.th.ink), css(c.bg, a.th.bg));
            if c.modifier.contains(Modifier::REVERSED) {
                std::mem::swap(&mut fg, &mut bg);
            }
            let weight = if c.modifier.contains(Modifier::BOLD) { "font-weight:700;" } else { "" };
            let italic = if c.modifier.contains(Modifier::ITALIC) { "font-style:italic;" } else { "" };
            let under = if c.modifier.contains(Modifier::UNDERLINED) { "text-decoration:underline;" } else { "" };
            let sym = if c.symbol().is_empty() { " " } else { c.symbol() };
            let _ = write!(out, "<span style=\"color:{fg};background:{bg};{weight}{italic}{under}\">{}</span>", esc(sym));
        }
        out.push('\n');
    }
    out.push_str("</pre>");
    out
}

/// `WISP_TUI_LOOK=<dir>`: every view at 100×30 and 160×45, dark and light, as HTML in that dir (nothing otherwise).
#[test]
fn every_view_renders_to_html_for_the_visual_check() {
    let Ok(dir) = std::env::var("WISP_TUI_LOOK") else { return };
    std::fs::create_dir_all(&dir).unwrap();
    for (th, mode) in [(Theme::DARK, "dark"), (Theme::LIGHT, "light"), (Theme::DARK.indexed(), "dark-256"), (Theme::LIGHT.indexed(), "light-256")] {
        for (w, h) in [(100u16, 30u16), (160, 45)] {
            let mut shots: Vec<(&str, App)> = Vec::new();
            let mut a = opened();
            a.focus = Zone::Task;
            shots.push(("task", a));
            let mut a = opened();
            a.focus = Zone::List;
            shots.push(("list", a));
            let mut a = opened();
            a.key(ch('i'));
            for c in "use the tokens".chars() {
                a.key(ch(c));
            }
            shots.push(("composer", a));
            let mut a = opened();
            a.focus = Zone::Task;
            a.key(ch('k'));
            a.key(ch('k'));
            a.key(ch('o'));
            a.side = Some(super::app::Side::Changes);
            shots.push(("changes", a));
            let mut a = opened();
            a.open_view("crew");
            a.done(Then::View("crew".into()), Ok(json!([{ "id": "m1", "name": "Ada", "role": "reviewer", "running": 1, "jobs": 4 }, { "id": "m2", "name": "Lin", "role": "docs", "running": 0, "jobs": 2, "machine": "box" }])));
            shots.push(("crew", a));
            let mut a = opened();
            a.key(ch('?'));
            shots.push(("help", a));
            let mut a = opened();
            a.open_view("blame");
            a.views.entry("blame".into()).or_default().asked = Some("src/auth.ts".into());
            a.overlay = None;
            a.done(Then::View("blame".into()), Ok(blame_answer()));
            a.key(ch('j'));
            a.key(ch('j'));
            shots.push(("blame", a));
            let mut a = opened();
            a.key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL));
            shots.push(("palette", a));
            for (name, mut a) in shots {
                a.th = th;
                std::fs::write(format!("{dir}/{name}-{w}x{h}-{mode}.html"), html(&a, w, h)).unwrap();
            }
        }
    }
}

/// WCAG contrast of two colours (1 to 21).
fn contrast(a: ratatui::style::Color, b: ratatui::style::Color) -> f64 {
    let lum = |c: ratatui::style::Color| {
        let ratatui::style::Color::Rgb(r, g, b) = c else { return 0.0 };
        let ch = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.039_28 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    };
    let (x, y) = (lum(a), lum(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// The owner's "ghost text" (docs/v2-tui-design.md, "The look"): every glyph that's text, on every view, in both
/// themes, reads at 3:1 or better against its own background (rules and bars, which are decoration, aside).
#[test]
fn no_ghost_text_every_glyph_reads_against_its_background() {
    for th in [Theme::DARK, Theme::LIGHT] {
        let mut views: Vec<App> = Vec::new();
        for focus in [Zone::List, Zone::Task] {
            let mut a = opened();
            a.focus = focus;
            views.push(a);
        }
        let mut a = opened();
        a.focus = Zone::Task;
        a.key(ch('k'));
        a.key(ch('k'));
        a.key(ch('o'));
        a.side = Some(super::app::Side::Changes);
        views.push(a);
        let mut a = opened();
        a.open_view("crew");
        a.done(Then::View("crew".into()), Ok(json!([{ "id": "m1", "name": "Ada", "role": "reviewer", "running": 1, "jobs": 4 }])));
        views.push(a);
        for mut a in views {
            a.th = th;
            let mut t = Terminal::new(TestBackend::new(160, 45)).unwrap();
            t.draw(|f| {
                draw::draw(f, &a);
            })
            .unwrap();
            let buf = t.backend().buffer().clone();
            for y in 0..buf.area.height {
                for x in 0..buf.area.width {
                    let c = &buf[(x, y)];
                    let sym = c.symbol();
                    let deco = sym.chars().all(|ch| ch == ' ' || ('\u{2500}'..='\u{259f}').contains(&ch));
                    if deco {
                        continue;
                    }
                    let fg = if c.fg == ratatui::style::Color::Reset { th.ink } else { c.fg };
                    let bg = if c.bg == ratatui::style::Color::Reset { th.bg } else { c.bg };
                    let row: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol().to_owned()).collect();
                    assert!(contrast(fg, bg) >= 3.0, "{:?}: '{sym}' at {x},{y} reads at {:.1}:1 in {}", th.mode, contrast(fg, bg), row.trim_end());
                }
            }
        }
    }
}

/// The owner's stray bright character ("toggl**e**"): a frame that draws less than the one before leaves nothing
/// of it behind. Two frames through one terminal (ratatui writes only the cells that changed), then the screen
/// is compared with a fresh draw of the second state.
#[test]
fn a_redraw_leaves_nothing_of_the_frame_before() {
    let mut a = opened();
    a.focus = Zone::Task;
    let mut t = Terminal::new(TestBackend::new(120, 34)).unwrap();
    t.draw(|f| {
        draw::draw(f, &a);
    })
    .unwrap();
    // the queue and the ask go, the side pane opens, the selection moves: most lines shrink or shift
    a.open.as_mut().unwrap().ops(vec![wisp_protocol::EntityOp {
        topic: wisp_protocol::Topic::parse("session:t2").unwrap(),
        e: "session".into(),
        id: "t2".into(),
        change: wisp_protocol::Change::Upsert { v: json!({ "id": "t2", "title": "Add dark mode", "state": "review", "cwd": "/w/api" }) },
    }]);
    a.side = Some(super::app::Side::Files);
    a.toast("Saved", false);
    t.draw(|f| {
        draw::draw(f, &a);
    })
    .unwrap();
    let mut fresh = Terminal::new(TestBackend::new(120, 34)).unwrap();
    fresh.draw(|f| {
        draw::draw(f, &a);
    })
    .unwrap();
    assert_eq!(t.backend().buffer(), fresh.backend().buffer(), "every cell of the second frame is the second frame's");
    let text: String = (0..34).map(|y| (0..120).map(|x| t.backend().buffer()[(x, y)].symbol().to_owned()).collect::<String>()).collect();
    assert!(!text.contains("toggle"), "the queue that went is gone");
}

fn blame_answer() -> Value {
    json!({ "target": "src/auth.ts", "kind": "file", "byLine": [
        { "n": 1, "text": "import { session } from './session';", "task": "01a1bc12ab34", "title": "Fix the login", "why": "Sessions expire too soon; make them last an hour.", "commit": "a8c8f27e01b2" },
        { "n": 2, "text": "export const ttl = 3600;", "task": "01a1bc12ab34", "title": "Fix the login", "why": "Sessions expire too soon; make them last an hour.", "commit": "a8c8f27e01b2" },
        { "n": 3, "text": "// tuned by hand", "task": null, "commit": "77aa01bb02cc" },
        { "n": 4, "text": "export function login() {}", "task": "02b2cd", "title": "Add dark mode", "why": "Dark mode everywhere", "commit": "c3d4e5f6a7b8" }
    ] })
}

/// The repo-history blame (a plugin's own `tui/` crate, wisp-history-tui): `g b` asks for a file, then shows each
/// line beside the task that wrote it; `A` asks for another.
#[test]
fn the_blame_view_asks_for_a_file_then_shows_the_why_gutter() {
    let mut a = opened();
    a.focus = Zone::List;
    assert_eq!(a.key(ch('g')), vec![]);
    assert_eq!(a.key(ch('b')), vec![], "nothing loads before the file is named");
    assert!(matches!(&a.overlay, Some(Overlay::Ask(v, label, _)) if v == "blame" && label == "File"));
    for c in "src/auth.ts".chars() {
        a.key(ch(c));
    }
    let fx = a.key(key(KeyCode::Enter));
    assert_eq!(fx, vec![Effect::Cmd { id: "history.blame".into(), args: json!({ "target": "src/auth.ts", "repo": "/w/api", "byLine": true }), then: Then::View("blame".into()) }]);
    a.done(Then::View("blame".into()), Ok(blame_answer()));
    let s = screen(&a, 160, 45);
    assert!(s.contains("Fix the login") && s.contains("by hand") && s.contains("export const ttl = 3600;"), "{s}");
    assert!(s.contains("Sessions expire too soon"), "the selected line's task: what it was asked\n{s}");
    assert_eq!(s.matches("Fix the login").count(), 3, "the gutter names a run once (and the detail, and the sidebar, once)\n{s}");
    a.key(ch('A'));
    assert!(matches!(&a.overlay, Some(Overlay::Ask(_, _, t)) if t == "src/auth.ts"), "A asks again, with the last answer");
    a.key(key(KeyCode::Esc));
    assert_eq!(a.screen.as_deref(), Some("blame"), "Esc keeps the file shown");
}

/// The plugins' points are real: wisp.goal's own tui crate puts its input in the task header, and
/// wisp.history's adds a view, through the same registry the built-ins use.
#[test]
fn plugins_contribute_through_the_tui_points() {
    let a = opened();
    let s = screen(&a, 160, 45);
    assert!(s.contains("○ goal: judging · round 1"), "wisp-goal-tui's TaskHeader input\n{s}");
    assert!(a.reg.find("blame").is_some(), "wisp-history-tui's view");
    assert!(!a.reg.blocks.is_empty(), "the built-in term.block renderer");
}
