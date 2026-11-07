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
    let (home2, home3, app2, last2) = (home.clone(), home.clone(), app.clone(), last.clone());
    view.connect_uri_notify(move |view| {
      let Some(uri) = view.uri().map(|u| u.to_string()) else { return };
      let Ok(url) = Url::parse(&uri) else { return };
      if crate::stays(&url, &home) {
        *last.borrow_mut() = uri;
        return;
      }
      // Stopped before it commits, the old page stays and the view's address goes back to it once
      // WebKit has dropped the load (a moment later, not here).
      view.stop_loading();
      #[cfg(debug_assertions)]
      eprintln!("[wisp] the page left for {uri}: stopped");
      crate::open_outside(&app, &url);
    });
    // Only if a page from elsewhere got in all the same: back to where wisp was.
    view.connect_load_changed(move |view, event| {
      let outside = view.uri().and_then(|u| Url::parse(&u).ok()).is_some_and(|u| !crate::stays(&u, &home3));
      if event == LoadEvent::Committed && outside {
        let back = last2.borrow().clone();
        eprintln!("[wisp] a page from elsewhere committed: back to {back}");
        view.load_uri(&back);
      }
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
