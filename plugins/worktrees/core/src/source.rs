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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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
}
