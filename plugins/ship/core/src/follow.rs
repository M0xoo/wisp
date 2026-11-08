//! Following open PRs: when to ask GitHub again, what counts as news (the card comes back unread), and
//! the conflict fix: when to send the task a follow-up to merge its base in, and whether to push it.

use wisp_ship_api::{ConflictFix, PrSummary, ShipTask};

/// Open PRs are asked about every minute...
pub const PR_POLL_MS: i64 = 60_000;
/// ...and every 10 s while GitHub is still working something out.
pub const PR_FAST_POLL_MS: i64 = 10_000;
pub const PR_TICK_MS: u64 = 5_000;
/// A PR is followed closely for this long after a push, so its checks show as they start.
pub const PUSHED_FAST_MS: i64 = 5 * 60_000;
/// Per task, so a base that keeps moving can't run up the bill.
pub const MAX_CONFLICT_FIXES: u32 = 3;

/// The PR a task's poll is led by: its own when open, else the first open one of its other repos or attached.
pub fn lead(task: &ShipTask) -> Option<&PrSummary> {
    if let Some(p) = task.pr().filter(|p| p.is_open()) {
        return Some(p);
    }
    let also = task.repos.iter().skip(1).filter_map(|r| r.pr.as_ref());
    also.chain(task.prs.iter().map(|x| &x.pr))
        .find(|p| p.is_open())
}

/// Still settling: checks running, mergeability unknown, a fix being pushed, or a push just landed.
pub fn settling(task: &ShipTask, pr: &PrSummary, now: i64) -> bool {
    let fix = task
        .conflict_fix
        .as_ref()
        .is_some_and(|f| matches!(f.step.as_str(), "pushing" | "done"));
    pr.checks.pending > 0
        || pr.merge_state == "UNKNOWN"
        || fix
        || now - task.pushed_at < PUSHED_FAST_MS
}

/// Is the task's PR due for a look at `now`?
pub fn due(task: &ShipTask, now: i64) -> bool {
    lead(task).is_some_and(|p| {
        now - p.checked_at
            >= if settling(task, p, now) {
                PR_FAST_POLL_MS
            } else {
                PR_POLL_MS
            }
    })
}

fn settled(p: &PrSummary) -> &'static str {
    if p.checks.pending > 0 {
        "pending"
    } else if p.checks.fail > 0 {
        "fail"
    } else {
        "pass"
    }
}

/// The task's own PR: things worth coming back for are CI finishing either way, a review landing, a
/// merge or close.
pub fn is_news(prev: &PrSummary, pr: &PrSummary) -> bool {
    prev.state != pr.state
        || prev.review != pr.review
        || (settled(prev) != settled(pr) && settled(pr) != "pending")
}

/// Another repo's or an attached PR: state, review, or its checks just finished.
pub fn is_also_news(prev: &PrSummary, pr: &PrSummary) -> bool {
    prev.state != pr.state
        || prev.review != pr.review
        || (pr.checks.pending == 0 && prev.checks.pending > 0)
}

/// What the task is doing, as the conflict fix needs to know it (runtime and ship own these).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // independent reasons a task is busy
pub struct Busy {
    /// a turn is running
    pub live: bool,
    /// it waits for the user's answer
    pub ask: bool,
    pub shipping: bool,
    pub archived: bool,
    /// a poll and a refresh at once must not both send it
    pub starting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fix {
    /// leave it
    Skip,
    /// ask git first whether it really conflicts with its freshly fetched base (GitHub can lag a push)
    CheckBase,
    /// send the follow-up now: the user asked
    Start,
}

/// Auto-fix (`fixConflicts: on`) runs once per PR head and at most 3 times; Fix conflicts (force)
/// always starts, at once, trusting the conflict wisp last saw.
pub fn should_fix(task: &ShipTask, auto: bool, force: bool, busy: Busy) -> Fix {
    let Some(pr) = task.pr() else {
        return Fix::Skip;
    };
    let remote = task
        .repos
        .first()
        .is_some_and(|r| r.worktree.remote.as_deref().is_some_and(|x| !x.is_empty()));
    if (!force && !auto) || !pr.is_open() || !pr.conflict || !remote {
        return Fix::Skip;
    }
    if busy.live || busy.shipping || busy.ask || busy.archived || busy.starting {
        return Fix::Skip;
    }
    if force {
        return Fix::Start;
    }
    let fix = task.conflict_fix.as_ref();
    if fix.is_some_and(|f| f.head == pr.head || f.tries >= MAX_CONFLICT_FIXES) {
        return Fix::Skip;
    }
    Fix::CheckBase
}

/// git's merge-tree said the branch merges cleanly with its fetched base: GitHub's conflict is stale.
/// "Can't tell" (None, git < 2.38) trusts GitHub (edge case Git 9).
pub fn conflict_free(base: Option<bool>) -> bool {
    base == Some(false)
}

/// The fix's new record when it starts.
pub fn fix_started(task: &ShipTask, now: i64) -> ConflictFix {
    let tries = task.conflict_fix.as_ref().map_or(0, |f| f.tries);
    ConflictFix {
        step: "fixing".into(),
        head: task.pr().map(|p| p.head.clone()).unwrap_or_default(),
        tries: tries + 1,
        started_at: now,
        why: None,
    }
}

/// The fix-up turn ended: why it can't be pushed, or None to go on and check the merge.
pub fn fix_ended(interrupted: bool, queued: bool, error: Option<&str>) -> Option<String> {
    if interrupted || queued {
        return Some("Stopped: the task moved on before the conflicts were fixed.".into());
    }
    error.map(|e| {
        format!("The agent run failed: {e}")
            .chars()
            .take(300)
            .collect()
    })
}

/// After a refresh: a fix that's over is cleared once GitHub no longer sees a conflict.
pub fn clear_fix(task: &mut ShipTask) {
    let conflict = task.pr().is_some_and(|p| p.conflict);
    if task
        .conflict_fix
        .as_ref()
        .is_some_and(|f| !conflict && !matches!(f.step.as_str(), "fixing" | "pushing"))
    {
        task.conflict_fix = None;
    }
}

/// Why Fix conflicts couldn't start (the route's 409).
pub fn why_not_fixing(task: &ShipTask, busy: Busy) -> &'static str {
    let pr = task.pr();
    if !pr.is_some_and(|p| p.conflict) {
        "The PR has no merge conflicts now."
    } else if task
        .repos
        .first()
        .is_none_or(|r| r.worktree.remote.is_none())
    {
        "This repo has no origin remote to push to."
    } else if busy.ask {
        "The task is waiting for your answer first."
    } else if busy.shipping {
        "Already shipping: wait for it to land."
    } else {
        "Could not start the fix: try again in a moment."
    }
}

/// After a restart: a ship cut short isn't running any more, and a fix being pushed failed.
pub fn after_restart(task: &mut ShipTask) {
    task.shipping = None;
    if let Some(f) = task.conflict_fix.as_mut().filter(|f| f.step == "pushing") {
        f.step = "failed".into();
        f.why = Some("wisp restarted while pushing the fix.".into());
    }
}

#[cfg(test)]
mod tests;
