//! `file:` URLs ↔ paths, as Node's `pathToFileURL`/`fileURLToPath` did for v1. Pure string work.

use std::path::{Path, PathBuf};

/// Bytes a path segment keeps as written (RFC 3986 unreserved, plus the sub-delims and `:@/`).
fn keep(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/".contains(&b)
}

/// `/a b/c.ts` → `file:///a%20b/c.ts`; `C:\a\b.ts` → `file:///C:/a/b.ts`.
pub fn path_to_file_url(path: &Path) -> String {
    let s = path.to_string_lossy();
    let s = if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() };
    let mut out = String::from("file://");
    if !s.starts_with('/') {
        out.push('/');
    }
    for &b in s.as_bytes() {
        if keep(b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The path a `file:` URL names, or `None` for another scheme or another host.
pub fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://").or_else(|| url.strip_prefix("FILE://"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return None,
    };
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let decoded = percent_decode(path)?;
    if cfg!(windows) {
        // `/C:/a` → `C:\a`
        let trimmed = decoded.strip_prefix('/').filter(|p| p.as_bytes().get(1) == Some(&b':')).unwrap_or(&decoded);
        return Some(PathBuf::from(trimmed.replace('/', "\\")));
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One spelling per file: servers write the same file's URL differently (`%3A` or `:`, a drive letter's
/// case), so diagnostics are kept by this key and found whichever way the server wrote it.
pub fn uri_key(uri: &str) -> String {
    match file_url_to_path(uri) {
        Some(p) => {
            let url = path_to_file_url(&p);
            if cfg!(windows) { url.to_lowercase() } else { url }
        }
        None => uri.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn unix_paths() {
        assert_eq!(path_to_file_url(Path::new("/tmp/a b/c.ts")), "file:///tmp/a%20b/c.ts");
        assert_eq!(path_to_file_url(Path::new("/x/#1?.ts")), "file:///x/%231%3F.ts");
        assert_eq!(path_to_file_url(Path::new("/é")), "file:///%C3%A9");
        assert_eq!(file_url_to_path("file:///tmp/a%20b/c.ts"), Some(PathBuf::from("/tmp/a b/c.ts")));
        assert_eq!(file_url_to_path("file://localhost/x"), Some(PathBuf::from("/x")));
    }

    #[cfg(unix)]
    #[test]
    fn round_trip() {
        for p in ["/a/b.rs", "/a b/ü/%20/[x]{y}.go", "/q?/h#/x\\y", "/a/b;c=d"] {
            assert_eq!(file_url_to_path(&path_to_file_url(Path::new(p))), Some(PathBuf::from(p)), "{p}");
        }
    }

    #[test]
    fn not_a_file_here() {
        assert_eq!(file_url_to_path("untitled:Untitled-1"), None);
        assert_eq!(file_url_to_path("file://server/share/x"), None);
        assert_eq!(file_url_to_path("file:///bad%zz"), None);
        assert_eq!(file_url_to_path("https://x/y"), None);
    }

    #[cfg(unix)]
    #[test]
    fn keys_agree_on_spelling() {
        assert_eq!(uri_key("file:///a%3Ab/c%2Ed"), uri_key("file:///a:b/c.d"));
        assert_eq!(uri_key("untitled:x"), "untitled:x");
    }
}
