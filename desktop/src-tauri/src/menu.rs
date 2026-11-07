// app, File, Edit, View, Window, the standard roles. On macOS the Edit menu isn't decoration:
// without it ⌘C ⌘V ⌘A ⌘Z don't reach the prompt box.

use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

const WINDOW_MENU: &str = "window";
static ZOOM: AtomicU32 = AtomicU32::new(100);

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
  let item = |id: &str, label: &str, keys: &str| MenuItem::with_id(app, id, label, true, Some(keys));
  let line = || PredefinedMenuItem::separator(app);
  let menu = Menu::new(app)?;

  #[cfg(target_os = "macos")]
  menu.append(&Submenu::with_items(app, "wisp", true, &[
    &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
    &line()?,
    &PredefinedMenuItem::services(app, None)?,
    &line()?,
    &PredefinedMenuItem::hide(app, None)?,
    &PredefinedMenuItem::hide_others(app, None)?,
    &PredefinedMenuItem::show_all(app, None)?,
    &line()?,
    &PredefinedMenuItem::quit(app, None)?,
  ])?)?;

  let file = Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::close_window(app, None)?])?;
  #[cfg(not(target_os = "macos"))]
  file.append(&PredefinedMenuItem::quit(app, None)?)?;
  menu.append(&file)?;

  menu.append(&Submenu::with_items(app, "Edit", true, &[
    &PredefinedMenuItem::undo(app, None)?,
    &PredefinedMenuItem::redo(app, None)?,
    &line()?,
    &PredefinedMenuItem::cut(app, None)?,
    &PredefinedMenuItem::copy(app, None)?,
    &PredefinedMenuItem::paste(app, None)?,
    &PredefinedMenuItem::select_all(app, None)?,
  ])?)?;

  let view = Submenu::with_items(app, "View", true, &[
    &item("reload", "Reload", "CmdOrCtrl+R")?,
    &item("force-reload", "Force Reload", "CmdOrCtrl+Shift+R")?,
    &line()?,
    &item("zoom-reset", "Actual Size", "CmdOrCtrl+0")?,
    &item("zoom-in", "Zoom In", "CmdOrCtrl+=")?,
    &item("zoom-out", "Zoom Out", "CmdOrCtrl+-")?,
    &line()?,
  ])?;
  #[cfg(target_os = "macos")]
  view.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
  // Elsewhere that one stays greyed out.
  #[cfg(not(target_os = "macos"))]
  view.append(&item("fullscreen", "Toggle Full Screen", "F11")?)?;
  // Debug builds only: a release has no inspector, so no Inspect Element either.
  if cfg!(debug_assertions) {
    view.insert(&item("devtools", "Toggle Developer Tools", "Alt+CmdOrCtrl+I")?, 2)?;
  }
  menu.append(&view)?;

  let window = Submenu::with_id_and_items(app, WINDOW_MENU, "Window", true, &[
    &PredefinedMenuItem::minimize(app, None)?,
    &PredefinedMenuItem::maximize(app, None)?,
  ])?;
  #[cfg(target_os = "macos")]
  window.set_as_windows_menu_for_nsapp()?;
  menu.append(&window)?;
  Ok(menu)
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
  run(app, event.id().as_ref());
}

// Also the keys a page can't hand to the menu on Windows (src/windows.rs).
pub fn run<R: Runtime>(app: &AppHandle<R>, id: &str) {
  let Some(w) = app.get_webview_window("main") else { return };
  let zoom = |to: u32| {
    ZOOM.store(to, Ordering::Relaxed);
    let _ = w.set_zoom(f64::from(to) / 100.0);
  };
  let now = ZOOM.load(Ordering::Relaxed);
  match id {
    "reload" | "force-reload" => drop(w.reload()),
    "zoom-reset" => zoom(100),
    "zoom-in" => zoom((now + 10).min(300)),
    "zoom-out" => zoom(now.saturating_sub(10).max(50)),
    "fullscreen" => drop(w.set_fullscreen(!w.is_fullscreen().unwrap_or(false))),
    "minimize" => drop(w.minimize()),
    #[cfg(debug_assertions)]
    "devtools" => if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() },
    _ => {}
  }
}
