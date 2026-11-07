//! The page the sign-in sends the browser back to: says how it went, then closes itself.

use crate::text::esc_html;

pub fn signed_in(name: &str) -> (String, String) {
    (format!("Signed in to {name}"), "Back in wisp, its tools are ready for your tasks. You can close this tab.".to_owned())
}

pub fn failed(why: &str) -> (String, String) {
    ("Couldn’t sign in".to_owned(), why.to_owned())
}

/// v1's page, byte for byte apart from the escaped title and text.
pub fn callback_page(title: &str, text: &str) -> String {
    let (title, text) = (esc_html(title), esc_html(text));
    format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title} · wisp</title>\n<style>:root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}}main{{max-width:380px;padding:24px;text-align:center}}h1{{font-size:18px;font-weight:600;margin:0 0 6px}}p{{margin:0;opacity:.7}}</style>\n<main><h1>{title}</h1><p>{text}</p></main><script>setTimeout(() => window.close(), 1500)</script>"
    )
}
