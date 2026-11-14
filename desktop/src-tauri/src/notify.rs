// A WKWebView's Notification never shows anything, so init.js gives the page one that lands here,
// on the page's own capability. The page gets only the plugin's two permission commands, not its own
// way to show a notification: that one has no click.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

// On macOS the plugin only waits for a click on a notification that has an action. Windows doesn't
// need one, and would show it as a button on the toast.
const ON_CLICK: &str = "open";
#[cfg(target_os = "macos")]
const KEEP: usize = 20;

#[tauri::command]
pub fn notify_show(app: AppHandle, id: i32, title: String, body: String) {
    // The app's own icon: macOS doesn't take the page's.
    let note = app.notification().builder().id(id).title(title).body(body);
    #[cfg(not(windows))]
    let note = note.action_type_id(ON_CLICK);
    if let Err(err) = note.show() {
        eprintln!("[wisp] no notification: {err}");
    }
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| crate::macos::keep_newest_notifications(KEEP));
}

// A click brings the app forward and hands the id to the page, which runs that note's onclick.
// Before any show(): the plugin only reports what it showed while someone was listening.
pub fn on_click(app: &AppHandle) -> tauri::Result<()> {
    let open = ActionType::builder(ON_CLICK).actions(vec![Action::builder(ON_CLICK, "Open").build()]).build();
    let _ = app.notification().register_action_types(vec![open]);
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        let Some(id) = action.notification().map(|n| n.id()) else { return };
        crate::show(&handle);
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(format!("dispatchEvent(new CustomEvent('wisp-notify-click', {{ detail: {id} }}))"));
        }
    });
    Ok(())
}
