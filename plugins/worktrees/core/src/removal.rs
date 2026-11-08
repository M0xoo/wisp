//! Removal safety (edge case Git 7): what only a folder holds is its changed paths, plus one when HEAD
//! has left the task's branch (a follow-up wouldn't find those commits); "can't tell" counts as dirty;
//! the decision is asked again right before the folder goes (a follow-up may have overtaken a cleanup);
//! a foreign worktree (brought in, under ~/conductor, or in a `.conductor` folder) is never removed,
//! whatever `force` says; a branch goes only when `rev-list base..branch` is 0, unless forced.

use wisp_worktrees_api::{BranchMode, Worktree};

/// Anywhere that looks like Conductor's: a `.conductor` segment, or under `<home>/conductor`.
pub fn in_conductor(path: &str, home: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.split(['/', '\\']).any(|s| s == ".conductor") {
        return true;
    }
    let under = format!("{}/conductor/", home.trim_end_matches('/'));
    path.starts_with(&under)
}

/// Not ours to remove, recreate or tidy. `claimed`: a contributed setup source says the path is its own.
pub fn is_foreign(wt: &Worktree, home: &str, claimed: bool) -> bool {
    wt.foreign || claimed || in_conductor(&wt.path, home)
}

/// Lines of `git status --porcelain`.
pub fn porcelain_count(out: &str) -> u32 {
    u32::try_from(out.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(u32::MAX)
}

/// What only this folder holds: changed paths, plus one when HEAD isn't the branch's tip.
pub fn folder_only(changed: u32, head: &str, branch_tip: Option<&str>) -> u32 {
    changed + u32::from(branch_tip.is_some_and(|tip| tip != head))
}

/// The dirt a removal weighs: strict reads what only the folder holds (None = can't tell = 1), else the
/// plain status count.
pub fn removal_dirt(strict: bool, only: Option<u32>, status_dirty: u32) -> u32 {
    if strict {
        only.unwrap_or(1)
    } else {
        status_dirty
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveStep {
    /// never ours: nothing happens
    Foreign,
    /// the folder is already gone: only the branch question is left
    Gone,
    /// holds work and not forced
    KeepDirty(u32),
    /// re-checked right before: in use again, so it stays
    Overtaken,
    Remove,
}

/// `still`: asked last thing before the folder goes (None: nobody to ask).
pub fn decide_removal(
    foreign: bool,
    exists: bool,
    dirt: u32,
    force: bool,
    still: Option<bool>,
) -> RemoveStep {
    if foreign {
        RemoveStep::Foreign
    } else if !exists {
        RemoveStep::Gone
    } else if dirt > 0 && !force {
        RemoveStep::KeepDirty(dirt)
    } else if still == Some(false) {
        RemoveStep::Overtaken
    } else {
        RemoveStep::Remove
    }
}

/// Delete the branch? `unique`: `rev-list --count base..branch` (None: git couldn't tell, so it stays).
pub fn delete_branch(mode: BranchMode, unique: Option<u32>) -> bool {
    match mode {
        BranchMode::Keep => false,
        BranchMode::Force => true,
        BranchMode::IfMerged => unique == Some(0),
    }
}

/// The refs to count unpushed commits from, in order (edge case Git 6): the merged PR's head (a squash
/// merge leaves the branch ahead of the base for good), else the remote branch. None of them: `ahead`.
pub fn pushed_refs(merged: Option<&str>, remote: Option<&str>, branch: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(m) = merged.filter(|m| !m.is_empty()) {
        out.push(m.to_owned());
    }
    if let Some(r) = remote.filter(|r| !r.is_empty()) {
        out.push(format!("refs/remotes/{r}/{branch}"));
    }
    out
}

/// `counts`: `rev-list --count <ref>..HEAD` for each of `pushed_refs`, None where the ref isn't there.
pub fn unpushed(ahead: u32, counts: &[Option<u32>]) -> u32 {
    counts.iter().find_map(|c| *c).unwrap_or(ahead)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsurePlan {
    /// the folder is there
    Nothing,
    /// a foreign worktree's folder is gone: no prune and no add (that would make a new folder at its path)
    Refuse(String),
    /// prune, add it back on its branch, copy the included files again (setup isn't run again)
    Restore,
}

pub fn ensure_plan(exists: bool, foreign: bool, path: &str) -> EnsurePlan {
    match (exists, foreign) {
        (true, _) => EnsurePlan::Nothing,
        (false, true) => EnsurePlan::Refuse(format!("This worktree's folder is gone: {path}")),
        (false, false) => EnsurePlan::Restore,
    }
}

/// A leftover folder's repo, from its `.git` file (`gitdir: <root>/.git/worktrees/<name>`).
pub fn leftover_root(dot_git: &str) -> Option<String> {
    let line = dot_git
        .lines()
        .find_map(|l| l.strip_prefix("gitdir: "))?
        .trim();
    let norm = line.replace('\\', "/");
    let at = norm.find("/.git/worktrees/")?;
    (at > 0).then(|| norm[..at].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrand::Rng;

    fn wt(path: &str, foreign: bool) -> Worktree {
        Worktree {
            path: path.into(),
            foreign,
            ..Worktree::default()
        }
    }

    #[test]
    fn foreign_worktrees_are_never_removed_whatever_force_says() {
        let home = "/Users/me";
        assert!(is_foreign(&wt("/src/app", true), home, false), "brought in");
        assert!(is_foreign(
            &wt("/Users/me/conductor/workspaces/app/x", false),
            home,
            false
        ));
        assert!(is_foreign(
            &wt("/src/app/.conductor/ws", false),
            home,
            false
        ));
        assert!(
            is_foreign(&wt("/src/app", false), home, true),
            "a setup source claims it"
        );
        assert!(!is_foreign(
            &wt("/Users/me/.wisp/worktrees/app-1", false),
            home,
            false
        ));
        assert!(!is_foreign(
            &wt("/Users/me/conductorish/x", false),
            home,
            false
        ));
        for force in [false, true] {
            assert_eq!(
                decide_removal(true, true, 0, force, Some(true)),
                RemoveStep::Foreign
            );
        }
    }

    #[test]
    fn dirt_keeps_it_unless_forced_and_cant_tell_is_dirty() {
        assert_eq!(folder_only(0, "a", Some("a")), 0);
        assert_eq!(folder_only(2, "a", Some("b")), 3, "HEAD left the branch");
        assert_eq!(folder_only(0, "a", None), 0, "no branch to leave");
        assert_eq!(removal_dirt(true, None, 0), 1, "can't tell = dirty");
        assert_eq!(removal_dirt(false, None, 2), 2);
        assert_eq!(
            decide_removal(false, true, 3, false, None),
            RemoveStep::KeepDirty(3)
        );
        assert_eq!(
            decide_removal(false, true, 3, true, None),
            RemoveStep::Remove
        );
        assert_eq!(
            decide_removal(false, true, 0, false, Some(false)),
            RemoveStep::Overtaken,
            "re-checked right before"
        );
        assert_eq!(
            decide_removal(false, false, 9, false, None),
            RemoveStep::Gone
        );
        assert_eq!(porcelain_count(" M a\n?? b\n"), 2);
        assert_eq!(porcelain_count(""), 0);
    }

    #[test]
    fn a_branch_goes_only_when_nothing_is_only_on_it() {
        assert!(!delete_branch(BranchMode::Keep, Some(0)));
        assert!(delete_branch(BranchMode::IfMerged, Some(0)));
        assert!(!delete_branch(BranchMode::IfMerged, Some(2)));
        assert!(
            !delete_branch(BranchMode::IfMerged, None),
            "can't tell: it stays"
        );
        assert!(delete_branch(BranchMode::Force, Some(5)));
    }

    #[test]
    fn unpushed_counts_from_the_merged_head_then_the_remote_branch_then_ahead() {
        assert_eq!(
            pushed_refs(Some("abc"), Some("origin"), "wisp/x"),
            ["abc", "refs/remotes/origin/wisp/x"]
        );
        assert_eq!(pushed_refs(None, None, "b"), Vec::<String>::new());
        assert_eq!(unpushed(5, &[None, Some(2)]), 2);
        assert_eq!(
            unpushed(5, &[Some(0), Some(2)]),
            0,
            "after a squash merge only newer commits count"
        );
        assert_eq!(unpushed(5, &[None, None]), 5);
    }

    #[test]
    fn ensure_and_leftovers() {
        assert_eq!(ensure_plan(true, true, "/p"), EnsurePlan::Nothing);
        assert!(
            matches!(ensure_plan(false, true, "/p"), EnsurePlan::Refuse(m) if m.contains("/p"))
        );
        assert_eq!(ensure_plan(false, false, "/p"), EnsurePlan::Restore);
        assert_eq!(
            leftover_root("gitdir: /src/app/.git/worktrees/left\n").as_deref(),
            Some("/src/app")
        );
        assert_eq!(
            leftover_root("gitdir: C:\\src\\app\\.git\\worktrees\\x").as_deref(),
            Some("C:/src/app")
        );
        assert_eq!(leftover_root("nonsense"), None);
    }

    #[test]
    fn prop_nothing_with_work_goes_unforced_and_nothing_foreign_ever_goes() {
        let mut r = Rng::new(17);
        for _ in 0..5000 {
            let (foreign, exists, force) = (r.bool(), r.bool(), r.bool());
            let strict = r.bool();
            let only = (r.below(3) > 0).then(|| u32::try_from(r.below(3)).unwrap_or(0));
            let status = u32::try_from(r.below(3)).unwrap_or(0);
            let still = [None, Some(true), Some(false)][usize::try_from(r.below(3)).unwrap_or(0)];
            let dirt = removal_dirt(strict, only, status);
            let step = decide_removal(foreign, exists, dirt, force, still);
            if step == RemoveStep::Remove {
                assert!(!foreign && exists && still != Some(false));
                assert!(force || dirt == 0);
                assert!(
                    force || !strict || only == Some(0),
                    "strict and unforced: only a folder known to be clean goes"
                );
            }
        }
    }
}
