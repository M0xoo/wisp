//! The deciders of Ship it and Merge: what to do next given what git and GitHub said, and the words of
//! each refusal. The host runs the git and gh calls between them.

use wisp_ship_api::{AttachedPr, PrRef, PrSummary, RepoStatus, ShipRepo, ShipTask, Shipping, ToShip, Worktree};

/// A request Ship it can't do, with v1's words. Invalid is a 400, Conflict a 409.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Invalid(String),
    Conflict(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Self::Invalid(m) | Self::Conflict(m) => m,
        }
    }
    /// `name: message`, for a task across several repos.
    #[must_use]
    pub fn in_repo(self, name: &str, of: usize) -> Self {
        if of <= 1 {
            return self;
        }
        match self {
            Self::Invalid(m) => Self::Invalid(format!("{name}: {m}")),
            Self::Conflict(m) => Self::Conflict(format!("{name}: {m}")),
        }
    }
}

pub const NO_TREE: &str = "Ship it works on worktree sessions: launch with a worktree to get one.";
pub const MAX_ATTACHED: usize = 20;

/// The commit Ship it makes of uncommitted work: title and body, or a refusal without a title.
pub fn commit_message(title: &str, body: &str) -> Result<(String, String), Refusal> {
    let t = title.trim();
    if t.is_empty() {
        return Err(Refusal::Invalid("A commit message is required.".into()));
    }
    Ok((t.to_owned(), body.trim().to_owned()))
}

/// After the commit: is there anything to push, and where to? The remote to push to.
pub fn push_target(ahead: u32, wt: &Worktree) -> Result<String, Refusal> {
    if ahead == 0 {
        return Err(Refusal::Invalid("Nothing to ship: this branch has no changes.".into()));
    }
    wt.remote.clone().filter(|r| !r.is_empty()).ok_or_else(|| Refusal::Invalid("This repo has no origin remote to push to.".into()))
}

/// The branch's push refspec: wisp's branches never track, so HEAD goes to the branch by name.
pub fn push_refspec(wt: &Worktree) -> String {
    format!("HEAD:refs/heads/{}", wt.branch)
}

/// An open PR is updated by the push alone: its number to view. Otherwise a new PR is created.
pub fn reuse_pr(pr: Option<&PrSummary>) -> Option<u64> {
    pr.filter(|p| p.is_open()).map(|p| p.number)
}

/// `gh pr create` for the branch against its base (an empty body is one space: gh asks otherwise).
pub fn pr_create_args(wt: &Worktree, title: &str, body: &str, draft: bool) -> Vec<String> {
    let body = if body.trim().is_empty() { " " } else { body.trim() };
    let mut args: Vec<String> = ["pr", "create", "--base", &wt.base, "--head", &wt.branch, "--title", title.trim(), "--body", body].iter().map(|s| (*s).to_owned()).collect();
    if draft {
        args.push("--draft".into());
    }
    args
}

/// `gh pr create` prints the URL last.
pub fn created_url(stdout: &str) -> String {
    stdout.trim().lines().last().unwrap_or_default().trim().to_owned()
}

/// What merging needs: ready a draft first, then a squash of exactly the head that was reviewed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergePlan {
    pub ready: Option<Vec<String>>,
    pub merge: Vec<String>,
}

/// Edge case Git 8. `pr_ref`: the number in the task's repo, or the URL of an attached PR.
pub fn merge_plan(pr: &PrSummary, pr_ref: &str) -> Result<MergePlan, Refusal> {
    if !pr.is_open() {
        return Err(Refusal::Invalid(format!("PR #{} is {}.", pr.number, pr.state.to_lowercase())));
    }
    let ready = pr.draft.then(|| vec!["pr".into(), "ready".into(), pr_ref.to_owned()]);
    let merge = vec!["pr".into(), "merge".into(), pr_ref.to_owned(), "--squash".into(), "--match-head-commit".into(), pr.head.clone()];
    Ok(MergePlan { ready, merge })
}

/// After a merge: wisp's own worktree and branch are tidied (locally and on the remote); a foreign
/// one's never are (edge case Git 7).
pub fn cleans_up(wt: &Worktree) -> bool {
    !wt.foreign
}

/// The head of the branch's merged PR, from which commits are new again (edge case Git 6).
pub fn merged_head(pr: Option<&PrSummary>) -> Option<&str> {
    pr.filter(|p| p.is_merged() && !p.head.is_empty()).map(|p| p.head.as_str())
}

/// Where "unpushed" counts from, in order: the merged PR's head, else the remote branch. The first
/// whose count git can do wins; none: unpushed is `ahead` (edge case Git 6).
pub fn unpushed_from(wt: &Worktree, merged: Option<&str>) -> Vec<String> {
    let mut refs = Vec::new();
    if let Some(m) = merged {
        refs.push(m.to_owned());
    }
    if let Some(r) = wt.remote.as_deref().filter(|r| !r.is_empty()) {
        refs.push(format!("refs/remotes/{r}/{}", wt.branch));
    }
    refs
}

