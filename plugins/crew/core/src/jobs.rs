//! A member's jobs in the order that matters (v1 web/js/crew-jobs.js): asking you, working, an unread
//! report, then what it finished, newest first. The server sorts a member's job list with it; the
//! rail's card keeps its rows still with [`hold_rows`]. The UI's own copy lives in the crew UI package.

use std::cmp::Ordering;

/// The fields of a job row these rules read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobLike {
    pub id: String,
    pub state: String,
    pub unread: bool,
    pub archived: bool,
    /// sent, not started yet (a Starting up card)
    pub pending: bool,
    pub updated_at: Option<i64>,
}

/// Asking you (0), working (1), an unread report (2), then what it finished (3).
pub fn job_rank(s: &JobLike) -> u8 {
    if s.pending || s.state == "running" {
        1
    } else if s.state == "waiting" {
        0
    } else if s.state == "review" && s.unread {
        2
    } else {
        3
    }
}

pub fn by_urgency(a: &JobLike, b: &JobLike) -> Ordering {
    job_rank(a).cmp(&job_rank(b)).then_with(|| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)))
}

/// Still on the member's plate: one you marked done or archived is only in its thread, unless it runs
/// or asks again.
pub fn standing(s: &JobLike) -> bool {
    (!s.archived && s.state != "done") || s.state == "running" || s.state == "waiting"
}

/// How many rows the card shows.
pub const CARD_ROWS: usize = 6;

/// Every job the face counts, of any kind, sent ones included, most urgent first.
pub fn card_jobs(jobs: &[JobLike], sent: &[JobLike]) -> Vec<JobLike> {
    let mut out: Vec<JobLike> = jobs.iter().chain(sent).filter(|s| s.pending || standing(s)).cloned().collect();
    out.sort_by(by_urgency);
    out
}

/// The marker a row wears, from the same rank.
pub fn job_mark(s: &JobLike) -> &'static str {
    ["asks", "live", "unread", ""][usize::from(job_rank(s))]
}

/// The rows while the card is up: each keeps its place whatever its job does. A job that left gives its
/// place to a newcomer (a placeholder to its real job) or keeps it; other newcomers go last, while there's room.
pub fn hold_rows(shown: &[String], fresh: &[String], gone: &dyn Fn(&str) -> bool, max: usize) -> Vec<String> {
    let mut news: std::collections::VecDeque<&String> = fresh.iter().filter(|id| !shown.contains(id)).collect();
    let mut out: Vec<String> = shown.iter().map(|id| if gone(id) { news.pop_front().unwrap_or(id).clone() } else { id.clone() }).collect();
    while out.len() < max {
        let Some(n) = news.pop_front() else { break };
        out.push(n.clone());
    }
    out
}
