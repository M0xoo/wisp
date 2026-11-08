//! What a worktree session branches from (edge case Git 4): with an `origin`, freshly fetched (a fetch is
//! good for 60 s, so a batch shares one), origin/HEAD, then origin/main, then origin/master; else HEAD's
//! sha with no remote. A repo with no commits gets no worktree. The host asks git for each candidate in
//! the order `candidates` gives and hands what it found to `choose`.

/// A fetch younger than this is reused (tasks launched back to back share one).
pub const FETCH_FRESH_MS: u64 = 60_000;

/// The remote refs to try, in order. `origin_head` is `symbolic-ref --short refs/remotes/origin/HEAD`.
pub fn candidates(has_origin: bool, origin_head: Option<&str>) -> Vec<String> {
    if !has_origin {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::with_capacity(3);
    for r in [origin_head.unwrap_or(""), "origin/main", "origin/master"] {
        if !r.is_empty() && !out.iter().any(|x| x == r) {
            out.push(r.to_owned());
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base {
    pub reference: String,
    pub branch: String,
    pub remote: Option<String>,
    pub sha: String,
}

/// `found`: each candidate with the sha it resolved to (None: not there). `head`: HEAD's sha and the
/// branch it is on. None: nothing to branch from.
pub fn choose(found: &[(String, Option<String>)], head: Option<(&str, &str)>) -> Option<Base> {
    if let Some((r, Some(sha))) = found.iter().find(|(_, s)| s.is_some()) {
        let branch = r.strip_prefix("origin/").unwrap_or(r).to_owned();
        return Some(Base {
            reference: r.clone(),
            branch,
            remote: Some("origin".into()),
            sha: sha.clone(),
        });
    }
    let (sha, branch) = head?;
    (!sha.is_empty()).then(|| Base {
        reference: sha.to_owned(),
        branch: branch.to_owned(),
        remote: None,
        sha: sha.to_owned(),
    })
}

/// Is a fetch made at `at` still good at `now`?
pub fn fetch_fresh(at: Option<i64>, now: i64) -> bool {
    at.is_some_and(|t| now >= t && u64::try_from(now - t).unwrap_or(u64::MAX) < FETCH_FRESH_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrand::Rng;

    fn found(list: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        list.iter()
            .map(|(r, s)| ((*r).to_owned(), s.map(str::to_owned)))
            .collect()
    }

    #[test]
    fn origin_head_then_main_then_master() {
        assert_eq!(
            candidates(true, Some("origin/trunk")),
            ["origin/trunk", "origin/main", "origin/master"]
        );
        assert_eq!(
            candidates(true, Some("origin/main")),
            ["origin/main", "origin/master"],
            "no repeat"
        );
        assert_eq!(candidates(true, None), ["origin/main", "origin/master"]);
        assert!(
            candidates(false, Some("origin/main")).is_empty(),
            "no origin: HEAD"
        );
        let b = choose(
            &found(&[
                ("origin/trunk", None),
                ("origin/main", None),
                ("origin/master", Some("abc")),
            ]),
            Some(("def", "dev")),
        )
        .unwrap();
        assert_eq!(
            (b.reference.as_str(), b.branch.as_str(), b.remote.as_deref()),
            ("origin/master", "master", Some("origin"))
        );
    }

    #[test]
    fn head_with_no_remote_and_none_without_commits() {
        let b = choose(&[], Some(("def", "dev"))).unwrap();
        assert_eq!(
            (b.reference.as_str(), b.branch.as_str(), b.remote),
            ("def", "dev", None)
        );
        let detached = choose(&[], Some(("def", ""))).unwrap();
        assert_eq!(detached.branch, "");
        assert_eq!(
            choose(&found(&[("origin/main", None)]), None),
            None,
            "a repo with no commits gets no worktree"
        );
        assert_eq!(choose(&[], Some(("", ""))), None);
    }

    #[test]
    fn a_fetch_is_good_for_a_minute() {
        assert!(fetch_fresh(Some(1_000), 1_000 + 59_999));
        assert!(!fetch_fresh(Some(1_000), 1_000 + 60_000));
        assert!(!fetch_fresh(None, 5));
        assert!(
            !fetch_fresh(Some(10), 5),
            "a clock that went back fetches again"
        );
    }

    #[test]
    fn prop_choose_takes_the_first_found_candidate() {
        let mut r = Rng::new(3);
        for _ in 0..1000 {
            let n = r.below(4);
            let list: Vec<(String, Option<String>)> = (0..n)
                .map(|i| (format!("origin/b{i}"), r.bool().then(|| format!("s{i}"))))
                .collect();
            let head = r.bool().then_some(("h", "main"));
            let got = choose(&list, head);
            match list.iter().position(|(_, s)| s.is_some()) {
                Some(i) => assert_eq!(got.unwrap().reference, list[i].0),
                None => assert_eq!(got.map(|b| b.remote), head.map(|_| None)),
            }
        }
    }
}
