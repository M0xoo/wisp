// What only AppKit and WebKit can do. Everything here runs on the main thread or hops to it.

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Imp, ProtocolObject, Sel};
use objc2::{sel, MainThreadOnly};
use objc2_app_kit::{NSBackingStoreType, NSModalResponseOK, NSOpenPanel, NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString, NSUserDefaults};
use objc2_web_kit::{WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView};
use std::sync::mpsc;
use std::sync::OnceLock;
use tauri::{WebviewWindow, Window};

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

// A hidden full-screen window would leave a black Space behind it.
pub fn leave_fullscreen_and_hide(window: &Window) {
  if window.is_fullscreen().unwrap_or(false) {
    let _ = window.set_fullscreen(false);
  }
  let _ = window.hide();
}
