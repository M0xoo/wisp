//! `git diff` output → one `FileDiff` per file, as the side panel's Changes draws it (v1 parseDiff,
//! edge case Git 10): rows capped at 2000 per file (the rest counted in `more`), gaps between hunks
//! as '…' rows, lockfiles and build output flagged generated, untracked files read whole.

use wisp_git_api::{FileDiff, Row};

/// A file's rows past this are counted, not sent.
pub const DIFF_LINES: usize = 2000;
/// Untracked files sent whole; the rest are only counted.
pub const UNTRACKED_MAX: usize = 200;
/// A NUL in this many first bytes makes a file binary (git's own test).
pub const BINARY_SNIFF: usize = 8000;

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "composer.lock",
    "go.sum",
];

/// Lockfiles, `*.lock`, `*.min.js|css`, and anything under a `dist/` or `build/` folder.
pub fn generated_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if LOCKFILES.contains(&name)
        || std::path::Path::new(name)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("lock"))
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
    {
        return true;
    }
    path.starts_with("dist/")
        || path.starts_with("build/")
        || path.contains("/dist/")
        || path.contains("/build/")
}

/// `diff --git a/<x> b/<y>`: the new path. Both halves are the same path unless it is a rename (whose
/// `rename to` line then names it), so an even split wins over the last " b/" (a name may hold " b/").
fn header_path(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("diff --git a/")?;
    if rest.len() >= 3 && (rest.len() - 3) % 2 == 0 {
        let half = (rest.len() - 3) / 2;
        if rest.is_char_boundary(half)
            && rest[half..].starts_with(" b/")
            && rest[..half] == rest[half + 3..]
        {
            return Some(&rest[half + 3..]);
        }
    }
    let at = rest.rfind(" b/")?;
    Some(&rest[at + 3..])
}

/// `@@ -a[,n] +b[,m] @@`: the first old and new line numbers.
pub(crate) fn hunk_starts(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(' ')?;
    let new = rest.strip_prefix('+')?.split([' ', ',']).next()?;
    let old = old.split(',').next()?;
    Some((old.parse().ok()?, new.parse().ok()?))
}

struct Parser {
    files: Vec<FileDiff>,
    a: u32,
    b: u32,
}

impl Parser {
    fn push(&mut self, row: Row) {
        if let Some(f) = self.files.last_mut() {
            if f.rows.len() < DIFF_LINES {
                f.rows.push(row);
            } else {
                f.more += 1;
            }
        }
    }

    fn line(&mut self, line: &str) {
        if let Some(path) = header_path(line) {
            self.files.push(FileDiff::new(path, 'M'));
            self.a = 1;
            self.b = 1;
            return;
        }
        let Some(f) = self.files.last_mut() else {
            return;
        };
        if line.starts_with("new file mode") {
            f.status = 'A';
        } else if line.starts_with("deleted file mode") {
            f.status = 'D';
        } else if let Some(from) = line.strip_prefix("rename from ") {
            f.from = Some(from.to_owned());
            f.status = 'R';
        } else if let Some(to) = line.strip_prefix("rename to ") {
            to.clone_into(&mut f.path);
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            f.binary = true;
        } else if line.starts_with("@@") {
            let (a, b) = hunk_starts(line).unwrap_or((1, 1));
            if b > self.b {
                let gap = b - self.b;
                self.push(Row::gap(gap));
            }
            self.a = a;
            self.b = b;
        } else if line.starts_with("+++")
            || line.starts_with("---")
            || line.starts_with("index ")
            || line.starts_with("similarity ")
        {
        } else if let Some(text) = line.strip_prefix('+') {
            f.add += 1;
            let b = self.b;
            self.b += 1;
            self.push(Row::added(text, b));
        } else if let Some(text) = line.strip_prefix('-') {
            f.del += 1;
            let a = self.a;
            self.a += 1;
            self.push(Row::removed(text, a));
        } else if let Some(text) = line.strip_prefix(' ') {
            let (a, b) = (self.a, self.b);
            self.a += 1;
            self.b += 1;
            self.push(Row::context(text, a, b));
        }
    }
}

/// Parses `git diff --no-color --no-ext-diff -M -U3` output.
pub fn parse_diff(out: &str) -> Vec<FileDiff> {
    let mut p = Parser {
        files: Vec::new(),
        a: 1,
        b: 1,
    };
    for line in out.split('\n') {
        p.line(line);
    }
    p.files
}

