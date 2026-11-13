//! Done asks about the worktree (design/worktrees-on-done.md). A task marked done, and what ran under it
//! (its other folders, subagents', delegated jobs', compare runs done with it), may hold folders on disk.
//! From the page the user picks (`apply`); Done from anywhere else asks nobody (`tidy`): only what's clean
//! and fully on its branch, with no open PR. The branch always stays.

use std::collections::HashSet;

use wisp_worktrees_api::{OnDone, PrRef};

/// a lead's subagent's delegate's …: far enough, and no loop
pub const DEPTH: usize = 4;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DoneFolder {
    pub path: String,
    pub branch: String,
    pub on_disk: bool,
    pub foreign: bool,
    pub pr: Option<PrRef>,
}

/// A task as Done needs it: `kids` are its children and delegated sessions' ids.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // facts about the task Done reads
pub struct DoneTask {
    pub id: String,
    pub title: String,
    pub kids: Vec<String>,
    pub parent_id: Option<String>,
    pub group_id: Option<String>,
    pub done: bool,
    pub busy: bool,
    pub kept: bool,
    pub parked: bool,
    pub folders: Vec<DoneFolder>,
}

pub fn on_done(setting: Option<&str>) -> OnDone {
    match setting {
        Some("remove") => OnDone::Remove,
        Some("keep") => OnDone::Keep,
        _ => OnDone::Ask,
    }
}

/// The task and every task under it, each once, at most `DEPTH` levels down.
pub fn under<'a>(all: &'a [DoneTask], root: &str) -> Vec<&'a DoneTask> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    walk(all, all.iter().find(|t| t.id == root), &mut seen, 0, &mut out);
    out
}

fn walk<'a>(all: &'a [DoneTask], s: Option<&'a DoneTask>, seen: &mut HashSet<&'a str>, depth: usize, out: &mut Vec<&'a DoneTask>) {
    let Some(s) = s else { return };
    if depth > DEPTH || !seen.insert(s.id.as_str()) {
        return;
    }
    out.push(s);
    let by_id = s.kids.iter().filter_map(|id| all.iter().find(|t| &t.id == id));
    let parented = all.iter().filter(|t| t.parent_id.as_deref() == Some(&s.id));
    // compare runs: the ones marked done with it, not one still in review
    let runs = all.iter().filter(|t| s.group_id.is_some() && t.group_id == s.group_id && t.id != s.id && t.done);
    let kids: Vec<&DoneTask> = by_id.chain(parented).chain(runs).collect();
    for k in kids {
        walk(all, Some(k), seen, depth + 1, out);
    }
}

/// Each folder on disk once, with who holds it: (task, folder). Foreign ones are never offered.
pub fn folders<'a>(all: &'a [DoneTask], root: &str) -> Vec<(&'a DoneTask, &'a DoneFolder)> {
    let mut paths = HashSet::new();
    let mut out = Vec::new();
    for t in under(all, root) {
        for f in &t.folders {
            if f.path.is_empty() || f.foreign || !f.on_disk || !paths.insert(f.path.as_str()) {
                continue;
            }
            out.push((t, f));
        }
    }
    out
}

/// The paths of `remove` and `keep` must be folders this task's Done would list.
pub fn check_paths(all: &[DoneTask], root: &str, remove: &[String], keep: &[String]) -> Result<(), String> {
    let mine: HashSet<&str> = folders(all, root).into_iter().map(|(_, f)| f.path.as_str()).collect();
    match remove.iter().chain(keep).find(|p| !mine.contains(p.as_str())) {
        Some(p) => Err(format!("Not a folder of this task: {p}")),
        None => Ok(()),
    }
}

/// Why a removal the user asked for didn't happen.
pub fn failure_text(busy: bool, error: Option<&str>, dirty: Option<u32>) -> String {
    if busy {
        return "It’s in use.".into();
    }
    if let Some(e) = error {
        return e.to_owned();
    }
    match dirty {
        Some(n) => format!("It holds work of its own ({n} change{}): tick it to remove it anyway.", if n == 1 { "" } else { "s" }),
        None => "It couldn’t be removed.".into(),
    }
}

