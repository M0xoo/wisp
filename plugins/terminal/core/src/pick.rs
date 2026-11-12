//! Preview's element picker (v1 server/runs.js): the panel shows the task's app through a small proxy on a port of its
//! own (its own origin, as the app's: wisp's API stays out of the app's reach), the same app minus X-Frame-Options
//! and CSP frame-ancestors, with one script added to its HTML pages ([`PICK_JS`]) that lets the panel pick an element.
//! This is what the proxy decides; the host moves the bytes. Pure.

/// Where the proxy serves the picker's script in the app's own pages.
pub const PICK_PATH: &str = "/__wisp/pick.js";
/// v1's `PICK_JS`, verbatim.
pub const PICK_JS: &str = include_str!("../assets/pick.js");
/// A page bigger than this goes through as it is, without the picker (v1 `HTML_MAX`).
pub const HTML_MAX: u64 = 8 * 1024 * 1024;
/// v1 `PROXY_BASE`: a task's proxy is `42000 + hash(id) % 900` (its app is on 41000 + the same: never the same port).
const PROXY_BASE: u16 = 42_000;
const SPAN: u32 = 900;

/// The port task `id`'s Preview proxy listens on (stable per task, as the app's).
#[must_use]
pub fn proxy_port_for(id: &str) -> u16 {
    let h = id.chars().fold(7_u32, |h, c| h.wrapping_mul(31).wrapping_add(u32::from(c)));
    PROXY_BASE + u16::try_from(h % SPAN).unwrap_or(0)
}

/// Only the page's own frame: a request whose Host isn't this computer's loopback (a site elsewhere reaching the port
/// through a name that points here: DNS rebinding) is refused.
#[must_use]
pub fn loopback_host(host: &str) -> bool {
    let Some((name, port)) = host.rsplit_once(':') else { return false };
    !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) && matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

/// The app's headers, framable by the panel: X-Frame-Options gone, CSP's frame-ancestors gone (every other rule
/// stays), a CSP left empty dropped. Names are compared in any case.
#[must_use]
pub fn frameable(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (k, v) in headers {
        let name = k.to_ascii_lowercase();
        if name == "x-frame-options" {
            continue;
        }
        if name == "content-security-policy" {
            let kept = v.split(';').filter(|d| !d.trim_start().to_ascii_lowercase().starts_with("frame-ancestors")).collect::<Vec<_>>().join(";");
            let kept = kept.trim();
            if !kept.is_empty() {
                out.push((k.clone(), kept.to_owned()));
            }
            continue;
        }
        out.push((k.clone(), v.clone()));
    }
    out
}

/// Whether an answer gets the picker: a GET's HTML page, not too big to hold (no length said counts as small, as v1).
#[must_use]
pub fn takes_picker(method: &str, content_type: Option<&str>, length: Option<u64>) -> bool {
    method.eq_ignore_ascii_case("GET") && content_type.is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html")) && length.unwrap_or(0) <= HTML_MAX
}

/// The picker's script tag, as early in the page as it can go: right after `<head …>`, else `<html …>`, else first.
/// A page that has it already is left alone.
#[must_use]
pub fn with_picker(html: &str) -> String {
    let tag = format!("<script src=\"{PICK_PATH}\"></script>");
    if html.contains(PICK_PATH) {
        return html.to_owned();
    }
    let lower = html.to_ascii_lowercase();
    let after = |name: &str| -> Option<usize> {
        let mut from = 0;
        while let Some(i) = lower[from..].find(&format!("<{name}")).map(|i| i + from) {
            let next = lower.as_bytes().get(i + 1 + name.len()).copied();
            if matches!(next, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')) {
                return lower[i..].find('>').map(|j| i + j + 1);
            }
            from = i + 1;
        }
        None
    };
    match after("head").or_else(|| after("html")) {
        Some(at) => format!("{}{tag}{}", &html[..at], &html[at..]),
        None => format!("{tag}{html}"),
    }
}

