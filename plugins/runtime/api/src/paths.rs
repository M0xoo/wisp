//! A project's path as it's stored (`wisp add .` stored "/repo/."): pure, no file system. The trailing `/.`
//! and `/` go, `.` and `..` segments resolve, and Windows' verbatim `\\?\` prefix (what `canonicalize` returns,
//! which git refuses) is stripped. A repo URL is left as it is.

/// The canonical form of a project's folder. `cwd` resolves a relative path (the CLI's own folder); `None` leaves a
/// relative path relative.
#[must_use]
pub fn canonical_project_path(path: &str, cwd: Option<&str>) -> String {
    let p = path.trim();
    if p.is_empty() || p.contains("://") || p.starts_with("git@") {
        return p.to_owned();
    }
    // Windows' verbatim forms: \\?\C:\x → C:\x, \\?\UNC\host\share → \\host\share
    let p = p.strip_prefix(r"\\?\UNC\").map_or_else(|| p.strip_prefix(r"\\?\").unwrap_or(p).to_owned(), |rest| format!(r"\\{rest}"));
    let windows = p.contains('\\') || p.as_bytes().get(1) == Some(&b':');
    let sep = if windows { '\\' } else { '/' };
    let absolute = p.starts_with('/') || p.starts_with('\\') || p.as_bytes().get(1) == Some(&b':');
    let joined = match cwd {
        Some(c) if !absolute => format!("{}{sep}{p}", c.trim_end_matches(['/', '\\'])),
        _ => p,
    };
    // the root: "/", "C:\\", or a UNC "\\\\host\\share"
    let (root, rest) = split_root(&joined);
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let body = parts.join(&sep.to_string());
    if root.is_empty() && body.is_empty() { ".".to_owned() } else { format!("{root}{body}") }
}

fn split_root(p: &str) -> (String, &str) {
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' {
        let rest = p.get(2..).unwrap_or_default().trim_start_matches(['/', '\\']);
        return (format!("{}\\", p.get(..2).unwrap_or_default()), rest);
    }
    if let Some(unc) = p.strip_prefix(r"\\") {
        // \\host\share\rest: the host and the share are the root
        let mut it = unc.splitn(3, ['\\', '/']);
        let (host, share, rest) = (it.next().unwrap_or_default(), it.next().unwrap_or_default(), it.next().unwrap_or_default());
        return (format!(r"\\{host}\{share}\"), rest);
    }
    if let Some(rest) = p.strip_prefix('/') {
        return ("/".to_owned(), rest);
    }
    (String::new(), p)
}
