//! When a review starts, and what it leaves on the task: idle → running → done | failed, or held
//! (the reviewer's account is past Automations' stop), always of one PR head (v1 createReview).

use wisp_review_api::{
    Coverage, Finding, Pick, Review, ReviewView, Status, TestsRun, TestsSummary,
};

use crate::pick::clip;
use crate::prompt::partial_summary;

pub const NO_PR: &str = "No open pull request of the task’s own branch.";
pub const OFF: &str = "Review by another harness is off.";
pub const BUSY: &str = "Still working: it’s reviewed once the run ends.";
pub const UNPUSHED: &str =
    "The branch has commits the PR doesn’t have yet: push them (Ship it) to review.";
pub const NO_DIFF: &str = "Couldn’t read the PR’s diff";

/// What `maybe` looks at.
#[derive(Debug, Clone, Default)]
#[allow(clippy::struct_excessive_bools)] // facts about the task, each its own yes/no
pub struct Due<'a> {
    pub has_worktree: bool,
    /// a subtask (parentId): its lead's PR is the one reviewed
    pub is_child: bool,
    pub pr_open: bool,
    pub pr_head: &'a str,
    pub setting: &'a str,
    pub force: bool,
    /// the head a review is running for right now
    pub running: Option<&'a str>,
    /// a turn is running, or Ship it is
    pub busy: bool,
    pub last: Option<&'a Review>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// not started, and why (the route answers 409 with it)
    Refuse(String),
    /// nothing to do and nothing to say: running for this head already, or reviewed already
    Quiet,
    /// pick a reviewer for this setting ('off' when forced reads as 'other')
    Pick { setting: String },
}

pub fn gate(d: &Due<'_>) -> Gate {
    if !d.has_worktree || d.is_child || !d.pr_open || d.pr_head.is_empty() {
        return Gate::Refuse(NO_PR.into());
    }
    let off = d.setting.is_empty() || d.setting == "off";
    if !d.force && off {
        return Gate::Refuse(OFF.into());
    }
    if d.running == Some(d.pr_head) {
        return Gate::Quiet;
    }
    if d.busy {
        return Gate::Refuse(BUSY.into());
    }
    if !d.force
        && d.last
            .is_some_and(|r| r.head == d.pr_head && r.status != Status::Running)
    {
        return Gate::Quiet;
    }
    Gate::Pick {
        setting: if off {
            "other".into()
        } else {
            d.setting.to_owned()
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// the review to keep (failed or held), and why it didn't start
    Stop {
        review: Review,
        why: String,
    },
    Start {
        review: Review,
        pick: Pick,
    },
}

/// After the pick, and (unless forced) the hold check on the reviewer's own account.
pub fn after_pick(
    head: &str,
    pick: Result<Pick, String>,
    hold: Option<String>,
    now: i64,
) -> Decision {
    let base = Review {
        head: head.to_owned(),
        at: now,
        ..Review::default()
    };
    match (pick, hold) {
        (Err(why), _) => Decision::Stop {
            review: Review {
                status: Status::Failed,
                why: Some(why.clone()),
                ..base
            },
            why,
        },
        (Ok(pick), Some(why)) => Decision::Stop {
            review: Review {
                status: Status::Held,
                by: Some(pick),
                why: Some(why.clone()),
                ..base
            },
            why,
        },
        (Ok(pick), None) => Decision::Start {
            review: Review {
                status: Status::Running,
                by: Some(pick.clone()),
                ..base
            },
            pick,
        },
    }
}

/// The tests as the task keeps them: none when they were skipped.
pub fn tests_summary(t: Option<&TestsRun>) -> Option<TestsSummary> {
    t.filter(|t| t.verdict != "skip").map(|t| TestsSummary {
        verdict: t.verdict.clone(),
        command: t.command.clone(),
        passed: t.passed,
        failed: t.failed,
    })
}

/// How a run ended.
#[derive(Debug, Clone)]
pub enum Outcome {
    /// the reviewer answered: its summary and findings
    Answered {
        summary: String,
        findings: Vec<Finding>,
    },
    /// it didn't (a timeout, junk): named for the page
    Silent { reviewer: String },
    /// it couldn't run (the head moved, no diff)
    Error { why: String },
}

#[derive(Debug)]
pub struct Finish<'a> {
    pub head: &'a str,
    pub pick: &'a Pick,
    pub tests: Option<&'a TestsRun>,
    pub constraints: Vec<String>,
    pub coverage: Option<Coverage>,
    pub now: i64,
}

pub fn finish(f: Finish<'_>, outcome: Outcome) -> Review {
    let base = Review {
        head: f.head.to_owned(),
        by: Some(f.pick.clone()),
        at: f.now,
        ..Review::default()
    };
    match outcome {
        Outcome::Answered { summary, findings } => {
            let partial = f.coverage.as_ref().is_some_and(Coverage::partial);
            let summary = match &f.coverage {
                Some(c) if partial && findings.is_empty() => partial_summary(c),
                _ => summary,
            };
            Review {
                status: Status::Done,
                summary: Some(summary),
                findings,
                tests: tests_summary(f.tests),
                constraints: f.constraints,
                coverage: f.coverage,
                ..base
            }
        }
        Outcome::Silent { reviewer } => Review {
            status: Status::Failed,
            why: Some(format!("{reviewer} didn’t answer.")),
            tests: tests_summary(f.tests),
            coverage: f.coverage,
            ..base
        },
        Outcome::Error { why } => Review {
            status: Status::Failed,
            why: Some(clip(&why, 300)),
            coverage: f.coverage,
            ..base
        },
    }
}

/// A review cut short by a restart starts over: a running one is dropped at boot.
pub fn on_boot(r: Option<Review>) -> Option<Review> {
    r.filter(|r| r.status != Status::Running)
}

/// What the page sees, and whether it is of the PR's head.
pub fn review_view(r: Option<&Review>, pr_head: Option<&str>) -> Option<ReviewView> {
    let r = r?;
    Some(ReviewView {
        status: r.status,
        head: r.head.clone(),
        current: pr_head.is_some_and(|h| h == r.head),
        by: r.by.clone(),
        summary: r.summary.clone().filter(|s| !s.is_empty()),
        findings: r.findings.clone(),
        tests: r.tests.clone(),
        constraints: r.constraints.clone(),
        coverage: r.coverage.clone(),
        why: r.why.clone().filter(|s| !s.is_empty()),
        at: r.at,
    })
}
