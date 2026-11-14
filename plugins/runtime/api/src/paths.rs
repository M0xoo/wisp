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

/// A task's or project's folder, checked before it's used as a path: never empty, never relative. Either one
/// resolves against the server's own working directory (`Path::new("")`, a spawn with no cwd, `git -C ""`),
/// so a folder that is either is refused (or skipped, with a log) instead. Pure: it never reads the disk, so
/// a folder that isn't there any more still passes (the spawn or read that follows says so).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Folder(std::path::PathBuf);

/// Why a folder isn't one: empty (`path` is ""), or not a full path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoFolder {
    pub path: String,
}

impl std::fmt::Display for NoFolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() { f.write_str("no folder") } else { write!(f, "{} isn't a full path to a folder", self.path) }
    }
}

impl std::error::Error for NoFolder {}

impl From<NoFolder> for wisp_kernel::WireError {
    fn from(e: NoFolder) -> Self {
        Self::invalid(e.to_string())
    }
}

impl Folder {
    /// `path` as a folder, when it is a full path (`/x`, `C:\x`, `\\host\share`).
    ///
    /// # Errors
    /// Empty (or only spaces), or relative (`.`, `src`, `~/x`: they'd resolve against the server's folder).
    pub fn of(path: &str) -> Result<Self, NoFolder> {
        let p = path.trim();
        let b = p.as_bytes();
        // rooted on this OS or written for another (a peer's `C:\x` read on Linux): never the process's folder
        let full = std::path::Path::new(p).is_absolute()
            || p.starts_with('/')
            || p.starts_with('\\')
            || (b.len() >= 3 && b[1] == b':' && matches!(b[2], b'\\' | b'/'));
        if full { Ok(Self(p.into())) } else { Err(NoFolder { path: p.to_owned() }) }
    }

    /// The first of `paths` that is a folder (a task's worktree, else its folder).
    #[must_use]
    pub fn first<'a>(paths: impl IntoIterator<Item = &'a str>) -> Option<Self> {
        paths.into_iter().find_map(|p| Self::of(p).ok())
    }

    #[must_use]
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }

    #[must_use]
    pub fn into_path(self) -> std::path::PathBuf {
        self.0
    }
}

impl AsRef<std::path::Path> for Folder {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

impl std::fmt::Display for Folder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.display().fmt(f)
    }
}
