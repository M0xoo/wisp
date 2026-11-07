// What only AppKit and WebKit can do. Everything here runs on the main thread or hops to it.

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, ProtocolObject, Sel};
use objc2::{class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{NSBackingStoreType, NSModalResponseOK, NSOpenPanel, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSArray, NSPoint, NSRect, NSSize, NSString, NSUserDefaults};
use objc2_web_kit::{WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView};
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{WebviewWindow, Window};

// An Electron build updating onto this one swaps the bundle first, then runs its own binary with
// ELECTRON_RUN_AS_NODE to wait for the port and open the new app (handOff in server/update.js). By
// then that path is this binary, and builds already out can't change: without this it boots as the
// app with the helper's arguments ignored, and the old bundle is never removed.
pub fn be_node_for_electron() {
  use std::os::unix::process::CommandExt;
  if std::env::var_os("ELECTRON_RUN_AS_NODE").is_none() {
    return;
  }
  let exe = std::env::current_exe().and_then(|p| p.canonicalize()).expect("this binary's path");
  let node = exe.parent().expect("Contents/MacOS").join("../Resources/node/bin/node");
  let err = std::process::Command::new(node).args(std::env::args_os().skip(1)).env_remove("ELECTRON_RUN_AS_NODE").exec();
  eprintln!("[wisp] no bundled Node: {err}");
  std::process::exit(1);
}

type Decide = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut WKWebView, *mut WKNavigationAction, *mut Block<dyn Fn(WKNavigationActionPolicy)>);
static DECIDE: OnceLock<Decide> = OnceLock::new();

// wry calls the on_navigation handler for every frame and doesn't say which. Electron's will-navigate
// is main frame only, so a Preview tab or a sandboxed frame moving on its own would jump out to the
// browser here. WebKit knows the frame, so the frames are answered before wry sees them.
unsafe extern "C-unwind" fn decide(this: *mut AnyObject, sel: Sel, view: *mut WKWebView, action: *mut WKNavigationAction, handler: *mut Block<dyn Fn(WKNavigationActionPolicy)>) {
  let act = &*action;
  let subframe = act.targetFrame().is_some_and(|f| !f.isMainFrame());
  if subframe && !act.shouldPerformDownload() {
    return (*handler).call((WKNavigationActionPolicy::Allow,));
  }
  DECIDE.get().expect("set below")(this, sel, view, action, handler)
}

pub fn keep_frames_in_place(window: &WebviewWindow) -> tauri::Result<()> {
  window.with_webview(|wv| unsafe {
    let view: &WKWebView = &*wv.inner().cast();
    let delegate: Retained<ProtocolObject<dyn WKNavigationDelegate>> = view.navigationDelegate().expect("wry sets one");
    let cls = AnyObject::class(&*(&*delegate as *const _ as *const AnyObject));
    let name = sel!(webView:decidePolicyForNavigationAction:decisionHandler:);
    let method = cls.instance_method(name).expect("wry implements it");
    let new: Imp = std::mem::transmute(decide as Decide);
    let old = objc2::ffi::method_setImplementation(method as *const _ as *mut _, new);
    let _ = DECIDE.set(std::mem::transmute::<Imp, Decide>(old.expect("wry implements it")));
  })
}

// Safari's Tab skips buttons and links unless you ask; Electron's reaches them. wry 0.57 asks too, by
// key-value coding; this keeps it if wry stops. Off, TAURI-07d takes 4 Tabs to the text box.
pub fn tab_reaches_links(window: &WebviewWindow) -> tauri::Result<()> {
  window.with_webview(|wv| unsafe {
    let view: &WKWebView = &*wv.inner().cast();
    let config: Retained<AnyObject> = msg_send![view, configuration];
    let prefs: Retained<AnyObject> = msg_send![&*config, preferences];
    let _: () = msg_send![&*prefs, setTabFocusesLinks: true];
  })
}

// tao's inset y is the height of the title bar box, not where the buttons land: they keep their
// distance from its bottom, which AppKit picks per macOS version. Electron's y is the buttons' top,
// so ask a throwaway window of the same style what that distance is. Main thread only.
pub fn traffic_light_inset(y: f64) -> f64 {
  let mtm = MainThreadMarker::new().expect("main thread");
  let style = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Miniaturizable | NSWindowStyleMask::Resizable | NSWindowStyleMask::FullSizeContentView;
  let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
  let probe = unsafe { NSWindow::initWithContentRect_styleMask_backing_defer(NSWindow::alloc(mtm), rect, style, NSBackingStoreType::Buffered, true) };
  unsafe { probe.setReleasedWhenClosed(false) };
  let bottom = probe.standardWindowButton(NSWindowButton::CloseButton).map_or(6.0, |close| close.frame().origin.y);
  probe.close();
  y + bottom
}

// rfd can't set the button's label. A sheet on the window, like Electron's.
pub fn pick_folder(window: &WebviewWindow) -> Option<String> {
  let (tx, rx) = mpsc::channel();
  let parent = window.ns_window().ok()? as usize;
  window
    .run_on_main_thread(move || unsafe {
      let mtm = MainThreadMarker::new().expect("main thread");
      let panel = NSOpenPanel::openPanel(mtm);
      panel.setCanChooseFiles(false);
      panel.setCanChooseDirectories(true);
      panel.setCanCreateDirectories(true);
      panel.setPrompt(Some(&NSString::from_str("Add project")));
      let picked = panel.clone();
      let done = RcBlock::new(move |response| {
        let url = (response == NSModalResponseOK).then(|| picked.URL()).flatten();
        let _ = tx.send(url.and_then(|u| u.path()).map(|p| p.to_string()));
      });
      panel.beginSheetModalForWindow_completionHandler(&*(parent as *const NSWindow), &done);
    })
    .ok()?;
  rx.recv().ok().flatten()
}

// System Settings → Desktop & Dock → Double-click a window's title bar to.
pub fn double_click_action() -> String {
  NSUserDefaults::standardUserDefaults().stringForKey(&NSString::from_str("AppleActionOnDoubleClick")).map_or("Maximize".into(), |s| s.to_string())
}

// The plugin looks after each notification still in Notification Center, twice a second on the main
// thread and with a thread of its own: 40 of them took a fifth of a core. So the oldest go. Main thread.
pub fn keep_newest_notifications(keep: usize) {
  unsafe {
    let center: Option<Retained<AnyObject>> = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
    let Some(center) = center else { return };
    // nil, not an empty list, when the app isn't bundled or may not notify yet; objc2 panics on a nil Retained.
    let list: Option<Retained<NSArray<AnyObject>>> = msg_send![&*center, deliveredNotifications];
    let Some(list) = list else { return };
    let at = |n: &AnyObject| -> f64 {
      let date: Option<Retained<AnyObject>> = msg_send![n, actualDeliveryDate];
      date.map_or(0.0, |d| msg_send![&*d, timeIntervalSince1970])
    };
    let mut all: Vec<_> = list.iter().map(|n| (at(&n), n)).collect();
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (_, old) in all.iter().take(all.len().saturating_sub(keep)) {
      let _: () = msg_send![&*center, removeDeliveredNotification: &**old];
    }
  }
}

// A hidden full-screen window would leave a black Space behind it.
pub fn leave_fullscreen_and_hide(window: &Window) {
  if window.is_fullscreen().unwrap_or(false) {
    let _ = window.set_fullscreen(false);
  }
  let _ = window.hide();
}
