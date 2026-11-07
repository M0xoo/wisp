//! Staging from Changes (v1 server/stage.js): git's own diffs (index → folder, HEAD → index) split per
//! file and hunk, a hunk of Changes matched to the git hunks it is made of, and the one-hunk patch
//! `git apply --cached` takes. Changes is diffed from the merge-base, so its hunks and git's differ.

use wisp_git_api::{FileDiff, HunkStage, Row};

use crate::hunks::hunks_of;

/// The diff args git apply reads back exactly, whatever the user's config says.
pub const APPLY_DIFF: &[&str] = &[
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U3",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHunk {
    /// its `@@` line and rows, as git wrote them
    pub text: String,
    pub os: u32,
    pub oc: u32,
    pub ns: u32,
    pub nc: u32,
    /// the lines it changes on the new side: an added line by its number, a removed run by the next line
    pub new_at: Vec<u32>,
    pub old_at: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFile {
    pub path: String,
    /// its lines before the first `@@`
    pub head: Vec<String>,
    pub hunks: Vec<GitHunk>,
}

fn header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let (old, new) = rest[..end].split_once(" +")?;
    let num = |s: &str| -> Option<(u32, u32)> {
        let mut it = s.splitn(2, ',');
        let start = it.next()?.parse().ok()?;
        let count = match it.next() {
            Some(c) => c.parse().ok()?,
            None => 1,
        };
        Some((start, count))
    };
    let ((os, oc), (ns, nc)) = (num(old)?, num(new)?);
    Some((os, oc, ns, nc))
}

/// `git diff` output split per file into its head and hunks.
#[allow(clippy::many_single_char_names)] // o/n: the old and new line, as in git's own docs
pub fn split_diff(out: &str) -> Vec<GitFile> {
    let mut files: Vec<GitFile> = Vec::new();
    let mut lines: Vec<Vec<&str>> = Vec::new(); // per hunk of the current file
    let (mut o, mut n) = (0u32, 0u32);
    let close = |files: &mut Vec<GitFile>, lines: &mut Vec<Vec<&str>>| {
        if let Some(f) = files.last_mut() {
            for (h, l) in f.hunks.iter_mut().zip(lines.drain(..)) {
                h.text = l.join("\n");
            }
        }
    };
    for line in out.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            close(&mut files, &mut lines);
            let path = rest.rfind(" b/").map_or(rest, |at| &rest[at + 3..]);
            files.push(GitFile {
                path: path.to_owned(),
                head: vec![line.to_owned()],
                hunks: Vec::new(),
            });
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if let Some((os, oc, ns, nc)) = header(line) {
            f.hunks.push(GitHunk {
                text: String::new(),
                os,
                oc,
                ns,
                nc,
                new_at: Vec::new(),
                old_at: Vec::new(),
            });
            lines.push(vec![line]);
            o = if oc > 0 { os } else { os + 1 };
            n = if nc > 0 { ns } else { ns + 1 };
            continue;
        }
        let (Some(h), Some(l)) = (f.hunks.last_mut(), lines.last_mut()) else {
            if !line.is_empty() {
                f.head.push(line.to_owned());
            }
            continue;
        };
        match line.as_bytes().first() {
            Some(b'+') => {
                h.new_at.push(n);
                n += 1;
                h.old_at.push(o);
                l.push(line);
            }
            Some(b'-') => {
                h.old_at.push(o);
                o += 1;
                h.new_at.push(n);
                l.push(line);
            }
            Some(b' ') => {
                o += 1;
                n += 1;
                l.push(line);
            }
            Some(b'\\') => l.push(line),
            _ => {}
        }
    }
    close(&mut files, &mut lines);
    files
}

/// A patch of one file with only the hunks picked, ending in a newline.
pub fn patch_of(file: &GitFile, hunks: &[&GitHunk]) -> String {
    let mut parts: Vec<&str> = file.head.iter().map(String::as_str).collect();
    parts.extend(hunks.iter().map(|h| h.text.as_str()));
    let mut out = parts.join("\n");
    out.push('\n');
    out
}

