// QA driver, only with `--features qa`: there's no WebDriver for WKWebView, so qa/desktop-tauri.mjs
// asks this over a local socket (WISP_QA_PORT), one JSON line each way. It reads the real window
// and sends real AppKit events through NSApp, so key equivalents take the same road as a keyboard's.

use objc2::runtime::AnyObject;
use objc2::msg_send;
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow, NSWindowButton};
use objc2_foundation::{MainThreadMarker, NSPoint, NSString};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Url};

pub const INIT: &str = "window.__qaErrors = []; addEventListener('error', (e) => __qaErrors.push(String(e.message))); addEventListener('unhandledrejection', (e) => __qaErrors.push(String(e.reason))); { const c = console.error; console.error = (...a) => (__qaErrors.push(a.join(' ')), c(...a)); }";

// Into the run's own folder, not this computer's ~/Downloads.
pub fn download_to(event: tauri::webview::DownloadEvent<'_>) {
  if let (tauri::webview::DownloadEvent::Requested { destination, .. }, Some(dir)) = (event, std::env::var_os("WISP_QA_DOWNLOADS")) {
    let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_default();
    *destination = std::path::PathBuf::from(dir).join(name);
  }
}

pub static REAL_PICKER: AtomicBool = AtomicBool::new(false);
pub static DRAGS: AtomicU32 = AtomicU32::new(0);
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn note_opened(url: &Url) -> bool {
  OPENED.lock().unwrap().push(url.to_string());
  true
}

pub fn listen(app: AppHandle) {
  let Ok(port) = std::env::var("WISP_QA_PORT") else { return };
  let port = port.parse::<u16>().expect("WISP_QA_PORT");
  std::thread::spawn(move || {
    // A relaunch starts while the old process is still on its way out.
    let listener = (0..100).find_map(|_| TcpListener::bind(("127.0.0.1", port)).inspect_err(|_| std::thread::sleep(std::time::Duration::from_millis(100))).ok()).expect("the QA port");
    for stream in listener.incoming().flatten() {
      let app = app.clone();
      std::thread::spawn(move || {
        let mut out = stream.try_clone().expect("socket");
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
          let answer = serde_json::from_str(&line).map(|v| handle(&app, &v)).unwrap_or_else(|e| json!({ "error": e.to_string() }));
          if writeln!(out, "{answer}").is_err() {
            return;
          }
        }
      });
    }
  });
}

fn main_thread<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(MainThreadMarker) -> T + Send + 'static) -> T {
  let (tx, rx) = mpsc::channel();
  app
    .run_on_main_thread(move || {
      let _ = tx.send(f(MainThreadMarker::new().expect("main thread")));
    })
    .expect("main thread");
  rx.recv().expect("an answer")
}

fn ns_window(w: &tauri::WebviewWindow) -> usize {
  w.ns_window().expect("ns window") as usize
}

