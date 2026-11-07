//! A member's queue (v1 crew.js `assign`, `drain`, `checkin`, `#failed`): a job waits at the member's
//! `parallel` limit, or while it's paused (except your own tasks and @mentions); a full queue refuses.
//! A job the budget held is skipped: one log line, counting skips in a row, and not a check-in.

use wisp_crew_api::{Held, JobKind, LOG_MAX, LogEntry, Member, QUEUE_MAX, TaskRef, LINKS_MAX, Link};

use crate::error::{Error, Result};
use crate::text::truncate;

/// Where a new job goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// a slot is free: start it now
    Start,
    /// it waits in the queue (its place, 1-based, once pushed)
    Queue,
}

/// Whether a job of `kind` starts now or waits, given `busy` jobs live (v1 crew.js:615-619).
/// The 21st waiting job is refused (`TooMany`, v1's 429).
pub fn place(m: &Member, busy: u32, kind: JobKind) -> Result<Placement> {
    if busy < m.parallel && !(m.paused && !kind.runs_paused()) {
        return Ok(Placement::Start);
    }
    if m.queue.len() >= QUEUE_MAX {
        return Err(Error::TooMany(format!("{} already has {QUEUE_MAX} jobs waiting.", m.name)));
    }
    Ok(Placement::Queue)
}

/// How many waiting jobs may start now, from the head (v1 `drain`): while there's room, and not past
/// a head that waits for the member to be resumed.
pub fn drain_count(m: &Member, busy: u32) -> usize {
    let mut busy = busy;
    let mut n = 0;
    for w in &m.queue {
        if busy >= m.parallel || (m.paused && !w.job.runs_paused()) {
            break;
        }
        busy += 1;
        n += 1;
    }
    n
}

/// One check-in at a time: one running, asking or waiting in the queue means `{already: true}`.
pub fn checkin_already(m: &Member, live_checkin: bool) -> bool {
    live_checkin || m.queue.iter().any(|w| w.job == JobKind::Checkin)
}

/// A line on top of the log; past 40 the oldest goes.
pub fn push_log(m: &mut Member, e: LogEntry) {
    m.log.insert(0, e);
    m.log.truncate(LOG_MAX);
}

/// A job held for the plan (Automations stop at) or a busy computer: skipped, not failed. Skips in a
/// row share the top line of the log, so a member on a 15-minute schedule doesn't fill it (v1 crew.js:829-835).
pub fn record_skip(m: &mut Member, job: JobKind, held: &Held, now: i64) {
    m.held = Some(Held { at: Some(now), ..held.clone() });
    let summary = truncate(&held.why, 160);
    if let Some(top) = m.log.first_mut()
        && let Some(n) = top.skipped
    {
        top.at = now;
        top.skipped = Some(n + 1);
        top.summary = summary;
        return;
    }
    let title = if held.load { "Skipped: the computer is busy" } else { "Skipped: waits for the plan" };
    push_log(m, LogEntry { at: now, job, title: title.into(), summary, status: "partial".into(), skipped: Some(1), ..LogEntry::default() });
}

/// A job that couldn't start for another reason.
pub fn record_failed(m: &mut Member, job: JobKind, why: &str, now: i64) {
    push_log(m, LogEntry { at: now, job, title: "Couldn’t start".into(), summary: truncate(why, 160), status: "blocked".into(), ..LogEntry::default() });
}

/// A check-in that starts counts; one that didn't start is put back (v1 crew.js:656, :670).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Count {
    pub checkins: u32,
    pub last_checkin_at: Option<i64>,
}

pub fn count_checkin(m: &mut Member, now: i64) -> Count {
    let was = Count { checkins: m.checkins, last_checkin_at: m.last_checkin_at };
    m.checkins += 1;
    m.last_checkin_at = Some(now);
    was
}

pub fn uncount(m: &mut Member, was: Count) {
    m.checkins = was.checkins;
    m.last_checkin_at = was.last_checkin_at;
}

/// A task that tagged or delegated to the member: it may follow up there later (newest first, 20 kept).
pub fn link(m: &mut Member, from: &TaskRef, now: i64) {
    m.links.retain(|l| l.id != from.id);
    m.links.insert(0, Link { id: from.id.clone(), title: from.title.clone(), at: now });
    m.links.truncate(LINKS_MAX);
}

/// Members skipped for `agent`'s plan stop saying so (v1 `release`): how many were.
pub fn release(members: &mut [Member], agent: &str) -> u32 {
    let mut n = 0;
    for m in members {
        let held_on = m.held.as_ref().map(|h| h.agent.clone().unwrap_or_else(|| m.agent.clone()));
        if held_on.as_deref() == Some(agent) {
            m.held = None;
            n += 1;
        }
    }
    n
}