/// A folder line (the new side of index → folder) as the index numbers it, through that diff's
/// hunks; inside one, its old side at the same offset.
pub fn to_index(w: u32, hunks: &[GitHunk]) -> u32 {
    let mut delta: i64 = 0;
    for h in hunks {
        if w < h.ns {
            break;
        }
        let end_new = if h.nc > 0 { h.ns + h.nc } else { h.ns + 1 };
        let end_old = if h.oc > 0 { h.os + h.oc } else { h.os + 1 };
        if w < end_new {
            return h.os + (w - h.ns).min(h.oc.saturating_sub(1));
        }
        delta = i64::from(end_old) - i64::from(end_new);
    }
    u32::try_from((i64::from(w) + delta).max(0)).unwrap_or(0)
}

/// The git hunks whose changes fall in lines `[from, to]` of their new side.
pub fn pick(hunks: &[GitHunk], from: u32, to: u32) -> Vec<&GitHunk> {
    hunks
        .iter()
        .filter(|h| h.new_at.iter().any(|&x| x >= from && x <= to))
        .collect()
}

/// A Changes hunk's span in the folder's lines, with the line after it so a removal at its end counts.
pub fn span_of(start: u32, after_len: usize) -> (u32, u32) {
    let len = u32::try_from(after_len.max(1)).unwrap_or(u32::MAX);
    (start, start.saturating_add(len))
}

/// Per hunk of Changes' rows: has it something to stage (index → folder), is it staged (HEAD → index).
pub fn hunk_states(
    rows: &[Row],
    unstaged: Option<&GitFile>,
    staged: Option<&GitFile>,
) -> Vec<HunkStage> {
    let un: &[GitHunk] = unstaged.map_or(&[], |f| &f.hunks);
    let st: &[GitHunk] = staged.map_or(&[], |f| &f.hunks);
    hunks_of(rows)
        .iter()
        .map(|h| {
            let (a, b) = span_of(h.start, h.after.len());
            HunkStage {
                unstaged: !pick(un, a, b).is_empty(),
                staged: !pick(st, to_index(a, un), to_index(b, un)).is_empty(),
            }
        })
        .collect()
}

/// Hunk staging is for a changed file git tracks: modified or renamed, text, with rows.
pub fn hunkable(f: &FileDiff) -> bool {
    matches!(f.status, 'M' | 'R') && !f.binary && !f.rows.is_empty()
}