fn handle(app: &AppHandle, q: &Value) -> Value {
  let Some(w) = app.get_webview_window("main") else { return json!({ "error": "no window yet" }) };
  let str_of = |k: &str| q[k].as_str().unwrap_or_default().to_string();
  match q["op"].as_str().unwrap_or_default() {
    "eval" => {
      let (tx, rx) = mpsc::channel();
      let _ = w.eval_with_callback(str_of("js"), move |r| {
        let _ = tx.send(r);
      });
      json!({ "result": rx.recv_timeout(std::time::Duration::from_secs(20)).ok() })
    }
    "window" => {
      let scale = w.scale_factor().unwrap_or(1.0);
      let size = w.inner_size().map(|s| s.to_logical::<f64>(scale)).ok();
      let ptr = ns_window(&w);
      let (number, min, inner_title) = main_thread(app, move |_| unsafe {
        let n = &*(ptr as *const NSWindow);
        (n.windowNumber(), n.minSize(), n.title().to_string())
      });
      json!({
        "minimized": w.is_minimized().ok(), "title": w.title().ok(), "nsTitle": inner_title, "visible": w.is_visible().ok(), "focused": w.is_focused().ok(), "maximized": w.is_maximized().ok(),
        "width": size.map(|s| s.width), "height": size.map(|s| s.height), "minWidth": min.width, "minHeight": min.height, "number": number, "url": w.url().ok().map(|u| u.to_string()),
      })
    }
    "lights" => {
      let ptr = ns_window(&w);
      main_thread(app, move |_| unsafe {
        let n = &*(ptr as *const NSWindow);
        let height = n.frame().size.height;
        let of = |b: NSWindowButton| {
          n.standardWindowButton(b).map(|b| {
            let f = b.convertRect_toView(b.bounds(), None);
            json!({ "x": f.origin.x, "y": height - f.origin.y - f.size.height, "w": f.size.width, "h": f.size.height })
          })
        };
        json!({ "close": of(NSWindowButton::CloseButton), "min": of(NSWindowButton::MiniaturizeButton), "zoom": of(NSWindowButton::ZoomButton) })
      })
    }
    "badge" => main_thread(app, |mtm| json!({ "badge": NSApplication::sharedApplication(mtm).dockTile().badgeLabel().map(|s| s.to_string()) })),
    "real-picker" => {
      REAL_PICKER.store(true, Ordering::SeqCst);
      json!({ "ok": true })
    }
    // The open panel on the window: its button, and Cancel.
    "sheet" => {
      let ptr = ns_window(&w);
      main_thread(app, move |_| unsafe {
        let n = &*(ptr as *const NSWindow);
        let Some(sheet) = n.attachedSheet() else { return json!({ "prompt": null }) };
        let prompt: Option<objc2::rc::Retained<NSString>> = msg_send![&*sheet, prompt];
        let _: () = msg_send![&*sheet, cancel: std::ptr::null::<AnyObject>()];
        json!({ "prompt": prompt.map(|p| p.to_string()) })
      })
    }
    "minimize" => json!({ "ok": w.minimize().is_ok() }),
    "inspectable" => {
      let (tx, rx) = mpsc::channel();
      let _ = w.with_webview(move |wv| unsafe {
        let view: &AnyObject = &*wv.inner().cast();
        let config: *mut AnyObject = msg_send![view, configuration];
        let prefs: *mut AnyObject = msg_send![config, preferences];
        let key = NSString::from_str("developerExtrasEnabled");
        let on: *mut AnyObject = msg_send![prefs, valueForKey: &*key];
        let _ = tx.send(!on.is_null() && { let b: bool = msg_send![on, boolValue]; b });
      });
      json!({ "inspectable": rx.recv_timeout(std::time::Duration::from_secs(5)).ok() })
    }
    "drags" => json!({ "drags": DRAGS.load(Ordering::SeqCst) }),
    "opened" => json!({ "opened": *OPENED.lock().unwrap() }),
    "menu" => main_thread(app, |mtm| {
      let app = NSApplication::sharedApplication(mtm);
      let bar = app.mainMenu().expect("a menu");
      let tops: Vec<Value> = bar.itemArray().iter().map(|top| {
        let items: Vec<String> = top.submenu().map(|m| m.itemArray().iter().filter(|i| !i.isHidden() && !i.isAlternate()).map(|i| i.title().to_string()).collect()).unwrap_or_default();
        json!({ "title": top.title().to_string(), "items": items })
      }).collect();
      json!({ "menu": tops })
    }),
    // A key through NSApp: the menu's key equivalents first, then the page.
    "key" => {
      let (chars, code, mods, ptr) = (str_of("chars"), q["code"].as_u64().unwrap_or(0) as u16, q["mods"].as_u64().unwrap_or(0) as usize, ns_window(&w));
      let up = q["up"].as_bool().unwrap_or(true);
      main_thread(app, move |mtm| unsafe {
        let n = &*(ptr as *const NSWindow);
        let app = NSApplication::sharedApplication(mtm);
        let s = NSString::from_str(&chars);
        let event = |kind| NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(kind, NSPoint::new(0.0, 0.0), NSEventModifierFlags(mods), 0.0, n.windowNumber(), None, &s, &s, false, code);
        // Posted, not sent: sendEvent from in here would run inside the event loop's own callback.
        if let Some(e) = event(NSEventType::KeyDown) { app.postEvent_atStart(&e, false); }
        if up { if let Some(e) = event(NSEventType::KeyUp) { app.postEvent_atStart(&e, false); } }
      });
      json!({ "ok": true })
    }
    // A left click at (x, y) in window points, from the top. `drag` moves by (dx, dy) while it's down.
    "mouse" => {
      let (x, y, clicks, ptr) = (q["x"].as_f64().unwrap_or(0.0), q["y"].as_f64().unwrap_or(0.0), q["clicks"].as_i64().unwrap_or(1) as isize, ns_window(&w));
      let (dx, dy) = (q["dx"].as_f64().unwrap_or(0.0), q["dy"].as_f64().unwrap_or(0.0));
      // A pause while it's down, as a hand has: the drag starts from the page, over IPC.
      let post = move |app: &AppHandle, kind: NSEventType, to: (f64, f64)| {
        main_thread(app, move |mtm| unsafe {
          let n = &*(ptr as *const NSWindow);
          let at = NSPoint::new(to.0, n.frame().size.height - to.1);
          let e = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind, at, NSEventModifierFlags(0), 0.0, n.windowNumber(), None, 0, clicks, 1.0);
          if let Some(e) = e {
            NSApplication::sharedApplication(mtm).postEvent_atStart(&e, false);
          }
        })
      };
      post(app, NSEventType::LeftMouseDown, (x, y));
      std::thread::sleep(std::time::Duration::from_millis(250));
      if dx != 0.0 || dy != 0.0 {
        post(app, NSEventType::LeftMouseDragged, (x + dx, y + dy));
      }
      post(app, NSEventType::LeftMouseUp, (x + dx, y + dy));
      json!({ "ok": true })
    }
    "frame" => {
      let ptr = ns_window(&w);
      main_thread(app, move |_| unsafe {
        let f = (&*(ptr as *const NSWindow)).frame();
        json!({ "x": f.origin.x, "y": f.origin.y, "w": f.size.width, "h": f.size.height })
      })
    }
    "resize" => {
      let _ = w.set_size(tauri::LogicalSize::new(q["width"].as_f64().unwrap_or(1380.0), q["height"].as_f64().unwrap_or(900.0)));
      json!({ "ok": true })
    }
    "shot" => {
      let path = str_of("path");
      let (tx, rx) = mpsc::channel::<bool>();
      let _ = w.with_webview(move |wv| unsafe {
        let view: &AnyObject = &*wv.inner().cast();
        let tx2 = tx.clone();
        let done = block2::RcBlock::new(move |image: *mut objc2_app_kit::NSImage, _err: *mut AnyObject| {
          let ok = image.as_ref().map(|image| {
            let tiff = image.TIFFRepresentation().expect("tiff");
            std::fs::write(&path, tiff.to_vec()).is_ok()
          });
          let _ = tx2.send(ok.unwrap_or(false));
        });
        let none: *const AnyObject = std::ptr::null();
        let _: () = msg_send![view, takeSnapshotWithConfiguration: none, completionHandler: &*done];
      });
      json!({ "ok": rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(false) })
    }
    "theme" => {
      let dark = q["dark"].as_bool();
      let _ = w.set_theme(dark.map(|d| if d { tauri::Theme::Dark } else { tauri::Theme::Light }));
      json!({ "ok": true })
    }
    "activate" => main_thread(app, |mtm| {
      #[allow(deprecated)]
      NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
      json!({ "ok": true })
    }),
    "close" => {
      let _ = w.close();
      json!({ "ok": true })
    }
    op => json!({ "error": format!("no op {op}") }),
  }
}
