// wisp desktop shell on Tauri. As in electron/main.js the window loads the same page the browser
// mode serves. Electron's main process is Node; Tauri has none, so the unchanged server runs as a
// child on a real Node binary (desktop/entry.mjs, src/server.rs). Logic lives there, not here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod notify;
#[cfg(all(feature = "qa", target_os = "macos"))]
mod qa;
mod server;
#[cfg(windows)]
mod windows;

use server::Server;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const INIT: &str = include_str!("init.js");
const CAPABILITY: &str = include_str!("../capability.json");
const DEFAULT_PORT: u16 = 4477;
const WIDTH: f64 = 1380.0;
const HEIGHT: f64 = 900.0;

fn port() -> u16 {
  std::env::var("WISP_PORT").ok().and_then(|p| p.parse().ok()).filter(|p| *p > 0).unwrap_or(DEFAULT_PORT)
}

fn base(port: u16) -> Url {
  Url::parse(&format!("http://localhost:{port}")).expect("a valid url")
}

fn is_wisp(url: &Url, base: &Url) -> bool {
  url.origin() == base.origin()
}

// WebKitGTK doesn't say which frame a navigation is for, and wry's on_navigation hears them all, so
// on Linux a Preview tab moving on its own would be thrown out to the browser and blocked. Windows
// asks for the main frame only, macOS is handled in macos.rs. Not to be shipped until this is solved
// and seen on a real desktop: qa/scenarios/desktop.md, Linux. cargo check stays open for CI.
#[cfg(all(target_os = "linux", not(debug_assertions)))]
compile_error!("wisp's Tauri shell can't ship on Linux yet: on_navigation can't tell a subframe from the page");

