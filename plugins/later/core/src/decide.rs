//! The scheduler's decisions (v1 later.js tick, pullForward, nextAt), pure: given the entries, the
//! plans, what each task is doing and what holds back its account, what happens now. The host applies
//! the actions (sends, moves, lapses) and calls again on its next look.

use std::collections::BTreeMap;

use wisp_later_api::{LATE_MS, LaterEntry, LaterHeld, MIN_MS, MISSED_MS, Plan, PlanKind};

/// A task's state, as runtime reports it (v1 `waiting` is `asking` here).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TaskState {
    Running,
    #[default]
    Review,
    Done,
    Error,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Review => "review",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "running" => Self::Running,
            "review" => Self::Review,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => return None,
        })
    }
}

/// What wisp.later needs to know about a task (read from wisp.runtime by the host).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // independent facts about the task, read one at a time
pub struct Task {
    pub id: String,
    pub title: String,
    pub agent: String,
    /// the account it runs on, `default` when the harness has one
    pub account: String,
    pub state: TaskState,
    pub archived: bool,
    /// a run of it is live (or it is being deleted)
    pub busy: bool,
    /// it asks the user a question (an answer would take the follow-up's place)
    pub asking: bool,
    /// its last turn waits on delegates that still run
    pub delegates: bool,
    /// a subagent or a delegate: its lead schedules, not it
    pub sub: bool,
    /// the tour (`agent: 'wisp'`)
    pub tour: bool,
}

impl Task {
    /// A follow-up can go now: not while its agent runs, asks or waits on delegates (v1 #free).
    pub fn free(&self) -> bool {
        !self.busy && !self.asking && !self.delegates && self.state != TaskState::Running
    }
}

