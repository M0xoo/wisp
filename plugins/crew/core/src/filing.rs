//! Where a finished job goes and what it sends on (v1 crew.js `#turnDone`, `#sendFollowUps`, `#joinTeam`).
//! Only check-ins and `event` jobs can end quiet or For later, and only on their first turn (nobody
//! waits on them); For later beats quiet. A delegated job is always filed under Done (its lead reads it).

use wisp_crew_api::{CrewExt, FOLLOW_UPS_MAX, JobKind, Member, TeamRow};

use crate::memory::{CrewOut, FollowUp};
use crate::mentions::handle_of;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Filing {
    /// found nothing: logged and archived instead of landing in Needs you
    pub quiet: bool,
    /// filed under Done (a delegation: its lead has the answer)
    pub filed: bool,
    /// worth reading, not urgent: For later instead of a ping
    pub later: bool,
}

/// How a job's turn is filed. `turns`: how many turns the job has now; `data`: its crew block
/// (`None` for a capped job, whose block reaches nothing).
pub fn file_turn(job: JobKind, turns: usize, data: Option<&CrewOut>) -> Filing {
    let nobody_waits = job.nobody_waits() && turns == 1;
    let later = data.is_some_and(|d| d.for_later) && nobody_waits;
    let quiet = data.is_some_and(|d| d.quiet) && nobody_waits && !later;
    Filing { quiet, filed: job == JobKind::Delegated, later }
}

/// The follow-ups that may go (v1 crew.js:750-756): at most 3, each to a task the member is linked to
/// (a follow-up without a task goes to the job's own `from`). A delegated job's follow-up to the lead
/// that delegated it is dropped: that lead reads its report, and the two could bounce work back and forth.
pub fn follow_up_targets(m: &Member, job: &CrewExt, list: &[FollowUp]) -> Vec<FollowUp> {
    let from = job.from.as_ref().map(|f| f.id.as_str());
    list.iter()
        .take(FOLLOW_UPS_MAX)
        .filter_map(|f| {
            let id = if f.task.is_empty() { from? } else { f.task.as_str() };
            if job.job == JobKind::Delegated && Some(id) == from {
                return None;
            }
            m.links.iter().any(|l| l.id == id).then(|| FollowUp { task: id.to_owned(), text: f.text.clone() })
        })
        .collect()
}

/// The follow-up as the task shows it: from the member, by its stored mention.
pub fn follow_up_text(m: &Member, text: &str) -> String {
    let role = if m.role.is_empty() { String::new() } else { format!("’s {}", m.role) };
    format!("@[{}](crew:{}) (your crew{role}):\n\n{text}", m.name, m.id)
}

/// What the followed-up task is, for joining its delegates.
#[derive(Debug, Clone, Copy, Default)]
pub struct TaskSide<'a> {
    /// a subagent, a hidden delegate, or a delegated crew job: never joined (no loops)
    pub helper: bool,
    /// the task is a job of this crew member
    pub crew: Option<&'a str>,
}

/// The task's delegates with the member added, so its agent can hand the work back; `None`: unchanged.
pub fn join_team(have: &[TeamRow], task: TaskSide, m: &Member) -> Option<Vec<TeamRow>> {
    if task.helper || task.crew == Some(m.id.as_str()) || have.iter().any(|x| x.crew.as_deref() == Some(&m.id)) {
        return None;
    }
    let role = if m.role.is_empty() { String::new() } else { format!("{}. ", m.role) };
    let mut out = have.to_vec();
    let mut name = handle_of(&m.name);
    let base = name.clone();
    let mut i = 2;
    while out.iter().any(|x| x.name == name) {
        name = format!("{base}-{i}");
        i += 1;
    }
    out.push(TeamRow {
        name,
        agent: m.agent.clone(),
        crew: Some(m.id.clone()),
        label: Some(m.name.clone()),
        role: Some(m.role.clone()),
        use_: format!("{role}They followed up in this task: hand your work back to them when it should be checked"),
        count: 1,
        ..TeamRow::default()
    });
    Some(out)
}

/// A member tagged in a job joins its delegates, told to bring them in (v1 `taggedDelegate`).
pub fn tagged_delegate(m: &Member, place: &str) -> TeamRow {
    let role = if m.role.is_empty() { String::new() } else { format!("{}. ", m.role) };
    TeamRow {
        name: handle_of(&m.name),
        agent: m.agent.clone(),
        crew: Some(m.id.clone()),
        label: Some(m.name.clone()),
        role: Some(m.role.clone()),
        use_: format!("{role}The user tagged them in this {place} to work on it with you: hand them their part rather than doing it all yourself"),
        count: 1,
        ..TeamRow::default()
    }
}

/// The delegates a job gets (v1 `#teamFor`): the member's own and the ones tagged in it, never itself,
/// and no crew members for a delegated job or one that runs elsewhere (no loops between members).
pub fn team_for(m: &Member, job: JobKind, extra: &[TeamRow]) -> Vec<TeamRow> {
    let mut all = m.team.clone();
    all.extend(extra.iter().filter(|x| !m.team.iter().any(|t| t.crew.is_some() && t.crew == x.crew)).cloned());
    all.retain(|x| match x.crew.as_deref() {
        Some(id) => id != m.id && job != JobKind::Delegated && !m.elsewhere(),
        None => true,
    });
    all
}
