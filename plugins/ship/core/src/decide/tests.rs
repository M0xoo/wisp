//! v1 test/ship.test.js at the decider level: refusals, the unpushed count after a squash merge,
//! tasks across repos, wisp_pr attach/detach, merge plans.

use wisp_ship_api::{PrSummary, RepoStatus, ShipRepo, ShipTask, Worktree};

use super::*;

fn wt(branch: &str) -> Worktree {
    Worktree { path: format!("/w/{branch}"), root: "/r".into(), branch: branch.into(), base: "main".into(), base_ref: "origin/main".into(), remote: Some("origin".into()), ..Worktree::default() }
}

fn pr(n: u64, state: &str) -> PrSummary {
    PrSummary { number: n, url: format!("https://github.com/acme/repo/pull/{n}"), state: state.into(), head: format!("h{n}"), ..PrSummary::default() }
}

fn st(dirty: u32, ahead: u32, unpushed: u32) -> RepoStatus {
    RepoStatus { exists: true, dirty, ahead, unpushed }
}

#[test]
fn ship_refuses_what_it_cannot_ship() {
    assert_eq!(commit_message("  ", "b"), Err(Refusal::Invalid("A commit message is required.".into())));
    assert_eq!(commit_message(" fix: x ", " body "), Ok(("fix: x".into(), "body".into())));
    assert!(push_target(0, &wt("b")).is_err_and(|e| e.message().contains("no changes")));
    let no_remote = Worktree { remote: None, ..wt("b") };
    assert_eq!(push_target(1, &no_remote), Err(Refusal::Invalid("This repo has no origin remote to push to.".into())));
    assert_eq!(push_target(1, &wt("b")), Ok("origin".into()));
    assert!(NO_TREE.contains("worktree sessions"));
    assert_eq!(push_refspec(&wt("wisp/x")), "HEAD:refs/heads/wisp/x");
}

#[test]
fn an_open_pr_is_updated_by_the_push_a_closed_one_gets_a_new_pr() {
    assert_eq!(reuse_pr(Some(&pr(3, "OPEN"))), Some(3));
    assert_eq!(reuse_pr(Some(&pr(3, "MERGED"))), None);
    assert_eq!(reuse_pr(None), None);
    let args = pr_create_args(&wt("wisp/x"), " fix ", "", true);
    assert_eq!(args, ["pr", "create", "--base", "main", "--head", "wisp/x", "--title", "fix", "--body", " ", "--draft"]);
    assert_eq!(created_url("Creating pull request for wisp/x into main\n\nhttps://github.com/acme/repo/pull/1\n"), "https://github.com/acme/repo/pull/1");
}

/// Edge case Git 8: squash with --match-head-commit, ready a draft first.
#[test]
fn merge_squashes_the_reviewed_head_and_readies_a_draft_first() {
    let p = merge_plan(&pr(1, "OPEN"), "1").unwrap_or_else(|_| MergePlan { ready: None, merge: Vec::new() });
    assert_eq!(p.ready, None);
    assert_eq!(p.merge, ["pr", "merge", "1", "--squash", "--match-head-commit", "h1"]);
    let draft = PrSummary { draft: true, ..pr(2, "OPEN") };
    assert_eq!(merge_plan(&draft, "2").ok().and_then(|p| p.ready), Some(vec!["pr".into(), "ready".into(), "2".into()]));
    assert_eq!(merge_plan(&pr(4, "MERGED"), "4"), Err(Refusal::Invalid("PR #4 is merged.".into())));
    assert_eq!(merge_plan(&pr(4, "CLOSED"), "4"), Err(Refusal::Invalid("PR #4 is closed.".into())));
    assert!(cleans_up(&wt("x")));
    assert!(!cleans_up(&Worktree { foreign: true, ..wt("x") }), "a foreign worktree is never ours to tidy");
}

