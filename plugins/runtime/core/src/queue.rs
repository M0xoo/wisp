//! The follow-up queue decider (v1 runner.js `reply`, `stop`, `sendQueued`, `mergeQueued`, `editQueued`,
//! `reorderQueue`, `unqueue`, the run's `release`, `#reportBack`). Pure: it edits the task's queue and
//! says what the host must do next (start a turn, interrupt the run, let a lingering CLI go).
//!
//! The rules every edge case came from:
//! - A Stop never discards queued follow-ups: it holds them (`queue_held`), and nothing goes out by itself
//!   after it. The next message you send (or Send now) carries the queue on.
//! - Interrupting needs a conversation to resume: before the agent reports one, a follow-up queues.
//! - An interrupting follow-up goes ahead of what is queued, but after earlier interrupting ones.
//! - A CLI that only lingers after its result has nothing to wait for: the follow-up goes now.
//! - A held turn goes first: what you send while one waits queues behind it.
//! - wisp's own queued items (reports back, repairs) are not yours to edit or merge.

use wisp_runtime_api::model::QueueItem;

/// What the task's run is doing, as the decider needs to know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Run {
    /// no process for this task
    Idle,
    /// a turn is running; `resumable`: the agent reported its conversation id
    Running { resumable: bool },
    /// the turn has its result; the CLI is only on its way out
    Lingering,
}

/// The part of a task the queue decider reads and writes.
#[derive(Debug)]
pub struct Queue<'a> {
    pub items: &'a mut Vec<QueueItem>,
    pub held: &'a mut bool,
}

/// A follow-up as it arrives.
#[derive(Debug, Clone)]
pub struct Incoming {
    pub item: QueueItem,
    /// the sender asked to wait in the queue rather than interrupt
    pub queue: bool,
    /// it carries more than text (a mode, a harness, grants, a `by`): never an answer to an open ask
    pub has_extras: bool,
    /// the guard said it would cross the user's line: keep it as a held turn
    pub hold: bool,
}

/// What the host does with a follow-up.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// the task has an open question and this is a plain reply: it answers it
    Answer(QueueItem),
    /// nothing runs: start a turn with it now
    Start(QueueItem),
    /// it waits in the queue; `ahead`: items before it
    Queued { ahead: usize },
    /// it went to the front (after earlier interrupting ones); interrupt the run
    Interrupt,
    /// keep it as a held turn
    Hold(QueueItem),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub plan: Plan,
    /// release the task's held turn first (it goes before this one)
    pub release_held: bool,
    /// let the lingering CLI go now (its release starts the queue)
    pub release_linger: bool,
    /// tell `runtime.after@1` steps someone moved the task on (they decide by `by`)
    pub cancel_after: bool,
}

fn by<'a>(item: &'a QueueItem) -> Option<&'a str> {
    item.by.as_deref()
}

/// `compact`: Compact now is housekeeping; `wisp`: wisp's own follow-up. Neither is a word from you.
fn from_you(by: Option<&str>) -> bool {
    !matches!(by, Some("wisp" | "compact"))
}

/// The index an interrupting item goes to: ahead of anything queued, after earlier interrupting ones.
fn front(items: &[QueueItem]) -> usize {
    items.iter().position(|q| !q.now).unwrap_or(items.len())
}

/// A follow-up arrives (v1 `reply`). `asking`: the task has an open ask; `last_held`: its last turn is
/// held. Edits the queue and says what to do.
pub fn follow_up(q: &mut Queue<'_>, run: Run, asking: bool, last_held: bool, inc: Incoming) -> Decision {
    let Incoming { item, mut queue, has_extras, hold } = inc;
    let you = from_you(by(&item));
    let cancel_after = by(&item) != Some("compact");
    // You're back: a queue a Stop held carries on after this one.
    if you {
        *q.held = false;
    }
    let mk = |plan, release_held, release_linger| Decision { plan, release_held, release_linger, cancel_after };
    if asking && !has_extras {
        return mk(Plan::Answer(item), false, false);
    }
    let release_held = last_held;
    if release_held {
        queue = true;
    }
    let mut run = run;
    let mut release_linger = false;
    // A CLI only lingering after its result has nothing left to wait for: let it go, so the hold holds.
    if hold && run == Run::Lingering && q.items.is_empty() {
        release_linger = true;
        run = Run::Idle;
    }
    if hold && run == Run::Idle && !release_held {
        return mk(Plan::Hold(item), false, release_linger);
    }
    match run {
        Run::Idle if !release_held => mk(Plan::Start(item), false, release_linger),
        // The held turn starts now and holds the run: this one waits behind it.
        Run::Idle => {
            q.items.push(item);
            mk(Plan::Queued { ahead: q.items.len() - 1 }, true, release_linger)
        }
        Run::Lingering => {
            q.items.push(item);
            mk(Plan::Queued { ahead: q.items.len() - 1 }, release_held, true)
        }
        Run::Running { resumable } if queue || !resumable => {
            q.items.push(item);
            mk(Plan::Queued { ahead: q.items.len() - 1 }, release_held, false)
        }
        Run::Running { .. } => {
            let at = front(q.items);
            q.items.insert(at, QueueItem { now: true, ..item });
            mk(Plan::Interrupt, release_held, false)
        }
    }
}

/// What the host does on Stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopPlan {
    /// stop the run's process
    pub stop_run: bool,
}

