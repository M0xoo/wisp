//! What may be scheduled, edited, parked and cancelled (v1 later.js add/edit/done/plan/editPlan,
//! routes/sessions.js PATCH forLater, runner.js:1456 #startTurn), and the texts wisp writes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_later_api::{
    AGENT_MAX_MS, AddArgs, BY_USER, BY_WISP, CHAIN_MAX, EditArgs, EditPlanArgs, FILES_MAX,
    ForLater, LaterEntry, LaterExt, LaterView, Lost, MAX_MS, Origin, PER_TASK, ParkArgs, Plan,
    PlanArgs, PlanKind, Reminder, SentMeta, TEXT_MAX, TaskRef,
};

use crate::decide::{Task, TaskState};
use crate::time::{clock, short, when_of};
use crate::{LaterError, Result, bad};

/// What wisp.later keeps about a task besides its entries (v1 session.laterChain, forLater, reminder,
/// kind, origin, and the follow-up being sent).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    /// the agent's wake-ups in a row with no word from the user
    #[serde(default)]
    pub chain: u32,
    #[serde(default)]
    pub for_later: Option<ForLater>,
    #[serde(default)]
    pub reminder: Option<Reminder>,
    /// a reminder of its own (v1 `kind: 'reminder'`): no agent to talk to
    #[serde(default)]
    pub card: bool,
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub sent: Option<SentMeta>,
}

impl TaskMeta {
    /// The task's ext slot: what the list row and other machines see.
    pub fn ext(&self, entries: &[LaterEntry]) -> LaterExt {
        LaterExt {
            later: entries.iter().map(LaterView::from).collect(),
            for_later: self.for_later.clone(),
            reminder: self.reminder.clone(),
            kind: self.card.then(|| "reminder".to_owned()),
            origin: self.origin.clone(),
            sent: self.sent.clone(),
        }
    }
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Trimmed, required, at most 4000 characters.
pub fn text_of(t: Option<&str>, what: &str) -> Result<String> {
    let s = t.unwrap_or("").trim();
    if s.is_empty() {
        return Err(bad(format!("{what} required")));
    }
    Ok(clip(s, TEXT_MAX))
}

/// A plan's title: its prompt's first line, 80 characters.
pub fn title_of(prompt: &str) -> String {
    clip(prompt.lines().next().unwrap_or(""), 80)
}

/// A new entry on `task` (v1 later.add). `pending`: entries it has now.
pub fn new_entry(
    id: String,
    task: &Task,
    meta: &TaskMeta,
    pending: usize,
    a: &AddArgs,
    now: i64,
    tz: i32,
) -> Result<LaterEntry> {
    if task.sub {
        return Err(bad("A subagent can’t schedule follow-ups: its lead can."));
    }
    if meta.card {
        return Err(bad("That’s a reminder: snooze it instead."));
    }
    if task.tour {
        return Err(bad(
            "This is the tour — launch a real wisp to schedule things.",
        ));
    }
    if pending >= PER_TASK {
        return Err(bad(format!(
            "A task can have {PER_TASK} follow-ups scheduled at most. Cancel one first."
        )));
    }
    let by = a.by.clone().unwrap_or_else(|| BY_USER.to_owned());
    let agent = by != BY_USER;
    if agent && meta.chain >= CHAIN_MAX {
        return Err(bad(format!(
            "That's {CHAIN_MAX} scheduled follow-ups in a row with no word from the user. Don't schedule another: report where things stand, and the user can follow up."
        )));
    }
    let at = when_of(&a.when, now, if agent { AGENT_MAX_MS } else { MAX_MS }, tz)?;
    let text = text_of(
        a.text.as_deref(),
        if a.remind {
            "What to remind you about"
        } else {
            "The follow-up"
        },
    )?;
    let wisp = by == BY_WISP;
    let attachments = if a.remind {
        Vec::new()
    } else {
        a.attachments
            .iter()
            .filter(|v| v.is_object() || v.is_string())
            .take(FILES_MAX)
            .cloned()
            .collect()
    };
    Ok(LaterEntry {
        id,
        session_id: task.id.clone(),
        at,
        text,
        by,
        set_at: now,
        remind: a.remind,
        goal: a.goal.filter(|_| wisp),
        held: a.held.clone(),
        limit: a.limit.clone().filter(|_| wisp),
        attachments,
    })
}

/// Another time (which clears `held`: the user's time now, not the reset's) or another text.
pub fn edit_entry(l: &LaterEntry, a: &EditArgs, now: i64, tz: i32) -> Result<LaterEntry> {
    let mut next = l.clone();
    if a.when.given() {
        next.at = when_of(&a.when, now, MAX_MS, tz)?;
        next.held = None;
    }
    if let Some(t) = a.text.as_deref() {
        next.text = text_of(Some(t), "text")?;
    }
    Ok(next)
}

/// Mark done: the agent's and wisp's wake-ups go (it was told it's finished); the user's stay.
/// → (kept, dropped)
pub fn done_split(entries: Vec<LaterEntry>) -> (Vec<LaterEntry>, Vec<LaterEntry>) {
    entries.into_iter().partition(|l| !l.unattended())
}

/// For later (routes/sessions.js:296-333), applied after state and archived so Undo can send
/// `{state: 'review', forLater: <the old time>}`. → the task's new For later.
pub fn park(
    task: &Task,
    current: Option<&ForLater>,
    a: &ParkArgs,
    now: i64,
) -> Result<Option<ForLater>> {
    let n = a
        .for_later
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite());
    let park = a.for_later == Some(Value::Bool(true)) || n.is_some_and(|f| f > 0.0);
    if park && !task.free() {
        return Err(LaterError::Conflict(
            "Still working — save it for later once it’s finished.".into(),
        ));
    }
    if park && !task.archived {
        #[allow(clippy::cast_possible_truncation)] // a time in ms, finite
        let at = n.map_or(now, |f| f.round() as i64).min(now); // never in the future
        return Ok(Some(ForLater {
            at,
            by: a.by.clone().unwrap_or_else(|| BY_USER.to_owned()),
        }));
    }
    let out = a.for_later == Some(Value::Bool(false)) || a.state.is_some() || task.archived;
    Ok(if out { None } else { current.cloned() })
}

