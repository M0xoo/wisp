//! Project-relative paths and the size cap on file contents wisp keeps (v1 `server/paths.js`). Pure:
//! the driver resolves the cwd's real path once, before the run, and parsers get both spellings
//! (`/tmp` and `/private/tmp` on macOS). POSIX semantics, as `node:path` has on macOS and Linux.

/// Larger files are tracked as changed, but their contents aren't kept.
pub const MAX_SNAPSHOT: usize = 256 * 1024;

/// The run's folder as given and as the OS resolves it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunPaths {
    pub cwd: String,
    pub real: String,
}

impl RunPaths {
    pub fn new(cwd: impl Into<String>, real: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            real: real.into(),
        }
    }
    /// One spelling for both (tests, or a folder with no symlink on its way).
    pub fn same(cwd: impl Into<String>) -> Self {
        let cwd = cwd.into();
        Self {
            real: cwd.clone(),
            cwd,
        }
    }
}

/// `path.normalize` for an absolute POSIX path: `.` and `..` resolved, slashes collapsed, no trailing slash.
fn normalize_abs(p: &str) -> String {
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
    let mut out = String::with_capacity(p.len() + 1);
    for s in &parts {
        out.push('/');
        out.push_str(s);
    }
    if out.is_empty() {
        out.push('/');
    }
    out
}

/// `path.resolve(base, file)` (base is taken as absolute: a run's cwd always is).
pub fn resolve(base: &str, file: &str) -> String {
    if file.starts_with('/') {
        normalize_abs(file)
    } else if base.starts_with('/') {
        normalize_abs(&format!("{base}/{file}"))
    } else {
        normalize_abs(&format!("/{base}/{file}"))
    }
}

/// `path.relative(from, to)` for two absolute normalised paths.
pub fn relative(from: &str, to: &str) -> String {
    let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = std::iter::repeat_n("..", f.len() - common).collect();
    out.extend(&t[common..]);
    out.join("/")
}

/// Path relative to cwd, or the path as given if it lies outside. Harnesses may report paths through
/// the resolved cwd, so both spellings count. An empty path stays empty.
pub fn rel(file: &str, paths: &RunPaths) -> String {
    if file.is_empty() {
        return String::new();
    }
    let abs = resolve(&paths.cwd, file);
    let bases: &[&str] = if paths.cwd == paths.real {
        &[&paths.cwd]
    } else {
        &[&paths.cwd, &paths.real]
    };
    for base in bases {
        let r = relative(&normalize_abs(base), &abs);
        if !r.is_empty() && !r.starts_with("..") && !r.starts_with('/') {
            return r;
        }
    }
    file.to_owned()
}

/// `rel` over a JSON value (v1 `rel(input.file_path || …)`): falsy is `''`, the rest `String(v)`.
pub fn rel_value(file: &serde_json::Value, paths: &RunPaths) -> String {
    if !crate::js::truthy(file) {
        return String::new();
    }
    rel(&crate::js::string(file), paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_inside_and_outside() {
        let p = RunPaths::new("/tmp/w", "/private/tmp/w");
        assert_eq!(rel("/tmp/w/a/b.js", &p), "a/b.js");
        assert_eq!(rel("/private/tmp/w/a.js", &p), "a.js");
        assert_eq!(rel("a/./c/../b.js", &p), "a/b.js");
        assert_eq!(rel("/etc/hosts", &p), "/etc/hosts");
        assert_eq!(rel("../x", &p), "../x");
        assert_eq!(rel("/tmp/w", &p), "/tmp/w"); // the folder itself: '' is not a path
        assert_eq!(rel("", &p), "");
    }

    #[test]
    fn relative_walks_up() {
        assert_eq!(relative("/a/b", "/a/c/d"), "../c/d");
        assert_eq!(relative("/a", "/a"), "");
        assert_eq!(resolve("/a/b", "../c//d/"), "/a/c/d");
    }
}
