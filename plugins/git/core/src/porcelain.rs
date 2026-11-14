//! Readers for git's machine output: `status --porcelain=v2 -z --branch`, `worktree list --porcelain`,
//! `for-each-ref`, `rev-list --count`, `merge-tree --write-tree` (edge case Git 9), and the one-line
//! reason a failed git or gh gives.

use wisp_git_api::{Branch, MergeTree, Status, StatusEntry, WorktreeEntry};

/// `git status --porcelain=v2 -z --branch` (NUL-separated, so any path is safe).
pub fn parse_status(out: &[u8]) -> Status {
    let text = String::from_utf8_lossy(out);
    let mut s = Status::default();
    let mut fields = text.split('\0');
    while let Some(rec) = fields.next() {
        if let Some(h) = rec.strip_prefix("# ") {
            branch_header(&mut s, h);
            continue;
        }
        let mut parts = rec.splitn(2, ' ');
        let (kind, rest) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        match kind {
            "1" => {
                if let Some((xy, path)) = nth_field(rest, 7) {
                    s.entries.push(StatusEntry { path, xy, from: None });
                }
            }
            "2" => {
                if let Some((xy, path)) = nth_field(rest, 8) {
                    let from = fields.next().map(str::to_owned);
                    s.entries.push(StatusEntry { path, xy, from });
                }
            }
            "u" => {
                if let Some((xy, path)) = nth_field(rest, 9) {
                    s.conflicted += 1;
                    s.entries.push(StatusEntry { path, xy, from: None });
                }
            }
            "?" if !rest.is_empty() => s.entries.push(StatusEntry { path: rest.to_owned(), xy: "??".into(), from: None }),
            _ => {}
        }
    }
    s
}

/// The XY code (first field) and the path after `skip` more space-separated fields.
fn nth_field(rest: &str, skip: usize) -> Option<(String, String)> {
    let xy = rest.split(' ').next()?.to_owned();
    let path = rest.splitn(skip + 1, ' ').nth(skip)?.to_owned();
    Some((xy, path))
}

fn branch_header(s: &mut Status, h: &str) {
    if let Some(oid) = h.strip_prefix("branch.oid ") {
        s.head = if oid == "(initial)" { String::new() } else { oid.to_owned() };
    } else if let Some(name) = h.strip_prefix("branch.head ") {
        s.branch = if name == "(detached)" { String::new() } else { name.to_owned() };
    } else if let Some(up) = h.strip_prefix("branch.upstream ") {
        s.upstream = Some(up.to_owned());
    } else if let Some(ab) = h.strip_prefix("branch.ab ") {
        let mut it = ab.split(' ');
        s.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
        s.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
    }
}

/// `git worktree list --porcelain`: blank-line separated records.
pub fn parse_worktrees(out: &str) -> Vec<WorktreeEntry> {
    let mut list = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            list.extend(cur.take());
            cur = Some(WorktreeEntry { path: p.to_owned(), ..WorktreeEntry::default() });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        if let Some(h) = line.strip_prefix("HEAD ") {
            h.clone_into(&mut w.head);
        } else if let Some(b) = line.strip_prefix("branch ") {
            b.strip_prefix("refs/heads/").unwrap_or(b).clone_into(&mut w.branch);
        } else if line == "bare" {
            w.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
        }
    }
    list.extend(cur);
    list
}

/// The `for-each-ref` format `parse_branches` reads.
pub const BRANCH_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)";

/// `git for-each-ref refs/heads refs/remotes` in `BRANCH_FORMAT`. Symbolic `origin/HEAD` is left out.
pub fn parse_branches(out: &str) -> Vec<Branch> {
    out.lines()
        .filter_map(|line| {
            let mut f = line.split('\0');
            let refname = f.next()?;
            let sha = f.next()?.to_owned();
            let current = f.next() == Some("*");
            let upstream = f.next().filter(|u| !u.is_empty()).map(str::to_owned);
            let (name, remote) =
                if let Some(n) = refname.strip_prefix("refs/heads/") { (n, false) } else { (refname.strip_prefix("refs/remotes/")?, true) };
            if remote && name.ends_with("/HEAD") {
                return None;
            }
            Some(Branch { name: name.to_owned(), sha, remote, current, upstream })
        })
        .collect()
}

/// `rev-list --count` output; None for anything that isn't a count.
pub fn parse_count(out: &str) -> Option<u32> {
    out.trim().parse().ok()
}

/// `merge-tree --write-tree --name-only --no-messages a b`: exit 0 merges cleanly; exit 1 conflicts,
/// stdout being the tree id then one conflicted path per line; any other exit (git < 2.38 doesn't
/// know --write-tree) is "can't tell".
pub fn read_merge_tree(code: Option<i32>, stdout: &str) -> MergeTree {
    match code {
        Some(0) => MergeTree::Clean,
        Some(1) => {
            let mut files: Vec<String> = Vec::new();
            for l in stdout.trim().lines().skip(1).filter(|l| !l.is_empty()) {
                if !files.iter().any(|f| f == l) {
                    files.push(l.to_owned());
                }
            }
            MergeTree::Conflict { files }
        }
        _ => MergeTree::Unknown,
    }
}

