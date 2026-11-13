//! The task's file view (v1 routes/workspace.js `/source`, `/files`): which file a path names inside the task's
//! folder (never outside it), whether it's text small enough to edit, and its hash, so a save refuses a file that
//! changed since it was opened.

use std::path::{Component, Path, PathBuf};

/// The most a file may be to edit here (v1 `SOURCE_MAX`).
pub const SOURCE_MAX: usize = 1 << 20;
/// The most files listed for Open file… and @ (v1 `FILES_MAX`).
pub const FILES_MAX: usize = 5000;

/// `rel` inside `root`: a relative path with no `..`, or None (an absolute path, a way out, nothing).
pub fn inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel.trim());
    if rel.trim().is_empty() || p.is_absolute() {
        return None;
    }
    let mut out = root.to_path_buf();
    for c in p.components() {
        match c {
            Component::Normal(x) => out.push(x),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

/// Why `bytes` can't be edited here, or None.
pub fn not_editable(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > SOURCE_MAX {
        Some("Too big to edit here (over 1 MB): open it in your editor.")
    } else if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        Some("Not a text file: open it in your editor.")
    } else {
        None
    }
}

/// A file's hash (FNV-1a 64, hex): the same bytes, the same hash, on every run.
pub fn hash_of(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `git ls-files -z` output: each file once, sorted, at most `FILES_MAX`, and how many more there were.
pub fn file_list(z: &str) -> (Vec<String>, usize) {
    let mut all: Vec<String> = z.split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect();
    all.sort();
    all.dedup();
    let more = all.len().saturating_sub(FILES_MAX);
    all.truncate(FILES_MAX);
    (all, more)
}

pub use wisp_worktrees_api::Hit;

/// A name the editor may look for: an identifier, nothing a pattern would read as more.
pub fn ident(name: &str) -> Option<&str> {
    let n = name.trim();
    let ok = !n.is_empty()
        && n.len() <= 120
        && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        && !n.chars().next().is_some_and(char::is_numeric);
    ok.then_some(n)
}

/// `git grep -E` for where `name` is declared (v1 `/grep?def=`): after a keyword that declares one, or assigned a
/// function. The name is an identifier already (`ident`).
pub fn def_pattern(name: &str) -> String {
    // POSIX classes and explicit word edges: `git grep -E` has no `\b` or `\s`
    let n = name.replace('$', "[$]");
    let decl = "function|class|const|let|var|def|fn|struct|enum|trait|type|interface|impl|mod|func|module";
    format!(
        "(^|[^A-Za-z0-9_])({decl})[[:space:]]+{n}([^A-Za-z0-9_$]|$)|(^|[^A-Za-z0-9_$.]){n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function([^A-Za-z0-9_$]|$)|\\()"
    )
}

/// `git grep -n` output as hits, at most `max`; text cut to 200 characters.
pub fn hits(out: &str, max: usize) -> Vec<Hit> {
    out.lines()
        .filter_map(|l| {
            let (path, rest) = l.split_once(':')?;
            let (n, text) = rest.split_once(':')?;
            Some(Hit { path: path.to_owned(), line: n.parse().ok()?, text: text.trim().chars().take(200).collect() })
        })
        .take(max)
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// The pattern as `git grep -E` reads it, run here through the system's grep (tests only).
    fn regex_lite(pattern: &str) -> impl Fn(&str) -> bool + use<> {
        let p = pattern.to_owned();
        move |line: &str| {
            let mut c = std::process::Command::new("grep").args(["-E", "-q", &p]).stdin(std::process::Stdio::piped()).spawn().unwrap();
            {
                use std::io::Write as _;
                c.stdin.take().unwrap().write_all(line.as_bytes()).unwrap();
            }
            c.wait().unwrap().success()
        }
    }

    /// v1 workspace.js sourceFile: a path names a file inside the task's folder only; binary or huge files aren't
    /// edited here; the hash tells a changed file.
    #[test]
    fn the_file_view_reads_only_inside_the_tasks_folder_and_only_text() {
        let root = Path::new("/w/task");
        assert_eq!(inside(root, "src/a.ts"), Some(PathBuf::from("/w/task/src/a.ts")));
        assert_eq!(inside(root, "./src/a.ts"), Some(PathBuf::from("/w/task/src/a.ts")));
        assert_eq!(inside(root, "../other/a.ts"), None);
        assert_eq!(inside(root, "src/../../x"), None);
        assert_eq!(inside(root, "/etc/passwd"), None);
        assert_eq!(inside(root, " "), None);
        assert_eq!(not_editable(b"fn main() {}"), None);
        assert!(not_editable(b"\x00\x01").is_some());
        assert!(not_editable(&vec![b'a'; SOURCE_MAX + 1]).is_some());
        assert_eq!(hash_of(b"abc"), hash_of(b"abc"));
        assert_ne!(hash_of(b"abc"), hash_of(b"abd"));
        assert_eq!(file_list("b\0a\0b\0"), (vec!["a".to_owned(), "b".to_owned()], 0));
    }

    /// v1 workspace.js `/grep?def=`: Go to definition finds where a name is declared, and only an identifier is
    /// looked for.
    #[test]
    fn go_to_definition_finds_where_a_name_is_declared() {
        assert_eq!(ident(" squash "), Some("squash"));
        assert_eq!((ident("a.b"), ident("1x"), ident("")), (None, None, None));
        let re = regex_lite(&def_pattern("squash"));
        for yes in [
            "pub fn squash(s: &str)",
            "export function squash(a)",
            "const squash = (a) =>",
            "  squash: async function () {",
            "def squash(x):",
        ] {
            assert!(re(yes), "{yes}");
        }
        for no in ["squash(x);", "let squashed = 1", "// squash it"] {
            assert!(!re(no), "{no}");
        }
        let h = hits("src/text.rs:5:pub fn squash(s: &str) -> String {\nweb/a.js:12:export function squash(a) {\nbad line", 10);
        assert_eq!(
            h,
            vec![
                Hit { path: "src/text.rs".into(), line: 5, text: "pub fn squash(s: &str) -> String {".into() },
                Hit { path: "web/a.js".into(), line: 12, text: "export function squash(a) {".into() }
            ]
        );
    }
}