/// Edge case Git 6 (v1 "after its PR merged elsewhere, new changes on the task show Ship it again").
#[test]
fn unpushed_counts_from_the_merged_head_else_the_remote_branch_else_ahead() {
    let w = wt("wisp/x");
    let merged = pr(1, "MERGED");
    assert_eq!(merged_head(Some(&merged)), Some("h1"));
    assert_eq!(merged_head(Some(&pr(1, "OPEN"))), None);
    assert_eq!(unpushed_from(&w, Some("h1")), ["h1", "refs/remotes/origin/wisp/x"]);
    assert_eq!(unpushed_from(&Worktree { remote: None, ..w.clone() }, None), Vec::<String>::new());
    // squash-merged, remote branch deleted: the squashed commit itself is not new
    assert_eq!(repo_status(true, 0, Some(1), &[Some(0), None]), st(0, 1, 0));
    // a follow-up commit after the merge: only it is new
    assert_eq!(repo_status(true, 0, Some(2), &[Some(1), None]), st(0, 2, 1));
    // the merged head isn't in this clone: the remote branch counts
    assert_eq!(repo_status(true, 0, Some(2), &[None, Some(2)]), st(0, 2, 2));
    // neither: unpushed is ahead
    assert_eq!(repo_status(true, 1, Some(3), &[None, None]), st(1, 3, 3));
    assert_eq!(repo_status(false, 9, Some(9), &[Some(9)]), RepoStatus::default());
    // and it shows Ship it again
    assert!(pending(&st(0, 2, 1), Some(&merged)));
    assert!(!pending(&st(0, 1, 0), Some(&merged)));
}

fn repo(name: &str, p: Option<PrSummary>) -> ShipRepo {
    ShipRepo { name: name.into(), worktree: wt(&format!("wisp/{name}")), pr: p }
}

/// v1 "one task across two repos: a worktree each, a PR each, merged together".
#[test]
fn a_task_across_repos_ships_only_those_with_news() {
    let repos = [repo("api", None), repo("web", None)];
    let sts = [st(1, 0, 0), st(1, 0, 0)];
    assert_eq!(to_ship(&sts, &repos), ToShip { dirty: 2, ahead: 0, unpushed: 0, repos: Some(2) });
    assert_eq!(ship_todo(&sts, &repos), Ok(vec![0, 1]));
    let shipped = [repo("api", Some(pr(1, "OPEN"))), repo("web", Some(pr(2, "OPEN")))];
    let clean = [st(0, 1, 0), st(0, 1, 0)];
    assert_eq!(to_ship(&clean, &shipped).repos, Some(0));
    assert_eq!(ship_todo(&clean, &shipped), Err(Refusal::Invalid("Nothing to ship: none of the task’s repos have new changes.".into())));
    // one repo always ships (git says why when there's nothing) and has no `repos` count
    assert_eq!(ship_todo(&[st(0, 0, 0)], &repos[..1]), Ok(vec![0]));
    assert_eq!(to_ship(&[st(1, 0, 0)], &repos[..1]).repos, None);
    assert_eq!(Refusal::Invalid("x".into()).in_repo("web", 2), Refusal::Invalid("web: x".into()));
    assert_eq!(Refusal::Invalid("x".into()).in_repo("web", 1), Refusal::Invalid("x".into()));
    let task = ShipTask { repos: shipped.to_vec(), ..ShipTask::default() };
    let s = shipping_start(&task, &[0, 1], 7);
    assert!(s.update);
    assert_eq!((s.of, s.step.as_str(), s.started_at), (Some(2), "start", 7));
    assert!(!shipping_start(&ShipTask { repos: repos.to_vec(), ..ShipTask::default() }, &[0], 0).update);
}