/// The worktree status from its parts (`counts`: each `unpushed_from` ref's count, None when git couldn't).
pub fn repo_status(exists: bool, dirty: u32, ahead: Option<u32>, counts: &[Option<u32>]) -> RepoStatus {
    if !exists {
        return RepoStatus::default();
    }
    let ahead = ahead.unwrap_or(0);
    let unpushed = counts.iter().find_map(|c| *c).unwrap_or(ahead);
    RepoStatus { exists: true, dirty, ahead, unpushed }
}

/// Something new for this repo's PR: uncommitted changes, or commits its open (or merged) PR lacks,
/// or, with no PR, any commit past the base.
pub fn pending(st: &RepoStatus, pr: Option<&PrSummary>) -> bool {
    st.dirty > 0 || if pr.is_some_and(|p| p.is_open() || p.is_merged()) { st.unpushed > 0 } else { st.ahead > 0 }
}

/// A task's repos added up; `repos` counts those with something to ship when there are several.
pub fn to_ship(statuses: &[RepoStatus], repos: &[ShipRepo]) -> ToShip {
    let sum = |f: fn(&RepoStatus) -> u32| statuses.iter().map(f).sum();
    let several = repos.len() > 1;
    let with = statuses.iter().zip(repos).filter(|(st, r)| pending(st, r.pr.as_ref())).count();
    ToShip { dirty: sum(|s| s.dirty), ahead: sum(|s| s.ahead), unpushed: sum(|s| s.unpushed), repos: several.then(|| u32::try_from(with).unwrap_or(u32::MAX)) }
}

/// Which repos a Ship it ships: one repo always (git says why if nothing), several only those with news.
pub fn ship_todo(statuses: &[RepoStatus], repos: &[ShipRepo]) -> Result<Vec<usize>, Refusal> {
    if repos.len() <= 1 {
        return Ok((0..repos.len()).collect());
    }
    let todo: Vec<usize> = (0..repos.len()).filter(|&i| statuses.get(i).is_some_and(|st| pending(st, repos[i].pr.as_ref()))).collect();
    if todo.is_empty() {
        return Err(Refusal::Invalid("Nothing to ship: none of the task’s repos have new changes.".into()));
    }
    Ok(todo)
}

/// Where a ship starts: an update when every PR it ships to is open.
pub fn shipping_start(task: &ShipTask, todo: &[usize], now: i64) -> Shipping {
    let update = todo.iter().all(|&i| task.repos[i].pr.as_ref().is_some_and(PrSummary::is_open));
    let of = (todo.len() > 1).then(|| u32::try_from(todo.len()).unwrap_or(u32::MAX));
    Shipping { step: "start".into(), update, started_at: now, of, repo: None, at: None }
}

/// Each PR of the task, its own (repos') first, then those attached.
pub fn prs_of(task: &ShipTask) -> Vec<PrRef> {
    let own = task.repos.iter().filter_map(|r| r.pr.as_ref().map(|p| (r.name.as_str(), p)));
    let attached = task.prs.iter().map(|x| (x.repo.as_str(), &x.pr));
    own.chain(attached).map(|(repo, p)| PrRef { repo: repo.to_owned(), number: p.number, url: p.url.clone(), state: p.state.clone() }).collect()
}

/// A PR reference as wisp_pr takes it: a URL, or a number (with or without `#`).
pub fn normalize_ref(r: &str) -> Result<String, Refusal> {
    let r = r.trim();
    let r = r.strip_prefix('#').unwrap_or(r);
    if r.is_empty() {
        return Err(Refusal::Invalid("Give the pull request’s URL (https://github.com/owner/repo/pull/123), or its number in this task’s repo.".into()));
    }
    Ok(r.to_owned())
}

fn same(pr: &PrSummary, r: &str) -> bool {
    pr.url == r || pr.number.to_string() == r
}

/// Detaches an attached PR. The task's own branch's PR stays.
pub fn detach(task: &mut ShipTask, r: &str) -> Result<PrSummary, Refusal> {
    let Some(at) = task.prs.iter().position(|x| same(&x.pr, r)) else {
        let own = task.repos.iter().any(|x| x.pr.as_ref().is_some_and(|p| same(p, r)));
        return Err(Refusal::Invalid(if own { "That is the PR of the task’s own branch: it stays." } else { "No PR like that is attached to this task." }.into()));
    };
    Ok(task.prs.remove(at).pr)
}

/// Attaches a PR gh read: on the task's own branch it becomes the PR Ship it pushes to (true);
/// otherwise it joins the list, once, at most 20.
pub fn attach(task: &mut ShipTask, pr: PrSummary, repo: String) -> Result<bool, Refusal> {
    if let Some(own) = task.repos.iter_mut().find(|r| !pr.branch.is_empty() && r.worktree.branch == pr.branch) {
        task.prs.retain(|x| x.pr.url != pr.url);
        own.pr = Some(pr);
        return Ok(true);
    }
    match task.prs.iter().position(|x| x.pr.url == pr.url) {
        Some(at) => task.prs[at] = AttachedPr { repo, pr },
        None if task.prs.len() >= MAX_ATTACHED => return Err(Refusal::Invalid(format!("A task holds at most {MAX_ATTACHED} PRs: detach one first."))),
        None => task.prs.push(AttachedPr { repo, pr }),
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