/// A turn started on the task (runner.js:1471-1475, 1484): the follow-up it carries is accounted for,
/// an agent's wake-ups count up until the user says something, and new work (not Compact) answers a
/// reminder and takes the task out of For later. → (new meta, the meta the turn records)
pub fn on_turn(meta: &TaskMeta, by: Option<&str>) -> (TaskMeta, Option<SentMeta>) {
    let mut next = meta.clone();
    let sent = if by == Some("later") {
        next.sent.take()
    } else {
        None
    };
    match &sent {
        Some(s) if s.by != BY_USER => next.chain += 1,
        Some(_) => next.chain = 0,
        None if by != Some(BY_WISP) => next.chain = 0,
        None => {}
    }
    if by != Some("compact") {
        next.reminder = None;
        next.for_later = None;
    }
    (next, sent)
}

/// A reminder comes due: the task comes back to Needs you (v1 fire with remind). → (reminder, new state)
pub fn reminder_of(
    task: &Task,
    l: &LaterEntry,
    text: String,
    missed: bool,
) -> (Reminder, TaskState) {
    let running = task.state == TaskState::Running;
    let was = if running {
        TaskState::Review
    } else {
        task.state
    };
    let reminder = Reminder {
        text,
        at: l.at,
        set_at: l.set_at,
        by: l.by.clone(),
        was: Some(was.as_str().to_owned()),
        from: None,
        missed,
    };
    (
        reminder,
        if running {
            TaskState::Running
        } else {
            TaskState::Review
        },
    )
}

/// v1 later.js:428: a follow-up a day late lands in Needs you, unsent.
pub fn missed_text(l: &LaterEntry, now: i64, tz: i32) -> String {
    format!(
        "Missed follow-up (due at {}, wisp was off): {}",
        clock(l.at, now, tz),
        l.text
    )
}

