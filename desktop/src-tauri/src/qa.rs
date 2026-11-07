// QA driver, only with `--features qa`: there's no WebDriver for WKWebView, so qa/desktop-tauri.mjs
// asks this over a local socket (WISP_QA_PORT), one JSON line each way. It reads the real window
// and sends real AppKit events through NSApp, so key equivalents take the same road as a keyboard's.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSMenuItem, NSWindow, NSWindowButton};
use objc2_foundation::{MainThreadMarker, NSArray, NSObject, NSPoint, NSString};
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

// WISP_QA_REAL_OPEN lets it go on to the real opener: a one-off, it starts this computer's editor.
pub fn note_opened(url: &Url) -> bool {
  OPENED.lock().unwrap().push(url.to_string());
  std::env::var_os("WISP_QA_REAL_OPEN").is_none()
}

struct DragIvars {
  pasteboard: Retained<NSObject>,
  location: NSPoint,
  window: usize,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "WispQaDrag"]
  #[ivars = DragIvars]
  struct QaDrag;

  impl QaDrag {
    #[unsafe(method(draggingPasteboard))]
    fn pasteboard(&self) -> *mut NSObject { Retained::as_ptr(&self.ivars().pasteboard) as *mut _ }
    #[unsafe(method(draggingLocation))]
    fn location(&self) -> NSPoint { self.ivars().location }
    #[unsafe(method(draggedImageLocation))]
    fn image_location(&self) -> NSPoint { self.ivars().location }
    #[unsafe(method(draggingDestinationWindow))]
    fn window(&self) -> *mut AnyObject { self.ivars().window as *mut AnyObject }
    #[unsafe(method(draggingSourceOperationMask))]
    fn mask(&self) -> usize { usize::MAX }
    #[unsafe(method(draggingSequenceNumber))]
    fn sequence(&self) -> isize { 1 }
    #[unsafe(method(draggingSource))]
    fn source(&self) -> *mut AnyObject { std::ptr::null_mut() }
    #[unsafe(method(numberOfValidItemsForDrop))]
    fn valid(&self) -> isize { 1 }
    #[unsafe(method(setNumberOfValidItemsForDrop:))]
    fn set_valid(&self, _n: isize) {}
    #[unsafe(method(animatesToDestination))]
    fn animates(&self) -> bool { false }
    #[unsafe(method(setAnimatesToDestination:))]
    fn set_animates(&self, _b: bool) {}
    #[unsafe(method(draggingFormation))]
    fn formation(&self) -> isize { 0 }
    #[unsafe(method(setDraggingFormation:))]
    fn set_formation(&self, _f: isize) {}
    #[unsafe(method(springLoadingHighlight))]
    fn highlight(&self) -> isize { 0 }
    #[unsafe(method(resetSpringLoading))]
    fn reset(&self) {}
    #[unsafe(method(enumerateDraggingItemsWithOptions:forView:classes:searchOptions:usingBlock:))]
    fn enumerate(&self, _o: usize, _v: *mut AnyObject, _c: *mut AnyObject, _s: *mut AnyObject, _b: *mut AnyObject) {}
  }
);

impl QaDrag {
  unsafe fn new(file: &str, location: NSPoint, window: usize) -> Retained<Self> {
    let pasteboard: Retained<NSObject> = msg_send![objc2::class!(NSPasteboard), pasteboardWithUniqueName];
    let kind = NSString::from_str("NSFilenamesPboardType");
    let kinds = NSArray::from_retained_slice(&[kind.clone()]);
    let none: *const AnyObject = std::ptr::null();
    let _: isize = msg_send![&*pasteboard, declareTypes: &*kinds, owner: none];
    let files = NSArray::from_retained_slice(&[NSString::from_str(file)]);
    let _: bool = msg_send![&*pasteboard, setPropertyList: &*files, forType: &*kind];
    let this = Self::alloc().set_ivars(DragIvars { pasteboard, location, window });
    msg_send![super(this), init]
  }
}

// What's in the menu AppKit last began tracking.
static MENU: Mutex<Option<Vec<String>>> = Mutex::new(None);

unsafe fn watch_menus() {
  static ONCE: std::sync::Once = std::sync::Once::new();
  ONCE.call_once(|| {
    let block = block2::RcBlock::new(|note: *mut AnyObject| {
      let menu: *mut AnyObject = msg_send![note, object];
      let items: Retained<NSArray<NSMenuItem>> = msg_send![menu, itemArray];
      *MENU.lock().unwrap() = Some(items.iter().filter(|i| !i.isHidden() && !i.isSeparatorItem()).map(|i| i.title().to_string()).collect());
    });
    let centre: *mut AnyObject = msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
    let name = NSString::from_str("NSMenuDidBeginTrackingNotification");
    let none: *const AnyObject = std::ptr::null();
    let _: *mut AnyObject = msg_send![centre, addObserverForName: &*name, object: none, queue: none, usingBlock: &*block];
    std::mem::forget(block);
  });
}

// None until the plugin has shown one: a bare debug binary has no bundle id, and macOS no center for it.
unsafe fn center() -> Option<Retained<AnyObject>> {
  msg_send![objc2::class!(NSUserNotificationCenter), defaultUserNotificationCenter]
}

