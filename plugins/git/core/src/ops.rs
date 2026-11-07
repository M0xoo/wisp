//! Deciders for Changes' Revert and Stage (v1 routes/workspace.js): from the file as Changes lists it
//! and what the page asked, what to do, or why not. A hunk the page showed that has moved or changed
//! since (its key) is refused as stale (edge case Git 10), never applied to whatever is there now.

use wisp_git_api::FileDiff;

use crate::hunks::hunks_of;
use crate::mask::same_hunk;
use crate::stage::hunkable;

pub const STALE: &str = "This part changed since you looked: Changes is up to date now.";
pub const NOT_STAGED: &str = "That isn’t staged any more: Changes is up to date now.";
pub const NOTHING_TO_STAGE: &str =
    "There’s nothing left to stage there: Changes is up to date now.";
pub const NOT_HERE: &str = "That file isn’t in this task’s folder.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// 409: what the page showed is out of date
    Stale(&'static str),
    /// 400: the request can't be done this way
    Bad(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertPlan {
    /// put hunk `index` back in the file's text
    Hunk { index: usize },
    /// the whole file: `remove` goes (an added file, a rename's new name), `restore` comes back from the
    /// merge-base (`git restore --source=<at> --worktree`), the working tree only so Undo puts it back
    File {
        remove: Option<String>,
        restore: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagePlan {
    Hunk {
        index: usize,
    },
    /// the file and, for a rename, its old name
    Files(Vec<String>),
}

/// Checks a hunk request against the file: a real index, the key the page saw, and not the last
/// hunk of a file whose rows were cut (`more`): that part is longer than Changes shows.
fn check_hunk(
    f: &FileDiff,
    index: usize,
    key: Option<&str>,
    too_long: &'static str,
) -> Result<(), Refusal> {
    let hs = hunks_of(&f.rows);
    let Some(h) = hs.get(index) else {
        return Err(Refusal::Stale(STALE));
    };
    if key.is_some_and(|k| !k.is_empty() && !same_hunk(&h.rows, k)) {
        return Err(Refusal::Stale(STALE));
    }
    if f.more > 0 && index + 1 == hs.len() {
        return Err(Refusal::Bad(too_long));
    }
    Ok(())
}

pub fn plan_revert(
    f: Option<&FileDiff>,
    hunk: Option<usize>,
    key: Option<&str>,
) -> Result<RevertPlan, Refusal> {
    let f = f.ok_or(Refusal::Stale(STALE))?;
    if let Some(index) = hunk {
        if matches!(f.status, 'A' | 'D') || f.binary {
            return Err(Refusal::Bad(
                "That file is new or deleted as a whole: revert the file.",
            ));
        }
        check_hunk(
            f,
            index,
            key,
            "That part is longer than Changes shows: revert the file, or edit it.",
        )?;
        return Ok(RevertPlan::Hunk { index });
    }
    let remove = matches!(f.status, 'A' | 'R').then(|| f.path.clone());
    let restore = (f.status != 'A').then(|| f.from.clone().unwrap_or_else(|| f.path.clone()));
    Ok(RevertPlan::File { remove, restore })
}

pub fn plan_stage(
    f: Option<&FileDiff>,
    hunk: Option<usize>,
    key: Option<&str>,
) -> Result<StagePlan, Refusal> {
    let f = f.ok_or(Refusal::Stale(STALE))?;
    if let Some(index) = hunk {
        if !hunkable(f) {
            return Err(Refusal::Bad(
                "That file is new, deleted or binary: stage the whole file.",
            ));
        }
        check_hunk(
            f,
            index,
            key,
            "That part is longer than Changes shows: stage the file.",
        )?;
        return Ok(StagePlan::Hunk { index });
    }
    let mut paths = vec![f.path.clone()];
    paths.extend(f.from.clone());
    Ok(StagePlan::Files(paths))
}

/// A path the editor or a revert may touch, lexically: relative, inside the folder, not under `.git`.
/// The host still checks the real path (no link out of the folder). Returns it normalised.
pub fn lexical_path(rel: &str) -> Option<String> {
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.starts_with('\\')
        || rel.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() || parts[0] == ".git" {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_diff;
    use crate::hunks::hunk_key;

    const DIFF: &str = "diff --git a/f.txt b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,3 @@\n j\n-k\n+K\n l\n";

    fn file() -> FileDiff {
        parse_diff(DIFF).remove(0)
    }

    #[test]
    fn revert_a_hunk_checks_its_key() {
        let f = file();
        let key = hunk_key(&hunks_of(&f.rows)[1].rows);
        assert_eq!(
            plan_revert(Some(&f), Some(1), Some(&key)),
            Ok(RevertPlan::Hunk { index: 1 })
        );
        assert_eq!(
            plan_revert(Some(&f), Some(0), Some(&key)),
            Err(Refusal::Stale(STALE)),
            "the hunk at 0 isn't the one shown"
        );
        assert_eq!(
            plan_revert(Some(&f), Some(2), None),
            Err(Refusal::Stale(STALE))
        );
        assert_eq!(
            plan_revert(None, None, None),
            Err(Refusal::Stale(STALE)),
            "a file Changes no longer lists"
        );
    }

    #[test]
    fn revert_refuses_hunks_of_whole_files_and_cut_rows() {
        let mut f = file();
        f.status = 'A';
        assert!(matches!(
            plan_revert(Some(&f), Some(0), None),
            Err(Refusal::Bad(_))
        ));
        let mut cut = file();
        cut.more = 10;
        assert!(
            matches!(plan_revert(Some(&cut), Some(1), None), Err(Refusal::Bad(m)) if m.contains("longer"))
        );
        assert_eq!(
            plan_revert(Some(&cut), Some(0), None),
            Ok(RevertPlan::Hunk { index: 0 }),
            "an earlier hunk is whole"
        );
    }

    #[test]
    fn revert_whole_files() {
        let mut f = file();
        assert_eq!(
            plan_revert(Some(&f), None, None),
            Ok(RevertPlan::File {
                remove: None,
                restore: Some("f.txt".into())
            })
        );
        f.status = 'A';
        assert_eq!(
            plan_revert(Some(&f), None, None),
            Ok(RevertPlan::File {
                remove: Some("f.txt".into()),
                restore: None
            })
        );
        f.status = 'R';
        f.from = Some("old.txt".into());
        assert_eq!(
            plan_revert(Some(&f), None, None),
            Ok(RevertPlan::File {
                remove: Some("f.txt".into()),
                restore: Some("old.txt".into())
            })
        );
        f.status = 'D';
        f.from = None;
        assert_eq!(
            plan_revert(Some(&f), None, None),
            Ok(RevertPlan::File {
                remove: None,
                restore: Some("f.txt".into())
            })
        );
    }

    #[test]
    fn stage_plans() {
        let mut f = file();
        assert_eq!(
            plan_stage(Some(&f), Some(0), None),
            Ok(StagePlan::Hunk { index: 0 })
        );
        f.from = Some("old.txt".into());
        assert_eq!(
            plan_stage(Some(&f), None, None),
            Ok(StagePlan::Files(vec!["f.txt".into(), "old.txt".into()]))
        );
        f.status = 'A';
        assert!(matches!(
            plan_stage(Some(&f), Some(0), None),
            Err(Refusal::Bad(_))
        ));
    }

    #[test]
    fn lexical_paths() {
        assert_eq!(lexical_path("src/./a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(lexical_path("src/../b.rs").as_deref(), Some("b.rs"));
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../../x",
            ".git/config",
            "./.git/HEAD",
            "C:\\x",
            ".",
            "a/..",
        ] {
            assert_eq!(lexical_path(bad), None, "{bad}");
        }
    }
}