/// The note the agent reads ahead of a follow-up it (or the user) scheduled (v1 laterNote).
pub fn late_note(l: &SentMeta, now: i64, tz: i32) -> String {
    let who = match l.by.as_str() {
        "agent" => "you",
        "user" => "the user",
        other => other,
    };
    let late = if l.late {
        let mins = (now - l.at + 30_000).div_euclid(60_000);
        format!(
            " It was due at {} but wisp wasn't running then, so it's {mins} min late: check the current state before you act on anything you saw before.",
            clock(l.at, now, tz)
        )
    } else {
        String::new()
    };
    format!(
        "(wisp: this is the follow-up {who} scheduled at {} for {}. Carry on from where this conversation left off.{late})",
        clock(l.set_at, now, tz),
        clock(l.at, now, tz)
    )
}

/// What `resume_later` answers the agent (v1 internal.js:93-95).
pub fn scheduled_text(l: &LaterEntry, others: &[LaterEntry], now: i64, tz: i32) -> String {
    let mins = (l.at - now + 30_000).div_euclid(60_000);
    let list: Vec<String> = others
        .iter()
        .map(|x| {
            format!(
                "- {} at {}: {}",
                x.id,
                short(x.at, tz),
                clip_dots(&x.text, 80)
            )
        })
        .collect();
    let also = if list.is_empty() {
        String::new()
    } else {
        format!("\nAlso pending on this task:\n{}", list.join("\n"))
    };
    format!(
        "Scheduled (id {}) for {}, in {mins} min. Finish your turn now with your report, saying what you'll check then; wisp resumes this conversation at that time with your message.{also}",
        l.id,
        short(l.at, tz)
    )
}

fn clip_dots(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}…", clip(s, n - 1))
    } else {
        s.to_owned()
    }
}

/// `at` from an agent must carry its offset (v1 internal.js:89).
pub fn agent_at_ok(at: &str) -> bool {
    let t = at.trim();
    t.ends_with('Z') || {
        let b = t.as_bytes();
        let tail = |n: usize| {
            b.len() > n
                && matches!(b[b.len() - n - 1], b'+' | b'-')
                && b[b.len() - n..]
                    .iter()
                    .all(|c| c.is_ascii_digit() || *c == b':')
        };
        (tail(5) && b[b.len() - 3] == b':') || tail(4)
    }
}

/// `after`: a task id (or `{id}`) here (v1 later.js #afterOf).
pub fn after_id(after: &Value) -> Result<String> {
    let id = match after {
        Value::Object(o) => o.get("id").and_then(Value::as_str).unwrap_or(""),
        Value::String(s) => s.as_str(),
        _ => "",
    }
    .trim();
    let ok = (6..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(id.to_owned())
    } else {
        Err(bad("Say which task it waits for: its id."))
    }
}

/// A new plan (v1 later.plan). `after`: the task it waits for, already looked up (None: not here).
pub fn new_plan(
    id: String,
    a: &PlanArgs,
    after: Option<(&Task, bool)>,
    now: i64,
    tz: i32,
) -> Result<Plan> {
    if (a.draft || a.after.is_some()) && a.kind != PlanKind::Task {
        return Err(bad("Only a task can be a draft, or wait for another task."));
    }
    let mut p = Plan {
        id,
        kind: a.kind,
        set_at: now,
        at: None,
        draft: false,
        after: None,
        lost: None,
        body: None,
        title: None,
        text: None,
        from: None,
    };
    if a.draft {
        p.draft = true;
    } else if let Some(v) = &a.after {
        let wanted = after_id(v)?;
        let Some((t, card)) = after else {
            return Err(LaterError::NotFound(
                "No task with that id here: /after waits for a task on this computer.".into(),
            ));
        };
        if card {
            return Err(bad("That’s a reminder, not a task to wait for."));
        }
        let title = if t.title.is_empty() {
            "Untitled task".to_owned()
        } else {
            clip(&t.title, 200)
        };
        p.after = Some(TaskRef { id: wanted, title });
    } else {
        p.at = Some(when_of(&a.when, now, MAX_MS, tz)?);
    }
    match a.kind {
        PlanKind::Task => {
            let Some(Value::Object(body)) = &a.body else {
                return Err(bad("body required: the task to start."));
            };
            let prompt = text_of(body.get("prompt").and_then(Value::as_str), "prompt")?;
            p.title = Some(title_of(&prompt));
            let mut body = body.clone();
            body.insert("prompt".into(), Value::String(prompt));
            p.body = Some(Value::Object(body));
        }
        PlanKind::Reminder => {
            p.text = Some(text_of(a.text.as_deref(), "What to remind you about")?);
            p.from = a.from.as_ref().and_then(|f| {
                let id = f
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())?;
                Some(TaskRef {
                    id: clip(id, 60),
                    title: clip(f.get("title").and_then(Value::as_str).unwrap_or(""), 200),
                })
            });
        }
    }
    Ok(p)
}