// Editor links (vscode://…), docs links etc. open outside the app. Never a local file or a page-made
// URL: the page is agents' output as much as ours.
fn open_outside(app: &AppHandle, url: &Url) {
  if matches!(url.scheme(), "about" | "blob" | "data" | "file" | "javascript") {
    return;
  }
  #[cfg(all(feature = "qa", target_os = "macos"))]
  if qa::note_opened(url) {
    return;
  }
  let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

fn show(app: &AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn background(theme: Theme) -> tauri::webview::Color {
  match theme {
    Theme::Dark => tauri::webview::Color(0x11, 0x11, 0x11, 0xff),
    _ => tauri::webview::Color(0xff, 0xff, 0xff, 0xff),
  }
}

// A WKWebView's document.hasFocus() stays true with another app in front (src/init.js). WebView2's is
// right, and fires its own focus and blur: telling it too would fire them twice.
fn tell_focus(w: &WebviewWindow, on: bool) {
  if cfg!(windows) {
    return;
  }
  let _ = w.eval(format!("dispatchEvent(new CustomEvent('wisp-window-focus', {{ detail: {on} }}))"));
}

fn open_window(app: &AppHandle, port: u16) -> tauri::Result<()> {
  let home = base(port);
  let (nav, popup, inside_nav, inside_popup) = (app.clone(), app.clone(), home.clone(), home.clone());
  let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(home))
    .title("wisp")
    .inner_size(WIDTH, HEIGHT)
    .min_inner_size(720.0, 520.0)
    .visible(false)
    .disable_drag_drop_handler() // the page has its own: attachments, task list and reorder
    .initialization_script(INIT)
    // WebKit stops painting and slows timers in a covered or hidden window. Agents run on in there:
    // the badge and the list have to keep up, and a window brought forward has to be current.
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    // Previews and sandboxed frames never get here on macOS (macos::keep_frames_in_place).
    .on_navigation(move |url| {
      #[cfg(feature = "qa")]
      if std::env::var_os("WISP_QA_ANY_NAV").is_some() {
        return true;
      }
      let stay = is_wisp(url, &inside_nav) || url.scheme() == "about";
      if !stay {
        open_outside(&nav, url);
      }
      stay
    })
    .on_new_window(move |url, _| {
      if is_wisp(&url, &inside_popup) {
        return NewWindowResponse::Allow;
      }
      open_outside(&popup, &url);
      NewWindowResponse::Deny
    })
    // The page title carries the "needs you" count: "(3) wisp" → dock or taskbar badge. The window keeps `wisp`.
    .on_document_title_changed(|w, title| {
      let count = title.strip_prefix('(').and_then(|t| t.split(')').next()).and_then(|n| n.parse::<i64>().ok()).filter(|n| *n > 0);
      #[cfg(windows)]
      windows::badge(&w, count);
      #[cfg(not(windows))]
      let _ = w.set_badge_count(count);
    })
    // Without this WebKit drops `<a download>`. Goes to ~/Downloads, under a free name.
    .on_download(|_, _event| {
      #[cfg(all(feature = "qa", target_os = "macos"))]
      qa::download_to(_event);
      true
    })
    .on_page_load(|w, load| {
      tell_focus(&w, w.is_focused().unwrap_or(true));
      // Once: a reload mustn't pull the app forward. show() alone leaves it behind other apps.
      if load.event() == PageLoadEvent::Finished && !w.is_visible().unwrap_or(true) {
        let _ = w.show();
        let _ = w.set_focus();
      }
    });
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .traffic_light_position(tauri::LogicalPosition::new(16.0, macos::traffic_light_inset(18.0)));
  #[cfg(all(feature = "qa", target_os = "macos"))]
  let builder = builder.initialization_script(qa::INIT);
  // WebView2 speaks CDP, but ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and its policy once wry
  // names arguments of its own: qa/desktop-tauri-win.mjs. These replace wry's, so they repeat them.
  #[cfg(all(feature = "qa", windows))]
  let builder = match std::env::var("WISP_QA_CDP") {
    Ok(port) => builder.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")),
    Err(_) => builder,
  };
  let window = builder.build()?;
  let _ = window.set_background_color(window.theme().ok().map(background));
  #[cfg(windows)]
  windows::place(&window, WIDTH, HEIGHT)?;
  #[cfg(windows)]
  windows::plain_menu(&window)?;
  #[cfg(windows)]
  windows::menu_keys(&window)?;
  #[cfg(target_os = "macos")]
  macos::keep_frames_in_place(&window)?;
  #[cfg(target_os = "macos")]
  macos::tab_reaches_links(&window)?;
  // A page that can't finish loading still needs a window to say so in.
  let late = window.clone();
  thread::spawn(move || {
    thread::sleep(Duration::from_secs(10));
    // Only then: show() takes the keys from whatever you've moved on to.
    if !late.is_visible().unwrap_or(true) {
      let _ = late.show();
    }
  });
  Ok(())
}

fn fail(app: &AppHandle, text: String) {
  eprintln!("[wisp] {text}");
  app.dialog().message(text).title("wisp can't start").kind(MessageDialogKind::Error).blocking_show();
  app.exit(1);
}

// Off the main thread: the server can take seconds, and the menu and dock stay alive meanwhile.
fn boot(app: AppHandle, port: u16) {
  if !server::answers(port, "/api/config") {
    // Not a wisp to attach to, so ours: quitting must leave a CLI wisp running (DESK-14).
    let root = match root(&app) {
      Some(root) => root,
      None => return fail(&app, "wisp's files aren't in this app.".into()),
    };
    let data = app.path().app_data_dir().unwrap_or_default();
    if let Err(err) = app.state::<Server>().start(&app, &node(&app), &root, &data, port) {
      return fail(&app, format!("Couldn't start Node: {err}"));
    }
    if !app.state::<Server>().wait_healthy(port) {
      return fail(&app, format!("wisp's server didn't answer on port {port}."));
    }
    app.state::<Server>().exit_with_it(app.clone());
  }
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || {
    if let Err(err) = open_window(&handle, port) {
      eprintln!("[wisp] no window: {err}");
      handle.exit(1);
    }
  });
}

