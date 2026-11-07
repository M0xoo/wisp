// What only WebKitGTK can do. All of it on GTK's main thread.

use std::cell::RefCell;
use std::rc::Rc;
use tauri::{AppHandle, Url, WebviewWindow};
use webkit2gtk::{LoadEvent, NetworkError, WebViewExt};

// WebKitGTK's decide-policy doesn't say which frame a navigation is for, so on Linux on_navigation
// lets them all through (main.rs) and this watches the page instead: the view's `uri` is the main
// frame's alone, and a frame moving never touches it. When it leaves wisp the load is stopped before
// it commits, so the page stays as it was, and the address goes to the browser. load-failed is the
// main frame's too: a scheme WebKit can't load (vscode://) may only show up there.
pub fn keep_page_home(window: &WebviewWindow, home: Url, app: AppHandle) -> tauri::Result<()> {
  window.with_webview(move |wv| {
    let view = wv.inner();
    let last = Rc::new(RefCell::new(home.to_string())); // where wisp was, to go back to if it must
    let (home2, app2) = (home.clone(), app.clone());
    view.connect_uri_notify(move |view| {
      let Some(uri) = view.uri().map(|u| u.to_string()) else { return };
      let Ok(url) = Url::parse(&uri) else { return };
      if crate::stays(&url, &home) {
        *last.borrow_mut() = uri;
        return;
      }
      view.stop_loading();
      // Stopped before it committed, the view is back on wisp's page. If it isn't, back to where it was.
      let reload = view.uri().is_some_and(|u| u.as_str() == uri);
      #[cfg(debug_assertions)]
      eprintln!("[wisp] the page left for {uri}: stopped, {}", if reload { "reloading wisp" } else { "wisp's page kept" });
      if reload {
        let back = last.borrow().clone();
        view.load_uri(&back);
      }
      crate::open_outside(&app, &url);
    });
    view.connect_load_failed(move |_, _: LoadEvent, uri, err| {
      if err.matches(NetworkError::Cancelled) {
        return false; // stopped above, already sent out
      }
      match Url::parse(uri) {
        Ok(url) if !crate::stays(&url, &home2) => {
          crate::open_outside(&app2, &url);
          true // no error page: wisp stays as it was
        }
        _ => false,
      }
    });
  })
}