/// One thing the host does now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// archived: what it had scheduled and came due lapses
    Lapse { session_id: String, ids: Vec<String> },
    /// not the user's, and its account is past Automations stop at: moved to `at` with `held`
    Hold { session_id: String, id: String, at: i64, held: LaterHeld },
    /// a follow-up goes into its task; `late`: more than 2 minutes late
    Fire { session_id: String, id: String, late: bool },
    /// a reminder comes due
    Remind { session_id: String, id: String },
    /// a follow-up more than a day late: the task comes back to Needs you with it, unsent
    Missed { session_id: String, id: String },
    /// the task went: its entries go with it
    Forget { session_id: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Decision {
    pub actions: Vec<Action>,
    /// something due was held back (a busy task, the per-look cap): look again in `TICK_MS`
    pub retry: bool,
    /// how many sends, reminders and missed entries it used of `room`
    pub used: usize,
}

/// When an entry the plan holds back goes: the reset, never sooner than a minute from now.
pub fn held_at(h: &LaterHeld, now: i64) -> i64 {
    h.until.max(now + MIN_MS)
}

/// The due entries, grouped by task in the order their first one came due.
fn by_task(entries: &[LaterEntry], now: i64) -> Vec<(String, Vec<&LaterEntry>)> {
    let mut due: Vec<&LaterEntry> = entries.iter().filter(|l| l.at <= now).collect();
    due.sort_by(|a, b| (a.at, a.set_at, &a.id).cmp(&(b.at, b.set_at, &b.id)));
    let mut out: Vec<(String, Vec<&LaterEntry>)> = Vec::new();
    for l in due {
        match out.iter_mut().find(|(id, _)| *id == l.session_id) {
            Some((_, v)) => v.push(l),
            None => out.push((l.session_id.clone(), vec![l])),
        }
    }
    out
}

/// What goes now (v1 later.js:396-437). At most `room` sends, reminders and missed entries.
/// `hold`: what holds back unattended work on a task's account, asked only while the task is free.
pub fn due(
    entries: &[LaterEntry],
    tasks: &BTreeMap<String, Task>,
    hold: &mut dyn FnMut(&Task) -> Option<LaterHeld>,
    now: i64,
    room: usize,
) -> Decision {
    let mut d = Decision::default();
    for (sid, due) in by_task(entries, now) {
        let Some(task) = tasks.get(&sid) else {
            d.actions.push(Action::Forget { session_id: sid });
            continue;
        };
        if task.archived {
            d.actions.push(Action::Lapse { session_id: sid, ids: due.iter().map(|l| l.id.clone()).collect() });
            continue;
        }
        // Not the user's, and the plan holds: it waits for the reset, and the next due one goes instead.
        let mut next = None;
        for l in due {
            let h = if l.remind || !l.unattended() || !task.free() { None } else { hold(task) };
            let Some(h) = h else {
                next = Some(l);
                break;
            };
            d.actions.push(Action::Hold { session_id: sid.clone(), id: l.id.clone(), at: held_at(&h, now), held: h });
        }
        let Some(l) = next else { continue };
        if !l.remind && !task.free() {
            d.retry = true; // held while it works; tries again on the next look
            continue;
        }
        if d.used >= room {
            d.retry = true;
            continue;
        }
        d.used += 1;
        let (session_id, id) = (sid.clone(), l.id.clone());
        d.actions.push(if l.remind {
            Action::Remind { session_id, id }
        } else if now - l.at > MISSED_MS {
            Action::Missed { session_id, id }
        } else {
            Action::Fire { session_id, id, late: now - l.at > LATE_MS }
        });
    }
    d
}

/// One plan's fate now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanAction {
    /// it starts: a task launches, a reminder becomes a task of its own
    Run { id: String },
    /// a task plan a day overdue becomes a "Missed: …" reminder instead
    Missed { id: String },
    /// the task it waited for went (`deleted`) or was put away unfinished (`archived`): a draft now
    Lose { id: String, why: &'static str },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanDecision {
    pub actions: Vec<PlanAction>,
    pub retry: bool,
    pub used: usize,
}

/// Which plans start (v1 later.js:363-392): timed ones that came due, then `/after` ones whose task is
/// done. At most `room` start; a draft never comes due by itself.
pub fn due_plans(plans: &[Plan], tasks: &BTreeMap<String, Task>, now: i64, room: usize) -> PlanDecision {
    let mut d = PlanDecision::default();
    let mut timed: Vec<&Plan> = plans.iter().filter(|p| p.at.is_some_and(|at| at <= now)).collect();
    timed.sort_by_key(|p| p.sort_key());
    for p in timed {
        if d.used >= room {
            d.retry = true;
            break;
        }
        d.used += 1;
        let missed = p.kind == PlanKind::Task && p.at.is_some_and(|at| now - at > MISSED_MS);
        d.actions.push(if missed { PlanAction::Missed { id: p.id.clone() } } else { PlanAction::Run { id: p.id.clone() } });
    }
    for p in plans.iter().filter(|p| p.at.is_none()) {
        let Some(after) = &p.after else { continue };
        match tasks.get(&after.id) {
            Some(t) if t.state == TaskState::Done => {
                if d.used >= room {
                    d.retry = true;
                    continue;
                }
                d.used += 1;
                d.actions.push(PlanAction::Run { id: p.id.clone() });
            }
            Some(t) if t.archived => d.actions.push(PlanAction::Lose { id: p.id.clone(), why: "archived" }),
            Some(_) => {}
            None => d.actions.push(PlanAction::Lose { id: p.id.clone(), why: "deleted" }),
        }
    }
    d
}

/// A window of `agent`'s `account` reset early (v1 pullForward): a follow-up moved by Automations stop at
/// (on a task that runs on that plan) or one waiting at that limit comes due now, `held` cleared.
/// → the entries it moved. The caller checks first that nothing holds the account any more.
pub fn pull_forward(entries: &[LaterEntry], tasks: &BTreeMap<String, Task>, agent: &str, account: &str, now: i64) -> Vec<LaterEntry> {
    let acct = |a: &str| {
        if a.is_empty() { "default".to_owned() } else { a.to_owned() }
    };
    entries
        .iter()
        .filter(|l| l.at > now)
        .filter(|l| {
            let Some(t) = tasks.get(&l.session_id).filter(|t| !t.archived) else {
                return false;
            };
            let mine = t.agent == agent && acct(&t.account) == account;
            (l.held.is_some() && mine) || l.limit.as_ref().is_some_and(|x| x.agent == agent && acct(&x.account) == account)
        })
        .map(|l| LaterEntry { at: now, held: None, ..l.clone() })
        .collect()
}

/// The soonest thing that will run, for `GET /api/status` (v1 nextAt): a host starts a stopped wisp for
/// it. Never in the past, or a host would never let an idle wisp stop; a task that asks the user wakes
/// nothing but its reminders.
pub fn next_at(entries: &[LaterEntry], plans: &[Plan], tasks: &BTreeMap<String, Task>, now: i64) -> Option<i64> {
    let ents = entries.iter().filter(|l| tasks.get(&l.session_id).is_some_and(|t| !t.archived && (l.remind || !t.asking))).map(|l| l.at);
    let next = plans.iter().filter_map(|p| p.at).chain(ents).min()?;
    Some(next.max(now + MIN_MS))
}