/// The text without terminal colours and cursor moves (v1 cleanLine's ANSI): `ESC [ … letter`, `ESC ] … BEL|ESC \\`,
/// and the two-byte `ESC x` forms.
#[must_use]
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('[') => {
                for x in it.by_ref() {
                    if ('@'..='~').contains(&x) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(x) = it.next() {
                    if x == '\u{7}' || (x == '\u{1b}' && it.peek() == Some(&'\\')) {
                        if x == '\u{1b}' {
                            it.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The first local address the app's output says it listens on (v1 urlIn, over its cleaned lines): its port.
#[must_use]
pub fn local_port_in(text: &str) -> Option<u16> {
    local_port_in_clean(&strip_ansi(text))
}

fn local_port_in_clean(text: &str) -> Option<u16> {
    for scheme in ["http://", "https://"] {
        let mut from = 0;
        while let Some(i) = text[from..].find(scheme).map(|i| i + from) {
            let rest = &text[i + scheme.len()..];
            // `[::1]:5173`: the host's own colons are inside its brackets
            let host_end = if rest.starts_with('[') { rest.find(']').map(|b| b + 1).filter(|&b| rest[b..].starts_with(':')) } else { rest.find(':') };
            if let Some(h) = host_end {
                let host = &rest[..h];
                let digits: String = rest[h + 1..].chars().take_while(char::is_ascii_digit).collect();
                if matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]" | "[::]")
                    && (2..=5).contains(&digits.len())
                    && let Ok(p) = digits.parse::<u16>()
                    && p > 0
                {
                    return Some(p);
                }
            }
            from = i + scheme.len();
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn h(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    /// v1 runs.js frameable/withPicker/proxy: the app framable by the panel (X-Frame-Options and frame-ancestors out,
    /// every other rule kept), the script once and as early as it can go, only HTML GETs under 8 MB, only a loopback
    /// Host, the proxy's port beside the app's and never the same.
    #[test]
    fn the_preview_proxy_frames_the_app_and_adds_the_picker_as_v1() {
        let out = frameable(&h(&[("X-Frame-Options", "DENY"), ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; img-src *"), ("content-type", "text/html")]));
        assert_eq!(out, h(&[("Content-Security-Policy", "default-src 'self'; img-src *"), ("content-type", "text/html")]));
        assert_eq!(frameable(&h(&[("content-security-policy", "frame-ancestors 'self'")])), Vec::<(String, String)>::new(), "nothing left: no CSP");

        let tag = "<script src=\"/__wisp/pick.js\"></script>";
        assert_eq!(with_picker("<!doctype html><html lang=en><head><title>x</title></head></html>"), format!("<!doctype html><html lang=en><head>{tag}<title>x</title></head></html>"));
        assert_eq!(with_picker("<HTML><body>hi</body></HTML>"), format!("<HTML>{tag}<body>hi</body></HTML>"));
        assert_eq!(with_picker("<header>not the head</header><p>x</p>"), format!("{tag}<header>not the head</header><p>x</p>"));
        assert_eq!(with_picker(&format!("<head>{tag}</head>")), format!("<head>{tag}</head>"), "already there: once");

        assert!(takes_picker("GET", Some("text/html; charset=utf-8"), Some(1200)));
        assert!(takes_picker("get", Some("text/html"), None));
        assert!(!takes_picker("POST", Some("text/html"), None));
        assert!(!takes_picker("GET", Some("application/json"), None));
        assert!(!takes_picker("GET", Some("text/html"), Some(HTML_MAX + 1)));

        assert!(loopback_host("localhost:42123") && loopback_host("127.0.0.1:42123") && loopback_host("[::1]:42123"));
        assert!(!loopback_host("evil.example:42123") && !loopback_host("localhost") && !loopback_host("localhost.evil.example:1") && !loopback_host("localhost:abc"));

        let (app, proxy) = (crate::run::port_for("s1"), proxy_port_for("s1"));
        assert!((42_000..42_900).contains(&proxy) && app != proxy);
        assert_eq!(proxy_port_for("s1"), proxy, "the same task, the same port");
        assert!(PICK_JS.contains("wisp: 'pick'") && PICK_JS.contains("window.parent"));
    }

    /// v1 urlIn: the first local address the app's output prints, its port; a remote address or no port isn't one.
    #[test]
    fn the_app_s_address_is_the_first_local_one_it_prints() {
        assert_eq!(local_port_in("  VITE v7 ready\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.4:5173/"), Some(5173));
        assert_eq!(local_port_in("listening on http://127.0.0.1:8080"), Some(8080));
        assert_eq!(local_port_in("see https://example.com:443/docs"), None);
        assert_eq!(local_port_in("http://localhost/ no port"), None);
        assert_eq!(local_port_in("http://0.0.0.0:3000 and http://localhost:4000"), Some(3000));
        assert_eq!(local_port_in("Listening on http://[::1]:8000/"), Some(8000));
        // vite colours the port: the colours go first
        assert_eq!(local_port_in("  \u{1b}[32m➜\u{1b}[39m  Local:   \u{1b}[36mhttp://localhost:\u{1b}[1m5173\u{1b}[22m/\u{1b}[39m"), Some(5173));
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}ok \u{1b}[1mbold\u{1b}[0m"), "ok bold");
    }
}
