//! The few file operations the plugin makes, all async (nothing blocks a runtime thread).

use std::path::{Path, PathBuf};

pub async fn exists(p: impl AsRef<Path>) -> bool {
    tokio::fs::try_exists(p).await.unwrap_or(false)
}

/// The file's text, or None when it isn't there or isn't readable.
pub async fn read_opt(p: impl AsRef<Path>) -> Option<String> {
    tokio::fs::read_to_string(p).await.ok()
}

/// The real path (symlinks, macOS's /private/tmp), else the path as given.
pub async fn real(p: &str) -> String {
    tokio::fs::canonicalize(p).await.map_or_else(|_| p.to_owned(), |r| r.to_string_lossy().into_owned())
}

pub async fn mkdirp(p: impl AsRef<Path>) -> std::io::Result<()> {
    tokio::fs::create_dir_all(p).await
}

/// Removes a file or a tree; gone already is fine.
pub async fn rm_rf(p: impl AsRef<Path>) {
    let p = p.as_ref();
    match tokio::fs::symlink_metadata(p).await {
        Ok(m) if m.is_dir() => drop(tokio::fs::remove_dir_all(p).await),
        Ok(_) => drop(tokio::fs::remove_file(p).await),
        Err(_) => {}
    }
}

/// Names in a folder with whether each is a folder; empty when it can't be read.
pub async fn entries(dir: impl AsRef<Path>) -> Vec<(String, bool)> {
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        let is_dir = e.file_type().await.is_ok_and(|t| t.is_dir());
        out.push((e.file_name().to_string_lossy().into_owned(), is_dir));
    }
    out
}

/// A folder's mtime in ms, or None when it's gone.
pub async fn mtime_ms(p: impl AsRef<Path>) -> Option<i64> {
    let m = tokio::fs::metadata(p).await.ok()?;
    let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(t.as_millis()).ok()
}

pub fn join(a: &str, b: &str) -> String {
    PathBuf::from(a).join(b).to_string_lossy().into_owned()
}

pub fn parent(p: &str) -> String {
    Path::new(p).parent().map_or_else(|| p.to_owned(), |d| d.to_string_lossy().into_owned())
}

/// `p` without Windows' verbatim prefix (`\\?\C:\x` is `C:\x`, `\\?\UNC\srv\share` is `\\srv\share`), which
/// `canonicalize` adds and git refuses.
pub fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") { format!(r"\\{rest}") } else { p.strip_prefix(r"\\?\").unwrap_or(p).to_owned() }
}

/// `p` cleaned by its text alone (no disk): the verbatim prefix gone, `.` and empty parts dropped, `..` taking
/// off the part before it (never above the root), no trailing separator. Either separator splits; the first one
/// used joins.
pub fn clean(p: &str) -> String {
    let p = strip_verbatim(p);
    let sep = if p.contains('/') || !p.contains('\\') { '/' } else { '\\' };
    let (head, body) = root_of(&p);
    let absolute = !head.is_empty();
    let mut parts: Vec<&str> = Vec::new();
    for c in body.split(['/', '\\']) {
        match c {
            "" | "." => {}
            ".." if parts.last().is_some_and(|l| *l != "..") => drop(parts.pop()),
            ".." if absolute => {}
            c => parts.push(c),
        }
    }
    let joined = parts.join(&sep.to_string());
    if head.is_empty() && joined.is_empty() { ".".to_owned() } else { format!("{head}{joined}") }
}

/// The root a path starts with (`/`, `\\srv\share\` for UNC, `C:\`, a bare `C:`), and the rest. `..` never climbs
/// above it: out of a UNC share included.
fn root_of(p: &str) -> (&str, &str) {
    let b = p.as_bytes();
    if p.starts_with(r"\\") || p.starts_with("//") {
        // the server and the share, with the separator after them
        let mut seps = p.char_indices().skip(2).filter(|(_, c)| *c == '/' || *c == '\\').map(|(i, _)| i);
        match (seps.next(), seps.next()) {
            (Some(_), Some(end)) => p.split_at(end + 1),
            _ => (p, ""),
        }
    } else if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        if b.get(2).is_some_and(|c| *c == b'/' || *c == b'\\') { p.split_at(3) } else { p.split_at(2) }
    } else if p.starts_with(['/', '\\']) {
        p.split_at(1)
    } else {
        ("", p)
    }
}

/// `p` as the disk sees it: symlinks and `..` resolved by `canonicalize` on the longest part of it that exists,
/// the rest (not there, so no symlink in it) cleaned by text; never Windows' verbatim prefix. A path that doesn't
/// parse, or has nothing of it on disk, is only cleaned.
/// A relative path is only cleaned, never resolved against the server's folder.
pub async fn norm(p: &str) -> String {
    let raw = strip_verbatim(p);
    if raw.is_empty() || !Path::new(&raw).is_absolute() {
        return clean(&raw);
    }
    let comps: Vec<std::path::Component<'_>> = Path::new(&raw).components().collect();
    for i in (1..=comps.len()).rev() {
        let base: PathBuf = comps[..i].iter().collect();
        if let Ok(real) = tokio::fs::canonicalize(&base).await {
            let mut out = strip_verbatim(&real.to_string_lossy());
            for c in &comps[i..] {
                if !out.ends_with(['/', '\\']) {
                    out.push(std::path::MAIN_SEPARATOR);
                }
                out.push_str(&c.as_os_str().to_string_lossy());
            }
            let out = clean(&out);
            // a `..` in the part that isn't there can climb back into one that is (and may be a link): once more,
            // from there (the second pass has no `..` left, so it stops)
            if comps[i..].iter().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Box::pin(norm(&out)).await;
            }
            return out;
        }
    }
    clean(&raw)
}