/// Stop (v1 `stop`): queued follow-ups stay, held. The host also drops the open ask and stops children.
pub fn stop(q: &mut Queue<'_>, run: Run) -> StopPlan {
    if !q.items.is_empty() {
        *q.held = true;
    }
    StopPlan { stop_run: run != Run::Idle }
}

/// The run let go (exit, linger timeout, or a follow-up): the next queued item, unless a Stop held them.
pub fn next_after_release(q: &mut Queue<'_>) -> Option<QueueItem> {
    if *q.held || q.items.is_empty() {
        return None;
    }
    Some(q.items.remove(0))
}

#[derive(Debug, Clone, PartialEq)]
pub enum SendNow {
    /// nothing runs: start it now
    Start(QueueItem),
    /// it is next; interrupt the run
    Interrupt,
    /// it is next; let the lingering CLI go
    ReleaseLinger,
    /// it is next (the run can't be interrupted before it reports a conversation)
    Next,
}

/// Send now on a queued item (v1 `sendQueued`). None: no such item. `cancel_after` is true unless wisp's.
pub fn send_now(q: &mut Queue<'_>, run: Run, item_id: &str) -> Option<(SendNow, bool)> {
    let at = q.items.iter().position(|x| x.id == item_id)?;
    let item = q.items.remove(at);
    *q.held = false;
    let cancel_after = !item.by_wisp();
    let plan = match run {
        Run::Idle => SendNow::Start(item),
        Run::Lingering => {
            let at = front(q.items);
            q.items.insert(at, item);
            SendNow::ReleaseLinger
        }
        Run::Running { resumable } => {
            let at = front(q.items);
            q.items.insert(at, QueueItem { now: resumable, ..item });
            if resumable { SendNow::Interrupt } else { SendNow::Next }
        }
    };
    Some((plan, cancel_after))
}

/// Take one item back (v1 `unqueue`). An emptied queue is no longer held.
pub fn remove(q: &mut Queue<'_>, item_id: &str) -> bool {
    let Some(at) = q.items.iter().position(|x| x.id == item_id) else { return false };
    q.items.remove(at);
    if q.items.is_empty() {
        *q.held = false;
    }
    true
}

/// Combine queued follow-ups into one, in the queue's order (v1 `mergeQueued`): it goes where the first
/// was, with its mode and harness, saying each in turn, with all their files. Only yours.
pub fn merge(q: &mut Queue<'_>, ids: &[String]) -> bool {
    let picked: Vec<usize> = q.items.iter().enumerate().filter(|(_, x)| ids.contains(&x.id) && !x.by_wisp()).map(|(i, _)| i).collect();
    let [first, rest @ ..] = picked.as_slice() else { return false };
    if rest.is_empty() {
        return false;
    }
    let text = picked.iter().map(|&i| q.items[i].text.trim()).collect::<Vec<_>>().join("\n\n");
    let attachments = picked.iter().flat_map(|&i| q.items[i].attachments.clone()).collect();
    let item = &mut q.items[*first];
    item.text = text;
    item.attachments = attachments;
    let mut i = 0;
    q.items.retain(|_| {
        let keep = !rest.contains(&i);
        i += 1;
        keep
    });
    true
}

/// Change what a queued follow-up says (v1 `editQueued`). Only yours.
pub fn edit_text(q: &mut Queue<'_>, item_id: &str, text: &str) -> bool {
    match q.items.iter_mut().find(|x| x.id == item_id) {
        Some(x) if !x.by_wisp() => {
            text.clone_into(&mut x.text);
            true
        }
        _ => false,
    }
}

/// Put the queue in this order (v1 `reorderQueue`). Unknown ids are skipped; any left out keep their
/// place at the end, so an item queued meanwhile isn't lost. false when the queue is empty.
pub fn reorder(q: &mut Queue<'_>, ids: &[String]) -> bool {
    if q.items.is_empty() {
        return false;
    }
    let mut seen: Vec<&str> = Vec::with_capacity(ids.len());
    for id in ids {
        if !seen.contains(&id.as_str()) && q.items.iter().any(|x| &x.id == id) {
            seen.push(id);
        }
    }
    let mut out: Vec<QueueItem> = Vec::with_capacity(q.items.len());
    for id in &seen {
        if let Some(x) = q.items.iter().find(|x| x.id == *id) {
            out.push(x.clone());
        }
    }
    out.extend(q.items.iter().filter(|x| !seen.contains(&x.id.as_str())).cloned());
    *q.items = out;
    true
}

/// How a lead hears what its finished delegations reported (v1 `#reportBack`).
#[derive(Debug, Clone, PartialEq)]
pub enum ReportBack {
    /// merged into the report already waiting in its queue
    Merged,
    /// queued as wisp's follow-up (the lead's run is ending, or lingering: `release_linger`)
    Queued { release_linger: bool },
    /// nothing runs: start the follow-up now
    Start(QueueItem),
}

/// `ending`: called as the lead's own turn ends (its release starts the queue). `item` carries the
/// header and the reports as its text, `by: wisp`, `reports: true`.
pub fn report_back(q: &mut Queue<'_>, run: Run, ending: bool, item: QueueItem, reports: &str) -> ReportBack {
    if let Some(waiting) = q.items.iter_mut().find(|x| x.reports) {
        waiting.text.push_str("\n\n---\n\n");
        waiting.text.push_str(reports);
        return ReportBack::Merged;
    }
    let lingering = !ending && run == Run::Lingering;
    if ending || lingering || matches!(run, Run::Running { .. }) {
        q.items.push(item);
        return ReportBack::Queued { release_linger: lingering };
    }
    ReportBack::Start(item)
}