unsafe fn delivered() -> Vec<Retained<AnyObject>> {
  center().map_or(vec![], |c| { let list: Retained<NSArray<AnyObject>> = msg_send![&*c, deliveredNotifications]; list.iter().collect() })
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
    // What macOS holds for this app, and what a click on a banner would do: AppKit calls the
    // delegate the plugin installed. The click itself is the one step this can't take.
    "delivered" => main_thread(app, |_| unsafe {
      let titles: Vec<String> = delivered().iter().map(|n| { let t: Retained<NSString> = msg_send![&**n, title]; t.to_string() }).collect();
      json!({ "delivered": titles })
    }),
    "notify-click" => {
      let title = str_of("title");
      main_thread(app, move |_| unsafe {
        let Some(note) = delivered().into_iter().find(|n| { let t: Retained<NSString> = msg_send![&**n, title]; t.to_string() == title }) else { return json!({ "error": "not delivered" }) };
        let Some(center) = center() else { return json!({ "error": "no center" }) };
        let delegate: *mut AnyObject = msg_send![&*center, delegate];
        if delegate.is_null() { return json!({ "error": "no delegate" }) }
        let one: Retained<AnyObject> = msg_send![objc2::class!(NSNumber), numberWithInteger: 1isize]; // ContentsClicked
        let key = NSString::from_str("activationType");
        let _: () = msg_send![&*note, setValue: &*one, forKey: &*key];
        let _: () = msg_send![delegate, userNotificationCenter: &*center, didActivateNotification: &*note];
        json!({ "ok": true })
      })
    }
    "clear-delivered" => main_thread(app, |_| unsafe {
      if let Some(c) = center() { let _: () = msg_send![&*c, removeAllDeliveredNotifications]; }
      json!({ "ok": true })
    }),
    // View's own items, through AppKit: the same action a click on them sends.
    "menu-click" => {
      let (top, item) = (str_of("top"), str_of("item"));
      main_thread(app, move |mtm| {
        let bar = NSApplication::sharedApplication(mtm).mainMenu().expect("a menu");
        let Some(menu) = bar.itemArray().iter().find(|t| t.title().to_string() == top).and_then(|t| t.submenu()) else { return json!({ "error": "no menu" }) };
        let Some(i) = menu.itemArray().iter().position(|t| t.title().to_string() == item) else { return json!({ "error": "no item" }) };
        menu.performActionForItemAtIndex(i as isize);
        json!({ "ok": true })
      })
    }
    #[cfg(debug_assertions)]
    "devtools" => json!({ "open": w.is_devtools_open() }),
    // A right click through NSApp. AppKit says what opened (`context-menu`); Escape closes it.
    "right-click" => {
      let (x, y, ptr) = (q["x"].as_f64().unwrap_or(0.0), q["y"].as_f64().unwrap_or(0.0), ns_window(&w));
      main_thread(app, move |mtm| unsafe {
        watch_menus();
        *MENU.lock().unwrap() = None;
        let n = &*(ptr as *const NSWindow);
        let at = NSPoint::new(x, n.frame().size.height - y);
        for kind in [NSEventType::RightMouseDown, NSEventType::RightMouseUp] {
          let e = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(kind, at, NSEventModifierFlags(0), 0.0, n.windowNumber(), None, 0, 1, 1.0);
          if let Some(e) = e { NSApplication::sharedApplication(mtm).postEvent_atStart(&e, false); }
        }
      });
      json!({ "ok": true })
    }
    "context-menu" => json!({ "items": *MENU.lock().unwrap() }),
    // A file from Finder as WebKit gets it: AppKit's NSDraggingDestination calls, on the real view.
    "drop-file" => {
      let (file, x, y) = (str_of("path"), q["x"].as_f64().unwrap_or(0.0), q["y"].as_f64().unwrap_or(0.0));
      let ptr = ns_window(&w);
      let (tx, rx) = mpsc::channel::<usize>();
      let _ = w.with_webview(move |wv| { let _ = tx.send(wv.inner() as usize); });
      let view = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(0);
      let step = |sel: &'static str| {
        let (app2, file) = (app.clone(), file.clone());
        main_thread(&app2, move |_| unsafe {
          let n = &*(ptr as *const NSWindow);
          let info = QaDrag::new(&file, NSPoint::new(x, n.frame().size.height - y), ptr);
          let view = view as *mut AnyObject;
          match sel {
            "enter" => { let r: usize = msg_send![view, draggingEntered: &*info]; r }
            "update" => { let r: usize = msg_send![view, draggingUpdated: &*info]; r }
            "perform" => { let r: bool = msg_send![view, performDragOperation: &*info]; r as usize }
            _ => { let _: () = msg_send![view, concludeDragOperation: &*info]; 0 }
          }
        })
      };
      let pause = || std::thread::sleep(std::time::Duration::from_millis(350));
      let entered = step("enter");
      pause();
      let updated = step("update");
      pause();
      let updated2 = step("update");
      pause();
      let performed = step("perform");
      pause();
      step("conclude");
      json!({ "entered": entered, "updated": updated, "updated2": updated2, "performed": performed })
    }
    "mode" => main_thread(app, |_| unsafe {
      let l: Retained<AnyObject> = msg_send![objc2::class!(NSRunLoop), currentRunLoop];
      let m: Option<Retained<NSString>> = msg_send![&*l, currentMode];
      json!({ "mode": m.map(|m| m.to_string()) })
    }),
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
    "activate" => {
      main_thread(app, |mtm| {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
      });
      json!({ "ok": w.set_focus().is_ok() })
    }
    "deactivate" => main_thread(app, |mtm| {
      NSApplication::sharedApplication(mtm).deactivate();
      json!({ "ok": true })
    }),
    "close" => {
      let _ = w.close();
      json!({ "ok": true })
    }
    op => json!({ "error": format!("no op {op}") }),
  }
}