/// The patch that stages (or with `unstage`, unstages) Changes hunk `i` of `rows`, cut from git's
/// diff of that file (index → folder to stage; HEAD → index to unstage, applied with `-R`). `unstaged`
/// is always the index → folder diff, which maps folder lines to index lines. None: nothing to move.
#[allow(clippy::many_single_char_names)]
pub fn hunk_patch(
    rows: &[Row],
    i: usize,
    unstaged: Option<&GitFile>,
    staged: Option<&GitFile>,
    unstage: bool,
) -> Option<String> {
    let h = hunks_of(rows).into_iter().nth(i)?;
    let (a, b) = span_of(h.start, h.after.len());
    let un: &[GitHunk] = unstaged.map_or(&[], |f| &f.hunks);
    let (file, picked) = if unstage {
        let f = staged?;
        (f, pick(&f.hunks, to_index(a, un), to_index(b, un)))
    } else {
        let f = unstaged?;
        (f, pick(&f.hunks, a, b))
    };
    if picked.is_empty() {
        return None;
    }
    Some(patch_of(file, &picked))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_diff;

    const DIFF: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -15,6 +15,8 @@\n l15\n l16\n l17\n-l18\n+L18\n+new\n \n l20\n\\ No newline at end of file\ndiff --git a/g.txt b/g.txt\nnew file mode 100644\n--- /dev/null\n+++ b/g.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";

    #[test]
    fn split_per_file_with_both_sides() {
        let files = split_diff(DIFF);
        let (f, g) = (&files[0], &files[1]);
        assert_eq!(f.path, "f.txt");
        assert_eq!(
            f.head,
            [
                "diff --git a/f.txt b/f.txt",
                "index 1..2 100644",
                "--- a/f.txt",
                "+++ b/f.txt"
            ]
        );
        assert_eq!(
            f.hunks
                .iter()
                .map(|h| (h.os, h.oc, h.ns, h.nc))
                .collect::<Vec<_>>(),
            [(1, 5, 1, 5), (15, 6, 15, 8)]
        );
        assert_eq!(
            f.hunks[0].new_at,
            [2, 2],
            "a removed line counts where the next new line is"
        );
        assert_eq!(f.hunks[1].new_at, [18, 18, 19]);
        assert_eq!(f.hunks[1].old_at, [18, 19, 19]);
        assert!(
            f.hunks[1]
                .text
                .ends_with("\n \n l20\n\\ No newline at end of file")
        );
        assert_eq!(g.path, "g.txt");
        assert_eq!(g.hunks[0].new_at, [1, 2]);
    }

    #[test]
    fn patch_has_the_head_and_only_the_picked_hunks() {
        let files = split_diff(DIFF);
        let f = &files[0];
        let p = patch_of(f, &[&f.hunks[1]]);
        assert!(p.starts_with("diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -15,6 +15,8 @@\n"));
        assert!(!p.contains("+L2"));
        assert!(p.ends_with("No newline at end of file\n"));
    }

    #[test]
    fn pick_and_to_index() {
        let files = split_diff(DIFF);
        let h = &files[0].hunks;
        assert_eq!(pick(h, 1, 6), vec![&h[0]]);
        assert_eq!(pick(h, 14, 22), vec![&h[1]]);
        assert!(pick(h, 7, 13).is_empty(), "context alone is no change");
        assert_eq!(to_index(3, h), 3);
        assert_eq!(to_index(10, h), 10);
        assert_eq!(to_index(30, h), 28);
        assert_eq!(
            to_index(16, h),
            16,
            "inside a hunk: its old side at the same offset"
        );
    }

    #[test]
    fn hunk_states_staged_and_not() {
        let rows = parse_diff(DIFF).remove(0).rows;
        assert_eq!(hunks_of(&rows).len(), 2);
        let first = DIFF
            .split("diff --git a/g.txt")
            .next()
            .unwrap_or_default()
            .replace("@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n", "");
        let unstaged = split_diff(&first).remove(0);
        let all = split_diff(DIFF).remove(0);
        let staged = GitFile {
            hunks: vec![all.hunks[0].clone()],
            ..all
        };
        assert_eq!(
            hunk_states(&rows, Some(&unstaged), Some(&staged)),
            [
                HunkStage {
                    unstaged: false,
                    staged: true
                },
                HunkStage {
                    unstaged: true,
                    staged: false
                }
            ]
        );
        assert_eq!(
            hunk_states(&rows, None, None),
            [HunkStage::default(), HunkStage::default()],
            "committed: neither"
        );
    }

    #[test]
    fn hunk_patch_picks_the_right_side() {
        let rows = parse_diff(DIFF).remove(0).rows;
        let all = split_diff(DIFF).remove(0);
        let p = hunk_patch(&rows, 1, Some(&all), None, false).unwrap_or_default();
        assert!(p.contains("+L18") && !p.contains("+L2"));
        assert_eq!(hunk_patch(&rows, 1, None, None, false), None);
        assert_eq!(
            hunk_patch(&rows, 0, Some(&all), Some(&all), true).map(|p| p.contains("+L2")),
            Some(true)
        );
        assert_eq!(
            hunk_patch(&rows, 5, Some(&all), None, false),
            None,
            "no such hunk"
        );
    }

    #[test]
    fn hunkable_files() {
        let mut f = FileDiff::new("a", 'M');
        assert!(!hunkable(&f), "no rows");
        f.rows.push(Row::added("x", 1));
        assert!(hunkable(&f));
        f.status = 'A';
        assert!(!hunkable(&f), "new files stage whole");
        f.status = 'R';
        f.binary = true;
        assert!(!hunkable(&f));
    }

    /// Property: with nothing staged, every git hunk of index → folder is picked by exactly the
    /// Changes hunks that cover its lines, and `to_index` is monotonic.
    #[test]
    fn prop_to_index_monotonic_and_pick_covers() {
        let mut rng = crate::testrng::Rng::new(7);
        for _ in 0..300 {
            let base: Vec<String> = (0..rng.below(50) + 2).map(|i| format!("b{i}")).collect();
            let now = rng.edit(&base);
            let diff = crate::testrng::unified("f", &base, &now);
            let Some(gf) = split_diff(&diff).into_iter().next() else {
                continue;
            };
            let mut last = 0;
            for w in 1..=u32::try_from(now.len() + 2).unwrap_or(0) {
                let i = to_index(w, &gf.hunks);
                assert!(i >= last, "{w}: {i} < {last}\n{diff}");
                last = i;
            }
            let rows = parse_diff(&diff).remove(0).rows;
            let states = hunk_states(&rows, Some(&gf), None);
            assert!(states.iter().all(|s| s.unstaged && !s.staged), "{diff}");
        }
    }
}
