//! `wisp tui` (ADR-0024, docs/v2-tui-design.md): wisp full-screen in the terminal, a client of the sync protocol like
//! the CLI and the phone, mirroring the GUI. Three zones (the tasks in the GUI's sections, the open task's live
//! transcript, a side pane of changes / files / terminal / setup), a composer with `@` and `/` pickers and the
//! follow-up queue, a status bar, a palette (Ctrl-K), a `?` help generated from the keymap, the mouse, and views
//! (crew, automations, machines, My Stuff, settings, repo history) that are `tui.view@1` tables.
//!
//! The shell is pure and tested on ratatui's test backend: [`app::App`] (state, keys → effects), [`draw::draw`].
//! [`run`] wires them to the terminal (an input thread, a 60 fps redraw cap), the sync stream (the list topic and
//! the open task's topic, nothing polled) and the commands (each in its own task, so no key waits on the network).

pub mod app;
pub mod composer;
pub mod draw;
pub mod keys;
pub mod model;
pub mod palette;
pub mod views;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ratatui::crossterm::event::{self, Event, KeyEventKind};
use ratatui::crossterm::execute;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::attach::{Conn, Got};
use crate::client::{CliError, Client, Result};
use app::{App, Effect, Then};

/// What the input thread hands over.
enum Input {
    Key(event::KeyEvent),
    Mouse(event::MouseEvent),
    Paste(String),
    Resize,
}

/// The terminal's events, read on their own thread (so a slow command never eats a key); paused while
/// `$EDITOR` has the terminal.
fn input_thread(tx: mpsc::Sender<Input>, paused: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        loop {
            if paused.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(30));
                continue;
            }
            if !event::poll(Duration::from_millis(30)).unwrap_or(false) {
                continue;
            }
            let Ok(ev) = event::read() else { return };
            let msg = match ev {
                Event::Key(k) if k.kind != KeyEventKind::Release => Input::Key(k),
                Event::Mouse(m) => Input::Mouse(m),
                Event::Paste(p) => Input::Paste(p),
                Event::Resize(..) => Input::Resize,
                _ => continue,
            };
            if tx.blocking_send(msg).is_err() {
                return;
            }
        }
    });
}

/// An attachment as runtime takes it, from a pasted path.
fn attachment(path: &str) -> Value {
    let p = std::path::Path::new(path);
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    let size = std::fs::metadata(p).map_or(0, |m| m.len());
    json!({ "id": name, "name": name, "mime": mime, "size": size, "path": path })
}

/// The command a send makes, and what its answer does.
fn send_cmd(task: Option<String>, text: &str, attachments: &[String], mode: app::Mode, queue: bool, local: String, cwd: &str) -> (String, Value, Then) {
    let att: Vec<Value> = attachments.iter().map(|a| attachment(a)).collect();
    match task {
        None => ("runtime.create".into(), json!({ "prompt": text, "cwd": cwd, "mode": mode.wire(), "attachments": att }), Then::Created(local)),
        Some(id) => ("runtime.followUp".into(), json!({ "id": id, "text": text, "queue": queue, "mode": mode.wire(), "attachments": att }), Then::Sent(local)),
    }
}

/// `$EDITOR` on the composer's text; the terminal is handed over and back.
fn editor(text: &str, paused: &AtomicBool) -> Option<String> {
    let path = std::env::temp_dir().join(format!("wisp-tui-{}.md", std::process::id()));
    std::fs::write(&path, text).ok()?;
    paused.store(true, Ordering::Relaxed);
    ratatui::restore();
    let ed = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "vi".into());
    let mut parts = ed.split_whitespace();
    let ok = parts.next().is_some_and(|bin| std::process::Command::new(bin).args(parts).arg(&path).status().is_ok_and(|s| s.success()));
    let _ = ratatui::init();
    let _ = execute!(std::io::stdout(), event::EnableMouseCapture, event::EnableBracketedPaste);
    paused.store(false, Ordering::Relaxed);
    let out = ok.then(|| std::fs::read_to_string(&path).ok()).flatten();
    let _ = std::fs::remove_file(&path);
    out
}