/// Whether `p` is the folder `dir` or inside it, by path once both are cleaned (`clean`): `/a/bc` isn't inside
/// `/a/b`, and `/a/b/../c` isn't inside `/a/b`. Text only; for paths that may hold a symlink, `within_real`.
/// Either separator matches the other (`C:/a/wt` holds `C:\a\wt\x`).
pub fn within(p: &str, dir: &str) -> bool {
    let one = |x: &str| clean(x).replace('\\', "/");
    let (p, dir) = (one(p), one(dir));
    p == dir || p.strip_prefix(dir.as_str()).is_some_and(|rest| rest.starts_with('/') || dir.ends_with(['/', ':']))
}

/// `within`, both sides as the disk sees them (`norm`): a symlink into the folder is inside it, one inside it
/// pointing elsewhere isn't.
pub async fn within_real(p: &str, dir: &str) -> bool {
    within(&norm(p).await, &norm(dir).await)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod within_tests {
    use super::{clean, norm, within, within_real};

    #[test]
    fn a_folder_is_within_itself_and_its_parents_only() {
        assert!(within("/h/wt/app-1", "/h/wt/app-1/"));
        assert!(within("/h/wt/app-1/web", "/h/wt/app-1"));
        assert!(!within("/h/wt/app-10", "/h/wt/app-1"));
        assert!(!within("/h/wt", "/h/wt/app-1"));
        assert!(within("/h", "/"));
    }

    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_within() {
        assert!(!within("/a/wt2", "/a/wt"));
        assert!(!within("/a/wt2/src", "/a/wt"));
        assert!(!within("/a/wt", "/a/wt2"));
        assert!(!within(r"C:\a\wt2", r"C:\a\wt"));
        assert!(within(r"C:\a\wt\src", r"C:\a\wt"));
    }

    #[test]
    fn dotdot_is_resolved_before_comparing() {
        assert!(!within("/a/wt/../etc", "/a/wt"), "climbs out");
        assert!(!within("/a/wt/src/../../wt2", "/a/wt"), "climbs into a sibling");
        assert!(within("/a/wt/src/../lib", "/a/wt"));
        assert!(within("/a/other/../wt/x", "/a/wt"), "climbs in");
        assert!(!within("/a/wt/./..", "/a/wt"));
        assert_eq!(clean("/../../a"), "/a", "never above the root");
        assert_eq!(clean("a/../../b"), "../b");
        assert!(!within(r"C:\a\wt\..\etc", r"C:\a\wt"));
    }

    #[test]
    fn windows_verbatim_prefix_is_stripped() {
        assert_eq!(clean(r"\\?\C:\a\wt\"), r"C:\a\wt");
        assert_eq!(clean(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert!(within(r"\\?\C:\a\wt\src", r"C:\a\wt"));
        assert!(within(r"C:\a\wt", r"\\?\C:\a\wt"));
        assert!(!within(r"\\?\C:\a\wt\..\b", r"C:\a\wt"));
        assert!(within(r"C:\a\wt\x", "C:/a/wt"), "either separator");
        assert_eq!(clean(r"\\srv\share\..\x"), r"\\srv\share\x", "never out of the share");
        assert!(!within(r"\\srv\share2\x", r"\\srv\share"));
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wisp-fsx-{name}-{}", std::process::id()));
        drop(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_pointing_outside_is_not_within_and_one_pointing_in_is() {
        let d = scratch("link");
        let (wt, outside) = (d.join("wt"), d.join("far/outside"));
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, wt.join("escape")).unwrap();
        std::os::unix::fs::symlink(&wt, d.join("into")).unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        assert!(within(&s(&wt.join("escape")), &s(&wt)), "by text it looks inside");
        assert!(!within_real(&s(&wt.join("escape")), &s(&wt)).await, "on disk it's outside");
        assert!(!within_real(&s(&wt.join("escape/x/new")), &s(&wt)).await, "below it, not there yet, still outside");
        assert!(within_real(&s(&d.join("into/src")), &s(&wt)).await, "a link into the worktree is in it");
        assert!(within_real(&s(&wt.join("gone/deeper")), &s(&wt)).await, "not there yet: by text under the real root");
        // `..` after a symlink goes up from where the link points, as the OS does
        assert!(within(&s(&wt.join("escape/../wt")), &s(&wt)), "by text: wt/wt");
        assert!(!within_real(&s(&wt.join("escape/../wt")), &s(&wt)).await, "on disk: far/wt");
        assert_eq!(norm(&s(&wt.join("escape"))).await, norm(&s(&outside)).await);
        // `..` in a part that isn't there climbing back into a link: resolved through it
        assert!(!within_real(&s(&wt.join("gone/../escape/x")), &s(&wt)).await, "gone/.. then the link out");
        assert_eq!(norm("/").await, "/");
        assert!(!norm("/wisp-nowhere-at-all/x").await.starts_with("//"), "no UNC root made from `/`");
        assert_eq!(norm("rel/../x").await, "x", "relative: cleaned, never resolved");
        std::fs::remove_dir_all(&d).ok();
    }
}