/// An untracked file as an added one: whole, binary when a NUL is in its first 8000 bytes.
pub fn untracked_file(path: &str, bytes: &[u8]) -> FileDiff {
    let mut f = FileDiff::new(path, 'A');
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        f.binary = true;
        return f;
    }
    let text = String::from_utf8_lossy(bytes);
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let mut n: u32 = 0;
    for line in body.split('\n') {
        n += 1;
        if f.rows.len() < DIFF_LINES {
            f.rows.push(Row::added(line, n));
        } else {
            f.more += 1;
        }
    }
    f.add = if bytes.is_empty() { 0 } else { n };
    if bytes.is_empty() {
        f.rows.clear();
    }
    f
}

/// Flags generated files and sorts by path (v1: localeCompare; byte order is stable across locales).
pub fn finish(files: &mut [FileDiff]) {
    for f in files.iter_mut() {
        if generated_path(&f.path) {
            f.generated = true;
        }
    }
    files.sort_by(|x, y| x.path.cmp(&y.path));
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    const DIFF: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -15,6 +15,7 @@\n l15\n l16\n l17\n-l18\n+L18\n l19\n l20\n+l21\n";

    #[test]
    fn rows_gaps_and_counts() {
        let files = parse_diff(DIFF);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(
            (f.path.as_str(), f.status, f.add, f.del),
            ("f.txt", 'M', 3, 2)
        );
        assert_eq!(f.rows[0], Row::context("l1", 1, 1));
        assert_eq!(f.rows[1], Row::removed("l2", 2));
        assert_eq!(f.rows[2], Row::added("L2", 2));
        // after l5 (b=6) the next hunk starts at 15: a gap of 9
        assert_eq!(f.rows[6], Row::gap(9));
        assert_eq!(f.rows.last(), Some(&Row::added("l21", 21)));
    }

    #[test]
    fn statuses_renames_binaries() {
        let out = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+hi\ndiff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-bye\ndiff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
        let f = parse_diff(out);
        assert_eq!(f.iter().map(|x| x.status).collect::<String>(), "ADRM");
        assert_eq!(f[2].path, "new name.txt");
        assert_eq!(f[2].from.as_deref(), Some("old name.txt"));
        assert!(f[3].binary);
        assert_eq!(f[0].rows, vec![Row::added("hi", 1)]);
        assert_eq!(f[1].rows, vec![Row::removed("bye", 1)]);
    }

    #[test]
    fn a_path_with_b_in_it() {
        let f = parse_diff("diff --git a/x b/y b/x b/y\n");
        assert_eq!(f[0].path, "x b/y");
        assert_eq!(parse_diff("diff --git a/old b/new\n")[0].path, "new");
    }

    #[test]
    fn rows_cap_at_2000_and_count_the_rest() {
        let mut out = String::from("diff --git a/big b/big\n@@ -0,0 +1,2500 @@\n");
        for i in 0..2500 {
            let _ = writeln!(out, "+line {i}");
        }
        let f = &parse_diff(&out)[0];
        assert_eq!((f.rows.len(), f.more, f.add), (DIFF_LINES, 500, 2500));
    }

    #[test]
    fn untracked_whole_binary_and_empty() {
        let f = untracked_file("a.txt", b"one\ntwo\n");
        assert_eq!((f.add, f.rows.len(), f.status), (2, 2, 'A'));
        assert_eq!(f.rows[1], Row::added("two", 2));
        let mut bin = vec![b'x'; 100];
        bin[50] = 0;
        assert!(untracked_file("b.bin", &bin).binary);
        let mut late = vec![b'x'; 9000];
        late[8500] = 0;
        assert!(
            !untracked_file("late", &late).binary,
            "a NUL past 8000 bytes is text"
        );
        let e = untracked_file("empty", b"");
        assert_eq!((e.add, e.rows.len()), (0, 0));
        let big: String = (0..2100).fold(String::new(), |mut s, i| {
            let _ = writeln!(s, "{i}");
            s
        });
        let g = untracked_file("g", big.as_bytes());
        assert_eq!((g.rows.len(), g.more, g.add), (DIFF_LINES, 100, 2100));
    }

    #[test]
    fn generated_paths() {
        for p in [
            "package-lock.json",
            "web/yarn.lock",
            "Cargo.lock",
            "x.lock",
            "a/b.min.js",
            "s.min.css",
            "dist/a.js",
            "pkg/build/x",
            "go.sum",
        ] {
            assert!(generated_path(p), "{p}");
        }
        for p in [
            "src/lib.rs",
            "distance.rs",
            "builder/x.rs",
            "lock.rs",
            "README.md",
        ] {
            assert!(!generated_path(p), "{p}");
        }
    }

    #[test]
    fn finish_flags_and_sorts() {
        let mut v = vec![
            FileDiff::new("z", 'M'),
            FileDiff::new("Cargo.lock", 'M'),
            FileDiff::new("a", 'A'),
        ];
        finish(&mut v);
        assert_eq!(
            v.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["Cargo.lock", "a", "z"]
        );
        assert!(v[0].generated && !v[1].generated);
    }
}