/// Done with nobody to ask: the folders tidy may remove, given what only each holds (`only(path)`).
pub fn tidy_candidates<'a>(all: &'a [DoneTask], root: &str, setting: OnDone, only: impl Fn(&str) -> Option<u32>) -> Vec<&'a DoneFolder> {
    if setting == OnDone::Keep {
        return Vec::new();
    }
    folders(all, root)
        .into_iter()
        .filter(|(t, f)| !t.busy && !t.kept && !t.parked && f.pr.as_ref().is_none_or(|p| p.state != "OPEN"))
        .filter(|(_, f)| only(&f.path) == Some(0))
        .map(|(_, f)| f)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrand::Rng;

    fn folder(path: &str) -> DoneFolder {
        DoneFolder { path: path.into(), branch: format!("wisp/{path}"), on_disk: true, ..DoneFolder::default() }
    }
    fn t(id: &str, folders: &[&str]) -> DoneTask {
        DoneTask { id: id.into(), folders: folders.iter().map(|p| folder(p)).collect(), ..DoneTask::default() }
    }

    #[test]
    fn lists_the_task_and_everything_under_it_once_each() {
        let lead = DoneTask { kids: vec!["sub".into(), "gone".into()], group_id: Some("g".into()), ..t("lead", &["/w/lead", "/w/also"]) };
        let sub = DoneTask { parent_id: Some("lead".into()), ..t("sub", &["/w/lead"]) }; // works in its lead's folder
        let child = DoneTask { parent_id: Some("sub".into()), ..t("child", &["/w/child"]) };
        let run_done = DoneTask { group_id: Some("g".into()), done: true, ..t("run1", &["/w/run1"]) };
        let run_review = DoneTask { group_id: Some("g".into()), ..t("run2", &["/w/run2"]) };
        let mut foreign = t("foreign", &["/w/foreign"]);
        foreign.parent_id = Some("lead".into());
        foreign.folders[0].foreign = true;
        let mut gone = t("off", &["/w/off"]);
        gone.parent_id = Some("lead".into());
        gone.folders[0].on_disk = false;
        let all = [lead, sub, child, run_done, run_review, foreign, gone];
        let paths: Vec<&str> = folders(&all, "lead").iter().map(|(_, f)| f.path.as_str()).collect();
        assert_eq!(paths, ["/w/lead", "/w/also", "/w/child", "/w/run1"]);
        assert_eq!(folders(&all, "lead")[0].0.id, "lead", "a subagent in its lead's folder is the lead's");
    }

    #[test]
    fn a_loop_or_a_deep_chain_stops() {
        let a = DoneTask { kids: vec!["b".into()], ..t("a", &["/a"]) };
        let b = DoneTask { kids: vec!["a".into()], ..t("b", &["/b"]) };
        assert_eq!(under(&[a, b], "a").len(), 2);
        let chain: Vec<DoneTask> = (0..10).map(|i| DoneTask { kids: vec![format!("n{}", i + 1)], ..t(&format!("n{i}"), &[]) }).collect();
        assert_eq!(under(&chain, "n0").len(), DEPTH + 1);
    }

    #[test]
    fn apply_refuses_a_path_that_isnt_the_tasks_and_says_why_a_removal_failed() {
        let all = [t("a", &["/a"]), t("b", &["/b"])];
        assert!(check_paths(&all, "a", &["/a".into()], &[]).is_ok());
        assert_eq!(check_paths(&all, "a", &[], &["/b".into()]), Err("Not a folder of this task: /b".into()));
        assert_eq!(failure_text(true, None, None), "It’s in use.");
        assert!(failure_text(false, None, Some(1)).contains("1 change)"));
        assert!(failure_text(false, None, Some(2)).contains("2 changes)"));
        assert_eq!(failure_text(false, Some("boom"), Some(2)), "boom");
    }

    #[test]
    fn tidy_takes_only_clean_folders_with_no_open_pr_and_nothing_when_set_to_keep() {
        let mut pr = t("pr", &["/pr"]);
        pr.folders[0].pr = Some(PrRef { number: 1, url: String::new(), state: "OPEN".into() });
        let mut merged = t("merged", &["/merged"]);
        merged.folders[0].pr = Some(PrRef { number: 2, url: String::new(), state: "MERGED".into() });
        let lead =
            DoneTask { kids: ["pr", "merged", "dirty", "kept", "busy", "unknown"].map(String::from).to_vec(), ..t("lead", &["/lead"]) };
        let kept = DoneTask { kept: true, ..t("kept", &["/kept"]) };
        let busy = DoneTask { busy: true, ..t("busy", &["/busy"]) };
        let all = [lead, pr, merged, t("dirty", &["/dirty"]), kept, busy, t("unknown", &["/unknown"])];
        let only = |p: &str| match p {
            "/dirty" => Some(1),
            "/unknown" => None,
            _ => Some(0),
        };
        let got: Vec<&str> = tidy_candidates(&all, "lead", OnDone::Ask, only).iter().map(|f| f.path.as_str()).collect();
        assert_eq!(got, ["/lead", "/merged"]);
        assert!(tidy_candidates(&all, "lead", OnDone::Keep, only).is_empty());
        assert_eq!(on_done(Some("remove")), OnDone::Remove);
        assert_eq!(on_done(Some("bogus")), OnDone::Ask);
    }

    #[test]
    fn prop_folders_are_unique_and_never_foreign() {
        let mut r = Rng::new(29);
        for _ in 0..500 {
            let n = 1 + r.below(8);
            let all: Vec<DoneTask> = (0..n)
                .map(|i| {
                    let mut x = t(&format!("t{i}"), &[]);
                    x.kids = (0..r.below(3)).map(|_| format!("t{}", r.below(n))).collect();
                    x.folders = (0..r.below(3))
                        .map(|_| DoneFolder { foreign: r.below(4) == 0, on_disk: r.below(5) > 0, ..folder(&format!("/p{}", r.below(6))) })
                        .collect();
                    x
                })
                .collect();
            let got = folders(&all, "t0");
            let mut seen = HashSet::new();
            for (_, f) in &got {
                assert!(seen.insert(&f.path) && !f.foreign && f.on_disk);
            }
        }
    }
}
