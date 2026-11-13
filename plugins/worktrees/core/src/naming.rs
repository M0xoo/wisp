//! Names and places (edge case Git 5): the branch `wisp/<slug≤32>-<id[0..6]>`, the full id when that's
//! taken; the folder `<home>/worktrees/<repo>-<id>`; a launch from a subfolder keeps that subfolder.
//! Paths are plain `/`-separated strings here: the host canonicalises them first.

/// Lowercase, runs of anything but [a-z0-9] become one '-', trimmed, at most 32 chars, no '-' at the end.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(40));
    let mut dash = false;
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    let cut: String = out.chars().take(32).collect();
    cut.trim_end_matches('-').to_owned()
}

fn first_chars(id: &str, n: usize) -> &str {
    id.char_indices().nth(n).map_or(id, |(i, _)| &id[..i])
}

/// The short branch name for a session (`wisp/fix-login-0192ab`).
pub fn short_branch(title: &str, id: &str) -> String {
    let s = slug(title);
    let s = if s.is_empty() { "task".to_owned() } else { s };
    format!("wisp/{s}-{}", first_chars(id, 6))
}

/// The long one, when the short name is taken (a leftover branch, a prefix clash).
pub fn long_branch(title: &str, id: &str) -> String {
    let s = slug(title);
    let s = if s.is_empty() { "task".to_owned() } else { s };
    format!("wisp/{s}-{id}")
}

/// The branch to make, given whether the short one already exists.
pub fn branch_for(title: &str, id: &str, short_taken: bool) -> String {
    if short_taken { long_branch(title, id) } else { short_branch(title, id) }
}

/// A moved task keeps its branch name when it is a plausible ref name and free (v1 unpackWork).
pub fn keeps_branch(name: &str) -> bool {
    !name.is_empty() && name.len() <= 120 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

/// The last path segment.
pub fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}

/// `<home>/worktrees/<basename(root)>-<id>`.
pub fn worktree_dir(home: &str, root: &str, id: &str) -> String {
    format!("{}/worktrees/{}-{id}", home.trim_end_matches('/'), basename(root))
}

/// `cwd` relative to `root`, or None when it is `root` itself or outside it.
pub fn subfolder<'a>(root: &str, cwd: &'a str) -> Option<&'a str> {
    let root = root.trim_end_matches('/');
    let rest = cwd.strip_prefix(root)?.strip_prefix('/')?;
    let rest = rest.trim_end_matches('/');
    (!rest.is_empty() && !rest.split('/').any(|s| s == "..")).then_some(rest)
}

/// Where the agent runs in the new worktree: the same subfolder the launch came from.
pub fn worktree_cwd(dir: &str, root: &str, cwd: &str) -> String {
    match subfolder(root, cwd) {
        Some(sub) => format!("{dir}/{sub}"),
        None => dir.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrand::Rng;

    #[test]
    fn slug_is_short_lowercase_and_dashed() {
        assert_eq!(slug("Fix the login bug!"), "fix-the-login-bug");
        assert_eq!(slug("  --Hello__World--  "), "hello-world");
        assert_eq!(slug(""), "");
        assert_eq!(slug("ÉTÉ ✓"), "t");
        let long = slug("a very long title that goes on and on past thirty-two characters");
        assert!(long.len() <= 32 && !long.ends_with('-'), "{long}");
        assert_eq!(slug("abcdefghijklmnopqrstuvwxyz01234-6789"), "abcdefghijklmnopqrstuvwxyz01234");
    }

    #[test]
    fn branch_is_short_then_full_id_when_taken() {
        let id = "0192abcdef0123456789";
        assert_eq!(branch_for("Fix login", id, false), "wisp/fix-login-0192ab");
        assert_eq!(branch_for("Fix login", id, true), "wisp/fix-login-0192abcdef0123456789");
        assert_eq!(branch_for("!!!", id, false), "wisp/task-0192ab");
    }

    #[test]
    fn a_launch_from_a_subfolder_keeps_it() {
        let dir = worktree_dir("/h/.wisp", "/src/app", "abc");
        assert_eq!(dir, "/h/.wisp/worktrees/app-abc");
        assert_eq!(worktree_cwd(&dir, "/src/app", "/src/app/web/ui"), "/h/.wisp/worktrees/app-abc/web/ui");
        assert_eq!(worktree_cwd(&dir, "/src/app", "/src/app"), dir);
        assert_eq!(worktree_cwd(&dir, "/src/app", "/src/application"), dir, "a sibling with the same prefix is outside");
        assert_eq!(worktree_cwd(&dir, "/src/app", "/elsewhere"), dir);
    }

    #[test]
    fn moved_branch_names() {
        assert!(keeps_branch("wisp/fix-1"));
        assert!(!keeps_branch("bad name"));
        assert!(!keeps_branch(""));
        assert!(!keeps_branch(&"a".repeat(121)));
    }

    #[test]
    fn prop_slug_and_branch_invariants() {
        let mut r = Rng::new(7);
        for _ in 0..2000 {
            let title = r.text(60);
            let id = r.ident(20);
            let s = slug(&title);
            assert!(s.len() <= 32, "{s}");
            assert!(!s.starts_with('-') && !s.ends_with('-') && !s.contains("--"), "{s:?} from {title:?}");
            assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
            assert_eq!(slug(&s), s, "idempotent");
            let short = branch_for(&title, &id, false);
            let long = branch_for(&title, &id, true);
            assert!(short.starts_with("wisp/") && keeps_branch(&short), "{short}");
            assert!(long.ends_with(&id) && long != short || id.len() <= 6);
        }
    }

    #[test]
    fn prop_worktree_cwd_stays_inside_the_worktree() {
        let mut r = Rng::new(11);
        for _ in 0..1000 {
            let root = format!("/r/{}", r.ident(5));
            let cwd = if r.below(2) == 0 { format!("{root}/{}/{}", r.ident(3), r.ident(3)) } else { format!("/x/{}", r.ident(4)) };
            let dir = worktree_dir("/h", &root, "id");
            let at = worktree_cwd(&dir, &root, &cwd);
            assert!(at == dir || at.starts_with(&format!("{dir}/")), "{at}");
        }
    }
}
