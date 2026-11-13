//! Deciders for what new work branches from and when to fetch again (edge case Git 4), and where git
//! itself lives (edge case Git 2). The host asks git the questions; these decide from the answers.

use std::collections::HashMap;

use wisp_git_api::BaseRef;

/// A whole-remote fetch is good for this long: tasks launched back to back share one.
pub const FETCH_FRESH_MS: i64 = 60_000;

/// The refs to try, in order, once origin exists: origin/HEAD's target, origin/main, origin/master.
pub fn base_candidates(origin_head: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in [origin_head.unwrap_or(""), "origin/main", "origin/master"] {
        if !r.is_empty() && !out.iter().any(|x| x == r) {
            out.push(r.to_owned());
        }
    }
    out
}

/// The base from what git answered: the first candidate that resolved to a commit, else HEAD with no
/// remote, else None (a repo without commits gets no worktree).
pub fn choose_base(resolved: &[(String, Option<String>)], head_sha: Option<&str>, head_branch: &str) -> Option<BaseRef> {
    if let Some((r, Some(sha))) = resolved.iter().find(|(_, sha)| sha.is_some()) {
        let branch = r.strip_prefix("origin/").unwrap_or(r).to_owned();
        return Some(BaseRef { reference: r.clone(), branch, remote: Some("origin".into()), sha: sha.clone() });
    }
    let sha = head_sha.filter(|s| !s.is_empty())?;
    Some(BaseRef { reference: sha.to_owned(), branch: head_branch.to_owned(), remote: None, sha: sha.to_owned() })
}

/// When each repo's remote was last fetched. Pure: the caller passes the time.
#[derive(Debug, Default)]
pub struct FetchClock {
    at: HashMap<String, i64>,
}

impl FetchClock {
    /// true: fetch now (and the time is recorded); false: the last one is still fresh.
    pub fn due(&mut self, key: &str, now_ms: i64, max_age_ms: i64) -> bool {
        match self.at.get(key) {
            Some(&t) if now_ms - t < max_age_ms && now_ms >= t => false,
            _ => {
                self.at.insert(key.to_owned(), now_ms);
                true
            }
        }
    }
    pub fn forget(&mut self, key: &str) {
        self.at.remove(key);
    }
}

/// Which git to run (edge case Git 2): the first executable `git` on PATH; on macOS, `/usr/bin/git` is
/// an xcrun shim (~200 ms a call), so the developer folder's own git (read from
/// `/var/db/xcode_select_link`) wins when it exists. None: not installed yet, look again next time.
pub fn pick_git(on_path: &[String], platform: &str, xcode_git: Option<&str>) -> Option<String> {
    let first = on_path.first()?;
    if platform == "macos" && first == "/usr/bin/git" {
        return Some(xcode_git.map_or_else(|| first.clone(), str::to_owned));
    }
    Some(first.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_in_order_without_duplicates() {
        assert_eq!(base_candidates(Some("origin/develop")), ["origin/develop", "origin/main", "origin/master"]);
        assert_eq!(base_candidates(Some("origin/main")), ["origin/main", "origin/master"]);
        assert_eq!(base_candidates(None), ["origin/main", "origin/master"]);
    }

    #[test]
    fn base_order_origin_then_head_then_none() {
        let r = choose_base(&[("origin/main".into(), None), ("origin/master".into(), Some("abc".into()))], Some("h"), "main");
        assert_eq!(
            r.map(|b| (b.reference, b.branch, b.remote, b.sha)),
            Some(("origin/master".into(), "master".into(), Some("origin".into()), "abc".into()))
        );
        let head = choose_base(&[("origin/main".into(), None)], Some("deadbeef"), "feature");
        assert_eq!(head.map(|b| (b.reference, b.branch, b.remote)), Some(("deadbeef".into(), "feature".into(), None)));
        assert_eq!(choose_base(&[], None, ""), None, "a repo with no commits gets no worktree");
        assert_eq!(choose_base(&[], Some(""), ""), None);
    }

    #[test]
    fn fetch_is_good_for_a_minute() {
        let mut c = FetchClock::default();
        assert!(c.due("/r", 1_000, FETCH_FRESH_MS));
        assert!(!c.due("/r", 30_000, FETCH_FRESH_MS));
        assert!(c.due("/other", 30_000, FETCH_FRESH_MS), "per repo");
        assert!(c.due("/r", 61_000, FETCH_FRESH_MS));
        assert!(c.due("/r", 10, FETCH_FRESH_MS), "a clock that went back fetches");
        c.forget("/r");
        assert!(c.due("/r", 11, FETCH_FRESH_MS));
        assert!(c.due("/r", 12, 0), "max age 0 always fetches");
    }

    #[test]
    fn git_path_choice() {
        let p = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            pick_git(&p(&["/opt/homebrew/bin/git", "/usr/bin/git"]), "macos", Some("/X/usr/bin/git")).as_deref(),
            Some("/opt/homebrew/bin/git")
        );
        assert_eq!(
            pick_git(&p(&["/usr/bin/git"]), "macos", Some("/Library/Developer/CommandLineTools/usr/bin/git")).as_deref(),
            Some("/Library/Developer/CommandLineTools/usr/bin/git")
        );
        assert_eq!(pick_git(&p(&["/usr/bin/git"]), "macos", None).as_deref(), Some("/usr/bin/git"));
        assert_eq!(pick_git(&p(&["/usr/bin/git"]), "linux", Some("/x")).as_deref(), Some("/usr/bin/git"));
        assert_eq!(pick_git(&[], "linux", None), None);
    }
}