/// Another time (a draft, or one waiting for a task, is scheduled instead), text or prompt.
pub fn edit_plan(p: &Plan, a: &EditPlanArgs, now: i64, tz: i32) -> Result<Plan> {
    let mut p = p.clone();
    if a.when.given() {
        p.at = Some(when_of(&a.when, now, MAX_MS, tz)?);
        p.draft = false;
        p.after = None;
        p.lost = None;
    }
    if let (Some(t), PlanKind::Reminder) = (a.text.as_deref(), p.kind) {
        p.text = Some(text_of(Some(t), "text")?);
    }
    if let (Some(pr), PlanKind::Task, Some(Value::Object(body))) =
        (a.prompt.as_deref(), p.kind, p.body.as_mut())
    {
        let prompt = text_of(Some(pr), "prompt")?;
        p.title = Some(title_of(&prompt));
        body.insert("prompt".into(), Value::String(prompt));
    }
    Ok(p)
}

/// Waiting for a task that can't be done any more (deleted, archived): it waits in Drafts.
pub fn lose(p: &Plan, why: &str) -> Plan {
    let mut p = p.clone();
    if let Some(after) = p.after.take() {
        p.draft = true;
        p.lost = Some(Lost {
            id: after.id,
            title: after.title,
            why: why.to_owned(),
        });
    }
    p
}

/// Where a plan's task came from, as its row says.
pub fn origin_of(p: &Plan) -> Origin {
    let name = match (&p.after, p.draft) {
        (Some(a), _) => format!("After {}", a.title),
        (None, true) => "Draft".to_owned(),
        (None, false) => "Scheduled".to_owned(),
    };
    Origin {
        kind: "later".into(),
        id: p.id.clone(),
        name,
    }
}

/// A task plan that couldn't start: why, where the user will see it (v1 later.js:298-300).
pub fn failed_text(p: &Plan, why: &str) -> String {
    let title = p.title.as_deref().unwrap_or("");
    let when = match (&p.after, p.draft) {
        (Some(a), _) => format!("after “{}”", a.title),
        (None, true) => "from Drafts".to_owned(),
        (None, false) => "at the time you set".to_owned(),
    };
    format!("Couldn’t start “{title}” {when}: {why}")
}

/// A task plan a day overdue isn't started behind the user's back (v1 later.js:380).
pub fn missed_plan_text(p: &Plan, now: i64, tz: i32) -> String {
    format!(
        "Missed: “{}” was due at {} while wisp was off. Start it again if you still want it.",
        p.title.as_deref().unwrap_or(""),
        clock(p.at.unwrap_or(now), now, tz)
    )
}

/// The hero of a reminder of its own: "A reminder you set at 14:32 in “Fix login”." (or nothing when it
/// stands for a plan that failed).
pub fn card_summary(p: &Plan, failed: bool, now: i64, tz: i32) -> String {
    if failed {
        return String::new();
    }
    let from = p
        .from
        .as_ref()
        .map(|f| format!(" in “{}”", f.title))
        .unwrap_or_default();
    format!("A reminder you set at {}{from}.", clock(p.set_at, now, tz))
}

/// A card's title: its text's first line, 120 characters.
pub fn card_title(text: &str) -> String {
    clip(text.lines().next().unwrap_or(""), 120)
}