// Tauri refuses resource_dir() on macOS when the app's path holds a symlink (a linked Applications
// folder, /tmp). The real path is as good: all this reads is the bundle the running binary is in.
// On Windows it's canonicalized, so \\?\C:\…: Node 22 can't run a script from such a path.
fn resources(app: &AppHandle) -> Option<PathBuf> {
  let beside = || std::env::current_exe().ok()?.canonicalize().ok()?.parent()?.join("../Resources").canonicalize().ok();
  let dir = app.path().resource_dir().ok().or_else(beside)?;
  Some(dir.to_str().and_then(|p| p.strip_prefix(r"\\?\")).filter(|p| !p.starts_with("UNC")).map_or_else(|| dir.clone(), PathBuf::from))
}

// WISP_* are for running from a checkout. A built app has both under its resources (the same
// Contents/Resources/app the updater looks for, server/update.js PACKAGED). On Windows the resource
// folder is the exe's, so there it's resources\app (desktop/scripts/package.mjs).
fn root(app: &AppHandle) -> Option<PathBuf> {
  let entry = |p: &PathBuf| p.join("desktop/entry.mjs").exists();
  let packaged = resources(app).map(|r| r.join(if cfg!(windows) { "resources/app" } else { "app" }));
  let checkout = cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
  std::env::var_os("WISP_ROOT").map(PathBuf::from).into_iter().chain(packaged).chain(checkout).find(entry)
}

fn node(app: &AppHandle) -> PathBuf {
  let name = if cfg!(windows) { "node/node.exe" } else { "node/bin/node" };
  let bundled = resources(app).map(|r| r.join(name)).filter(|p| p.exists());
  std::env::var_os("WISP_NODE").map(PathBuf::from).or(bundled).unwrap_or_else(|| "node".into())
}

#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<String> {
  #[cfg(all(feature = "qa", target_os = "macos"))]
  if let Some(path) = std::env::var("WISP_QA_PICK").ok().filter(|_| !qa::REAL_PICKER.load(std::sync::atomic::Ordering::SeqCst)) {
    return Some(path);
  }
  #[cfg(target_os = "macos")]
  return macos::pick_folder(&window);
  #[cfg(not(target_os = "macos"))]
  return window.dialog().file().set_parent(&window).set_title("Add project").blocking_pick_folder().map(|p| p.to_string());
}

#[tauri::command]
fn start_drag(window: WebviewWindow) {
  #[cfg(all(feature = "qa", target_os = "macos"))]
  qa::DRAGS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
  let _ = window.start_dragging();
}

#[tauri::command]
fn zoom_window(window: WebviewWindow) {
  #[cfg(target_os = "macos")]
  match macos::double_click_action().as_str() {
    "Minimize" => return drop(window.minimize()),
    "None" => return,
    _ => {}
  }
  let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
}

fn main() {
  #[cfg(target_os = "macos")]
  macos::be_node_for_electron();
  let port = port();
  let app = tauri::Builder::default()
    // First: a second launch must stop here, before it starts anything.
    .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .manage(Server::default())
    .invoke_handler(tauri::generate_handler![pick_folder, start_drag, zoom_window, notify::notify_show])
    .menu(menu::build)
    .on_menu_event(menu::on_event)
    .on_window_event(|window, event| match event {
      // Agents keep running with the window closed on macOS; elsewhere closing it quits.
      #[cfg(target_os = "macos")]
      WindowEvent::CloseRequested { api, .. } => {
        api.prevent_close();
        macos::leave_fullscreen_and_hide(window);
      }
      WindowEvent::Focused(on) => {
        if let Some(w) = window.app_handle().get_webview_window(window.label()) {
          tell_focus(&w, *on);
        }
      }
      WindowEvent::ThemeChanged(theme) => {
        if let Some(w) = window.app_handle().get_webview_window(window.label()) {
          let _ = w.set_background_color(Some(background(*theme)));
        }
      }
      _ => {}
    })
    .setup(move |app| {
      app.add_capability(CAPABILITY.replace("__PORT__", &port.to_string()))?;
      #[cfg(all(feature = "qa", target_os = "macos"))]
      qa::listen(app.handle().clone());
      notify::on_click(app.handle())?;
      let handle = app.handle().clone();
      thread::spawn(move || boot(handle, port));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("wisp's shell couldn't start");
  app.run(|app, event| match event {
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => show(app),
    // Every way out comes through here, ⌘Q included: quitting stops the agents, within a limit.
    RunEvent::Exit => {
      app.state::<Server>().stop();
      tauri_plugin_single_instance::destroy(app); // a relaunch mustn't find this one still here
    }
    _ => {}
  });
}