/// Paths of a NUL- or newline-separated list, empties dropped.
pub fn paths(out: &str) -> Vec<String> {
    out.split(['\0', '\n']).filter(|p| !p.is_empty()).map(str::to_owned).collect()
}

/// The reason a failed git or gh gives: its first `fatal:`/`error:` line, else its last three lines,
/// else `fallback`. With `strip`, the `fatal: ` prefix goes (what stage.js shows).
pub fn why(stderr: &str, fallback: &str, strip: bool) -> String {
    let lines: Vec<&str> = stderr.trim().lines().filter(|l| !l.trim().is_empty()).collect();
    let lead = |l: &str| {
        let low = l.to_ascii_lowercase();
        ["fatal", "error"].iter().any(|p| low.starts_with(p) && low[p.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric()))
    };
    let pick = lines.iter().find(|l| lead(l)).map_or_else(|| lines[lines.len().saturating_sub(3)..].join(" "), |l| (*l).to_owned());
    let pick = if pick.is_empty() { fallback.to_owned() } else { pick };
    if strip {
        for p in ["fatal:", "error:", "Fatal:", "Error:", "FATAL:", "ERROR:"] {
            if let Some(r) = pick.strip_prefix(p) {
                return r.trim_start().to_owned();
            }
        }
    }
    pick
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2_branch_entries_renames_conflicts_untracked() {
        let out = "# branch.oid 1234abcd\0# branch.head wisp/x-abc123\0# branch.upstream origin/wisp/x-abc123\0# branch.ab +2 -1\x001 .M N... 100644 100644 100644 aaa bbb src/a b.rs\x002 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0u UU N... 100644 100644 100644 100644 a b c both.rs\0? new dir/\0! ignored\0";
        let s = parse_status(out.as_bytes());
        assert_eq!(
            (s.head.as_str(), s.branch.as_str(), s.upstream.as_deref()),
            ("1234abcd", "wisp/x-abc123", Some("origin/wisp/x-abc123"))
        );
        assert_eq!((s.ahead, s.behind, s.conflicted, s.dirty()), (2, 1, 1, 4));
        assert_eq!(s.entries[0], StatusEntry { path: "src/a b.rs".into(), xy: ".M".into(), from: None });
        assert_eq!(s.entries[1].from.as_deref(), Some("old.rs"));
        assert_eq!(s.entries[1].path, "new.rs");
        assert_eq!(s.entries[3].xy, "??");
    }

    #[test]
    fn status_initial_and_detached() {
        let s = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((s.head.as_str(), s.branch.as_str(), s.dirty()), ("", "", 0));
        assert_eq!(parse_status(b""), Status::default());
    }

    #[test]
    fn worktree_list() {
        let out = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/one\nHEAD bbb\ndetached\nlocked reason\n\nworktree /w/two\nHEAD ccc\nbranch refs/heads/wisp/t-1\nprunable gitdir file points to non-existent location\n";
        let w = parse_worktrees(out);
        assert_eq!(w.len(), 3);
        assert_eq!((w[0].path.as_str(), w[0].branch.as_str()), ("/r", "main"));
        assert!(w[1].locked && w[1].branch.is_empty());
        assert!(w[2].prunable && w[2].branch == "wisp/t-1");
    }

    #[test]
    fn branches_local_and_remote() {
        let out = "refs/heads/main\0aaa\0*\0origin/main\nrefs/heads/wisp/x\0bbb\0 \0\nrefs/remotes/origin/HEAD\0aaa\0 \0\nrefs/remotes/origin/main\0aaa\0 \0\nrefs/tags/v1\0ddd\0 \0\n";
        let b = parse_branches(out);
        assert_eq!(b.len(), 3);
        assert!(b[0].current && b[0].upstream.as_deref() == Some("origin/main"));
        assert!(!b[1].current && b[1].upstream.is_none());
        assert!(b[2].remote && b[2].name == "origin/main");
    }

    #[test]
    fn merge_tree_exit_codes() {
        assert_eq!(read_merge_tree(Some(0), "tree\n"), MergeTree::Clean);
        assert_eq!(
            read_merge_tree(Some(1), "abc123\nmath.js\nmath.js\nutil.js\n"),
            MergeTree::Conflict { files: vec!["math.js".into(), "util.js".into()] }
        );
        assert_eq!(read_merge_tree(Some(129), "usage: git merge-tree"), MergeTree::Unknown, "git < 2.38");
        assert_eq!(read_merge_tree(None, ""), MergeTree::Unknown, "killed");
    }

    #[test]
    fn counts_and_paths() {
        assert_eq!(parse_count("12\n"), Some(12));
        assert_eq!(parse_count("fatal"), None);
        assert_eq!(paths("a\0b c\0\0"), ["a", "b c"]);
    }

    #[test]
    fn why_picks_the_useful_line() {
        assert_eq!(why("hint: x\nfatal: not a git repository\nmore", "x", false), "fatal: not a git repository");
        assert_eq!(why("error: pathspec 'x' did not match\n", "x", true), "pathspec 'x' did not match");
        assert_eq!(why("a\nb\nc\nd\n", "x", false), "b c d");
        assert_eq!(why("", "exit 1", false), "exit 1");
        assert_eq!(why("errors happen\n", "x", false), "errors happen", "a word starting with error isn't a lead");
    }
}
