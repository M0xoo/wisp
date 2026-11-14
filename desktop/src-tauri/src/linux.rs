// What only WebKitGTK can do. All of it on GTK's main thread.

use tauri::{AppHandle, Url, WebviewWindow};
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    LoadEvent, NetworkError, PolicyDecisionExt, PolicyDecisionType, PolicyError, ResponsePolicyDecision, ResponsePolicyDecisionExt,
    URIRequestExt, WebViewExt,
};

// WebKitGTK's navigation decision doesn't say which frame it's for, so on Linux on_navigation lets
// them all through (main.rs) and the page is held here instead, at the response: that decision knows
// the main frame's own document, and comes before anything of it is shown. When that's from outside
// wisp, it's refused (wisp's page stays as it was) and the address goes to the browser. The site has
// had the request by then; Electron's will-navigate stops it before. A scheme WebKit can't load
// (vscode://) has no response: the main frame's load fails, and load-failed is the main frame's only.
pub fn keep_page_home(window: &WebviewWindow, home: Url, app: AppHandle) -> tauri::Result<()> {
    window.with_webview(move |wv| {
        let view = wv.inner();
        let (home2, app2) = (home.clone(), app.clone());
        view.connect_decide_policy(move |_, decision, kind| {
            if kind != PolicyDecisionType::Response {
                return false;
            }
            let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>() else { return false };
            if !response.is_main_frame_main_resource() {
                return false;
            }
            let Some(url) = response.request().and_then(|r| r.uri()).and_then(|u| Url::parse(&u).ok()) else { return false };
            if crate::stays(&url, &home) {
                return false;
            }
            #[cfg(debug_assertions)]
            eprintln!("[wisp] the page left for {url}: refused, sent out");
            decision.ignore();
            crate::open_outside(&app, &url);
            true
        });
        view.connect_load_failed(move |_, _: LoadEvent, uri, err| {
            // Refused above or stopped: already sent out, or nothing to send.
            if err.matches(PolicyError::FrameLoadInterruptedByPolicyChange) || err.matches(NetworkError::Cancelled) {
                return false;
            }
            #[cfg(debug_assertions)]
            eprintln!("[wisp] the page couldn't load {uri}: {err}");
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
