// QA driver on Linux, only with `--features qa`: qa/desktop-tauri-linux.mjs asks it over a local
// socket (WISP_QA_PORT), one JSON line each way, as src/qa.rs does on macOS. Only what the page and
// its address need: WebKitGTK's WebDriver would bring a driver binary of its own.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Url};

pub const INIT: &str = "window.__qaErrors = []; addEventListener('error', (e) => __qaErrors.push(String(e.message))); addEventListener('unhandledrejection', (e) => __qaErrors.push(String(e.reason))); { const c = console.error; console.error = (...a) => (__qaErrors.push(a.join(' ')), c(...a)); }";

pub fn download_to(event: tauri::webview::DownloadEvent<'_>) {
    if let (tauri::webview::DownloadEvent::Requested { destination, .. }, Some(dir)) = (event, std::env::var_os("WISP_QA_DOWNLOADS")) {
        let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_default();
        *destination = std::path::PathBuf::from(dir).join(name);
    }
}

static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn note_opened(url: &Url) -> bool {
    OPENED.lock().unwrap().push(url.to_string());
    std::env::var_os("WISP_QA_REAL_OPEN").is_none()
}

pub fn listen(app: AppHandle) {
    let Ok(port) = std::env::var("WISP_QA_PORT") else { return };
    let port = port.parse::<u16>().expect("WISP_QA_PORT");
    std::thread::spawn(move || {
        let listener = (0..100)
            .find_map(|_| {
                TcpListener::bind(("127.0.0.1", port)).inspect_err(|_| std::thread::sleep(std::time::Duration::from_millis(100))).ok()
            })
            .expect("the QA port");
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut out = stream.try_clone().expect("socket");
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let answer =
                        serde_json::from_str(&line).map(|v| handle(&app, &v)).unwrap_or_else(|e| json!({ "error": e.to_string() }));
                    if writeln!(out, "{answer}").is_err() {
                        return;
                    }
                }
            });
        }
    });
}

fn handle(app: &AppHandle, q: &Value) -> Value {
    let Some(w) = app.get_webview_window("main") else { return json!({ "error": "no window yet" }) };
    match q["op"].as_str().unwrap_or_default() {
        "eval" => {
            let (tx, rx) = mpsc::channel();
            let _ = w.eval_with_callback(q["js"].as_str().unwrap_or_default(), move |r| {
                let _ = tx.send(r);
            });
            json!({ "result": rx.recv_timeout(std::time::Duration::from_secs(20)).ok() })
        }
        "window" => json!({ "title": w.title().ok(), "visible": w.is_visible().ok(), "url": w.url().ok().map(|u| u.to_string()) }),
        "opened" => json!({ "opened": *OPENED.lock().unwrap() }),
        "quit" => {
            app.exit(0);
            json!({ "ok": true })
        }
        op => json!({ "error": format!("no op {op}") }),
    }
}
