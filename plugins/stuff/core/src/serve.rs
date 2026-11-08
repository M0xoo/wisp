//! Serving, decided without I/O: an app's request on its own origin (v1 services/apps.js), and a My
//! Stuff file on wisp's (v1 routes/stuff.js): which file, which headers, which refusal.

/// An app that uses wisp (a pane) keeps its requests on its own origin: its files, its database.
pub const PANE_CSP: &str = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
/// An app that doesn't keeps its network, but can't frame wisp's page and steal clicks.
pub const PANE_APP_CSP: &str = "frame-src 'self' https: data: blob:";
/// A picture shown on wisp's origin: no scripts, even opened on its own.
pub const SVG_CSP: &str =
    "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
pub const COVER_CSP: &str = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
/// An upload is whatever was sent, served from wisp's own address: a page in one must not run there.
pub const UPLOAD_CSP: &str = "sandbox";

/// The same port for the same app every time (its localStorage lives on its origin).
pub const PORT_BASE: u16 = 47100;
pub const PORT_SPAN: u16 = 800;
pub const IDLE_MS: i64 = 30 * 60_000;
pub const MAX_RUNNING: usize = 8;

pub fn app_port(id: &str) -> u16 {
    let mut h: u32 = 0;
    for c in id.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u32::from(c));
    }
    let off = u16::try_from(h % u32::from(PORT_SPAN)).unwrap_or(0);
    PORT_BASE + off
}

/// The ports to try for an app, its own first (v1: 20 tries, 7 apart).
pub fn port_candidates(id: &str) -> impl Iterator<Item = u16> {
    let want = app_port(id) - PORT_BASE;
    (0..20u16).map(move |i| PORT_BASE + (want + i * 7) % PORT_SPAN)
}

/// Only by its loopback name: a page on another site can't reach it through a rebound DNS name.
pub fn loopback_host(host: &str) -> bool {
    let h = if host.starts_with('[') {
        host.split_inclusive(']').next().unwrap_or(host)
    } else {
        host.rsplit_once(':').map_or(host, |(h, _)| h)
    };
    matches!(h, "localhost" | "127.0.0.1" | "[::1]")
}

/// `%2e%2e` → `..`; None when the escapes aren't valid UTF-8 or aren't escapes.
#[allow(clippy::many_single_char_names)] // bytes, hex digits: short names read better here
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = b.get(i + 1..i + 3)?;
            let v = u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()?;
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A request path as a path inside the app: decoded, `.` and `..` resolved without ever leaving it,
/// `/` as the entry. None when it can't be decoded or names nothing.
pub fn app_rel(url_path: &str, entry: &str) -> Option<String> {
    let p = percent_decode(url_path.split(['?', '#']).next().unwrap_or_default())?;
    let p = if p.is_empty() || p == "/" {
        format!("/{entry}")
    } else {
        p
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.iter().any(|s| s.contains(['\\', '\0'])) || parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// The file a request means in an app whose files are `files`: the file itself, or a folder's
/// index.html.
pub fn resolve_in<'a>(rel: &str, mut has: impl FnMut(&str) -> bool + 'a) -> Option<String> {
    if has(rel) {
        return Some(rel.to_owned());
    }
    let index = format!("{rel}/index.html");
    has(&index).then_some(index)
}

/// What an app's server does with a request (before reading any file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppRoute {
    Forbidden,
    PaneJs,
    PaneCss,
    /// `/_wisp/db.js` (`js`) or `/_wisp/db` (the queries), for an app with a database
    Db {
        js: bool,
    },
    /// anything else under `/_wisp/`, or a database the app doesn't have
    NoDb,
    WispNotFound,
    MethodNotAllowed,
    File(String),
    NotFound,
}

pub fn route_app(
    method: &str,
    host: &str,
    path: &str,
    entry: &str,
    has_db: bool,
    mut has: impl FnMut(&str) -> bool,
) -> AppRoute {
    if !loopback_host(host) {
        return AppRoute::Forbidden;
    }
    let pathname = path.split(['?', '#']).next().unwrap_or_default();
    match pathname {
        "/_wisp/pane.js" => return AppRoute::PaneJs,
        "/_wisp/pane.css" => return AppRoute::PaneCss,
        _ => {}
    }
    if pathname.starts_with("/_wisp/") {
        if !has_db {
            return AppRoute::NoDb;
        }
        return match pathname {
            "/_wisp/db.js" => AppRoute::Db { js: true },
            "/_wisp/db" => AppRoute::Db { js: false },
            _ => AppRoute::WispNotFound,
        };
    }
    if method != "GET" && method != "HEAD" {
        return AppRoute::MethodNotAllowed;
    }
    app_rel(pathname, entry)
        .and_then(|rel| resolve_in(&rel, &mut has))
        .map_or(AppRoute::NotFound, AppRoute::File)
}

/// Headers for an app's file.
pub fn app_file_headers(content_type: &str, uses_wisp: bool) -> Vec<(String, String)> {
    vec![
        ("content-type".into(), content_type.into()),
        ("cache-control".into(), "no-cache".into()),
        ("x-content-type-options".into(), "nosniff".into()),
        (
            "content-security-policy".into(),
            (if uses_wisp { PANE_CSP } else { PANE_APP_CSP }).into(),
        ),
    ]
}

/// How a My Stuff file is served on wisp's origin: `(content type, headers)`. HTML (or XML) never
/// opens there, only downloads: it would run on wisp's own origin. An SVG shows as a sandboxed picture.
pub fn stuff_file_headers(
    mime: &str,
    name: &str,
    download: bool,
) -> (String, Vec<(String, String)>) {
    let svg = mime.contains("svg");
    let page = (mime.contains("html") || mime.contains("xml")) && !svg;
    let mut h = vec![("x-content-type-options".to_owned(), "nosniff".to_owned())];
    if download || page {
        h.push((
            "content-disposition".into(),
            format!(
                "attachment; filename*=UTF-8''{}",
                encode_uri_component(name)
            ),
        ));
    }
    if svg {
        h.push(("content-security-policy".into(), SVG_CSP.into()));
    }
    (
        if page {
            "application/octet-stream".into()
        } else {
            mime.to_owned()
        },
        h,
    )
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// A `Range: bytes=a-b` header against a file of `size` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    Full,
    /// inclusive
    Part(u64, u64),
    Unsatisfiable,
}

pub fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(spec) = header.and_then(|h| h.strip_prefix("bytes=")) else {
        return Range::Full;
    };
    let Some((a, b)) = spec.split_once('-') else {
        return Range::Full;
    };
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) || (a.is_empty() && b.is_empty()) {
        return Range::Full;
    }
    let (Ok(start), end) = (
        if a.is_empty() {
            Ok(size.saturating_sub(b.parse().unwrap_or(0)))
        } else {
            a.parse::<u64>()
        },
        b,
    ) else {
        return Range::Full;
    };
    let end = if !a.is_empty() && !end.is_empty() {
        end.parse::<u64>()
            .unwrap_or(u64::MAX)
            .min(size.saturating_sub(1))
    } else {
        size.saturating_sub(1)
    };
    if start >= size || start > end {
        Range::Unsatisfiable
    } else {
        Range::Part(start, end)
    }
}