/// v1 "wisp_pr: an agent attaches several PRs to its task; they are followed and merged like shipped ones".
#[test]
fn attach_and_detach() {
    let mut task = ShipTask { repos: vec![repo("repo", None)], ..ShipTask::default() };
    let ext = |n: u64, name: &str| PrSummary { number: n, url: format!("https://github.com/acme/{name}/pull/{n}"), state: "OPEN".into(), branch: format!("feat/{name}"), ..PrSummary::default() };
    assert_eq!(attach(&mut task, ext(901, "docs"), "docs".into()), Ok(false));
    assert_eq!(attach(&mut task, ext(902, "api"), "api".into()), Ok(false));
    assert_eq!(attach(&mut task, ext(901, "docs"), "docs".into()), Ok(false), "again: no duplicate");
    let listed: Vec<(String, u64)> = task.prs.iter().map(|x| (x.repo.clone(), x.pr.number)).collect();
    assert_eq!(listed, [("docs".into(), 901), ("api".into(), 902)]);
    assert!(task.pr().is_none(), "not the task's own PR");
    // the PR of the task's own branch becomes the one Ship it pushes to
    let own = PrSummary { branch: "wisp/repo".into(), ..ext(903, "repo") };
    assert_eq!(attach(&mut task, own, "repo".into()), Ok(true));
    assert_eq!(task.pr().map(|p| p.number), Some(903));
    assert_eq!(task.prs.len(), 2);
    assert!(detach(&mut task, "903").is_err_and(|e| e.message().contains("own branch")));
    assert!(detach(&mut task, "https://github.com/acme/nope/pull/1").is_err_and(|e| e.message() == "No PR like that is attached to this task."));
    assert_eq!(detach(&mut task, "https://github.com/acme/api/pull/902").map(|p| p.number), Ok(902));
    let refs: Vec<(u64, String)> = prs_of(&task).into_iter().map(|r| (r.number, r.repo)).collect();
    assert_eq!(refs, [(903, "repo".into()), (901, "docs".into())], "own first, then attached");
    assert_eq!(normalize_ref(" #12 "), Ok("12".into()));
    assert!(normalize_ref("  ").is_err());
}

#[test]
fn at_most_twenty_attached() {
    let mut task = ShipTask::default();
    for n in 0..20 {
        assert_eq!(attach(&mut task, pr(n, "OPEN"), "r".into()), Ok(false));
    }
    assert!(attach(&mut task, pr(99, "OPEN"), "r".into()).is_err_and(|e| e.message().contains("at most 20")));
    assert_eq!(attach(&mut task, pr(3, "MERGED"), "r".into()), Ok(false), "updating one already there is fine");
}

/// Property: the sum is the sum, `repos` never exceeds the repo count, and a repo is pending exactly
/// when it is dirty or has commits its PR (or, with none, the base) lacks.
#[test]
fn to_ship_adds_up() {
    let mut seed: u64 = 11;
    let mut next = |m: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        u32::try_from(seed % m).unwrap_or(0)
    };
    let states = ["OPEN", "MERGED", "CLOSED"];
    for _ in 0..500 {
        let n = 1 + next(4) as usize;
        let sts: Vec<RepoStatus> = (0..n).map(|_| st(next(3), next(3), next(3))).collect();
        let repos: Vec<ShipRepo> = (0..n).map(|i| repo(&format!("r{i}"), (next(2) == 1).then(|| pr(1, states[next(3) as usize])))).collect();
        let t = to_ship(&sts, &repos);
        assert_eq!(t.dirty, sts.iter().map(|s| s.dirty).sum::<u32>());
        assert_eq!(t.ahead, sts.iter().map(|s| s.ahead).sum::<u32>());
        assert!(t.repos.unwrap_or(0) as usize <= n);
        for (s, r) in sts.iter().zip(&repos) {
            let follows = r.pr.as_ref().is_some_and(|p| p.state != "CLOSED");
            assert_eq!(pending(s, r.pr.as_ref()), s.dirty > 0 || if follows { s.unpushed > 0 } else { s.ahead > 0 });
        }
        if n > 1 {
            assert_eq!(ship_todo(&sts, &repos).map(|v| v.len()).unwrap_or(0), t.repos.unwrap_or(0) as usize);
        }
    }
}