/// `wisp tui`.
pub async fn run(c: &Client, cwd: &str) -> Result<i32> {
    let th = wisp_tui_api::theme::from_env(&|k| std::env::var(k).ok());
    let mut app = App::new(views::registry(), th, cwd);
    let mut list = Conn::new(c, &[wisp_runtime_api::TOPIC_LIST.to_owned()]);
    let first = list.start().await?;
    fold_list(&mut app, first);
    let mut task: Option<Conn> = None;
    let (done_tx, mut done) = mpsc::channel::<(Then, std::result::Result<Value, String>)>(64);
    let fx = app.listed(&[]);
    // the catalogue for the palette and the `/` menu, the settings for the palette
    let mut pending = fx;
    pending.push(Effect::Cmd { id: "cli.catalogue".into(), args: json!({}), then: Then::Catalogue });
    let (tx, mut inputs) = mpsc::channel::<Input>(64);
    let paused = Arc::new(AtomicBool::new(false));
    input_thread(tx, paused.clone());
    let mut term = start_screen(&mut app);
    let mut frame = tokio::time::interval(Duration::from_millis(16));
    frame.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut dirty = true;
    let out: Result<i32> = 'run: loop {
        for e in std::mem::take(&mut pending) {
            match e {
                Effect::Quit => break 'run Ok(0),
                Effect::Watch(id) => task = watch(c, &mut app, id).await,
                Effect::Cmd { id, args, then } => {
                    let (c, tx) = (c.clone(), done_tx.clone());
                    tokio::spawn(async move {
                        let r = c.cmd(&id, args).await.map_err(|e| e.to_string());
                        let _ = tx.send((then, r)).await;
                    });
                }
                Effect::Send { task: t, text, attachments, mode, queue, local } => {
                    let (id, args, then) = send_cmd(t, &text, &attachments, mode, queue, local, cwd);
                    pending.push(Effect::Cmd { id, args, then });
                }
                Effect::Files => {
                    let (dir, tx) = (cwd.to_owned(), done_tx.clone());
                    tokio::spawn(async move {
                        let out = tokio::process::Command::new("git").args(["ls-files", "--cached", "--others", "--exclude-standard"]).current_dir(dir).output().await;
                        let files: Vec<Value> = out.map(|o| String::from_utf8_lossy(&o.stdout).lines().take(20_000).map(|l| Value::String(l.to_owned())).collect()).unwrap_or_default();
                        let _ = tx.send((Then::Mentions("file".into()), Ok(Value::Array(files)))).await;
                    });
                }
                Effect::Editor(text) => {
                    if let Some(t) = editor(&text, &paused) {
                        app.edited(&t);
                    }
                    let _ = term.clear();
                }
            }
            dirty = true;
        }
        if !pending.is_empty() {
            continue;
        }
        tokio::select! {
            i = inputs.recv() => {
                let Some(i) = i else { break Ok(0) };
                pending = match i {
                    Input::Key(k) => app.key(k),
                    Input::Mouse(m) => app.mouse(m),
                    Input::Paste(p) => { app.paste(&p); Vec::new() }
                    Input::Resize => Vec::new(),
                };
                dirty = true;
            }
            got = list.next() => match got {
                Ok(got) => {
                    let changed = fold_list(&mut app, got);
                    pending = app.listed(&changed);
                    app.online = !list.reconnecting();
                    dirty = true;
                }
                Err(e) => break Err(e),
            },
            got = async { match task.as_mut() { Some(t) => t.next().await, None => std::future::pending().await } } => match got {
                Ok(got) => { fold_task(&mut app, got); dirty = true; }
                Err(e) => { app.toast(e.to_string(), true); task = None; }
            },
            d = done.recv() => if let Some((then, r)) = d {
                pending = app.done(then, r);
                dirty = true;
            },
            _ = frame.tick() => {
                if ticked(&mut app) || dirty {
                    if let Err(e) = paint(&mut term, &mut app) {
                        break Err(e);
                    }
                    dirty = false;
                }
            }
        }
    };
    let _ = execute!(std::io::stdout(), event::DisableMouseCapture, event::DisableBracketedPaste);
    ratatui::restore();
    out
}

/// The terminal, full-screen, on a clean screen (what the shell printed before never shows through a cell the TUI
/// draws), with the mouse and bracketed paste on, and the glyphs it can show.
fn start_screen(app: &mut App) -> ratatui::DefaultTerminal {
    let mut term = ratatui::init();
    let _ = term.clear();
    let _ = execute!(std::io::stdout(), event::EnableMouseCapture, event::EnableBracketedPaste);
    app.ascii = std::env::var("TERM").is_ok_and(|t| t == "dumb");
    term
}

/// A frame went by: the clock and the spinners move. → whether something animates (a redraw is due anyway).
fn ticked(app: &mut App) -> bool {
    app.frame();
    app.now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
    // and once a minute, so the list's "5m" ages while nothing happens
    app.tick.is_multiple_of(3750) || app.running() || !app.toasts.is_empty() || app.tasks.rows.values().any(|t| matches!(model::s(t, "state"), "running" | "starting"))
}

/// The open task's topic, watched (a task still being created has none yet).
async fn watch(c: &Client, app: &mut App, id: Option<String>) -> Option<Conn> {
    let id = id.filter(|id| !id.starts_with("local-"))?;
    let mut conn = Conn::new(c, &[wisp_runtime_api::session_topic(&id)]);
    match conn.start().await {
        Ok(got) => fold_task(app, got),
        Err(e) => app.toast(e.to_string(), true),
    }
    Some(conn)
}

/// One frame (ratatui diffs it against the last, so only what changed is written).
fn paint(term: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<()> {
    let mut hit = None;
    term.draw(|f| hit = Some(draw::draw(f, app))).map_err(|e| CliError::said(format!("the terminal: {e}")))?;
    if let Some(h) = hit {
        app.hit = h;
    }
    Ok(())
}

fn fold_list(app: &mut App, got: Vec<Got>) -> Vec<String> {
    let mut changed = Vec::new();
    for g in got {
        changed.extend(match g {
            Got::Snapshot(rows) => app.tasks.fold(Some(rows), Vec::new()),
            Got::Ops(ops) => app.tasks.fold(None, ops),
        });
    }
    changed
}

fn fold_task(app: &mut App, got: Vec<Got>) {
    let Some(t) = app.open.as_mut() else { return };
    for g in got {
        match g {
            Got::Snapshot(rows) => t.snapshot(rows),
            Got::Ops(ops) => t.ops(ops),
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
