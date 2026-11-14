//! The trigger engine's decisions (ADR-0043), sans-IO: an event comes in, the trigger's state and spec say what
//! happens. The host runs what's decided (starts the job, stops a run, notifies) and saves the state.
//!
//! In order, for an event: off, unavailable or paused → skipped; a key seen before → nothing (dedupe holds
//! across polls and restarts: the seen set is part of the state); its own task's event, a pipeline step's, or one 3 causes deep →
//! skipped (no loops); `match` and `users` → nothing / refused; `if` → nothing; `when` → skipped or queued;
//! `debounce` → batched. Then the gate, for a job (an event, a batch, a queued job): a paused member, a
//! cooldown, the `rate`, the daily `budget` → held and queued, with why (never dropped); `concurrency`; and
//! `approval` (never in Full auto) → awaiting a yes. Else it starts.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_automations_api::spec::{duration_ms, rate_of};
use wisp_automations_api::{TriggerEvent, TriggerSpec, When, local_fields};

/// How many event keys a trigger remembers.
pub const SEEN_MAX: usize = 512;
/// How many deliveries a trigger shows.
pub const DELIVERIES_MAX: usize = 20;
/// How many held jobs a trigger keeps (past it, the oldest is dropped, said in its deliveries).
pub const QUEUE_MAX: usize = 100;
/// A chain of causes this deep is a loop (a trigger's task's event started a trigger's task …).
pub const MAX_DEPTH: u32 = 3;
/// Failed runs in a row that pause a trigger.
pub const PAUSE_AFTER: u32 = 3;

/// A job a trigger wants to start: one event, or a batch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub events: Vec<TriggerEvent>,
    pub at: i64,
    /// why it's waiting, when it is
    #[serde(default)]
    pub why: String,
}

/// One thing that happened to an event or a job (the trigger's log).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Delivery {
    pub at: i64,
    /// started | queued | held | skipped | batched | awaiting | failed | done | skipped by member | dropped
    pub result: String,
    pub why: String,
    #[serde(default)]
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

/// A trigger's state: what the engine keeps between events and restarts (v1's `TriggerBase` bookkeeping).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub seen: VecDeque<String>,
    /// a schedule's last fired local minute
    #[serde(default)]
    pub last_minute: Option<i64>,
    /// when its runs started, within the rate's window
    #[serde(default)]
    pub runs: VecDeque<i64>,
    #[serde(default)]
    pub failures: u32,
    /// why it's paused (three failures in a row)
    #[serde(default)]
    pub paused: Option<String>,
    #[serde(default)]
    pub cooldown_until: Option<i64>,
    /// its jobs running now (task ids)
    #[serde(default)]
    pub running: Vec<String>,
    #[serde(default)]
    pub queue: VecDeque<Job>,
    #[serde(default)]
    pub batch: Vec<TriggerEvent>,
    #[serde(default)]
    pub batch_due: Option<i64>,
    /// (day, USD) its runs spent that day
    #[serde(default)]
    pub spent: (i64, f64),
    #[serde(default)]
    pub awaiting: Vec<Job>,
    #[serde(default)]
    pub deliveries: VecDeque<Delivery>,
    /// its source is gone: why
    #[serde(default)]
    pub unavailable: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub runs_total: u32,
    #[serde(default)]
    pub next_job: u64,
    /// a polled source's cursor, its next poll, and its errors in a row
    #[serde(default)]
    pub cursor: Value,
    #[serde(default)]
    pub next_poll_at: Option<i64>,
    #[serde(default)]
    pub poll_failures: u32,
    /// the runs it started, by task id, and how many causes deep each is (a loop of triggers is cut at 3)
    #[serde(default)]
    pub depths: std::collections::BTreeMap<String, u32>,
    /// a run it started waits for its plan (Automations stop at): the row says so until the plan frees
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<crate::plan::PlanWait>,
}

/// What the world says, for a decision.
#[derive(Debug, Clone, Copy, Default)]
pub struct World {
    pub now: i64,
    /// the job runs in Full auto (its mode, or its member's)
    pub full_auto: bool,
    /// its member is paused
    pub member_paused: bool,
    /// the `when` window is open now (the host reads it in the trigger's zone)
    pub in_window: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// not for this trigger (its filters, its `if`): nothing recorded
    Nothing,
    Skipped(String),
    Batched {
        due: i64,
    },
    Queued(String),
    /// held back (rate, budget, cooldown, a paused member), queued with why
    Held(String),
    Awaiting(Job),
    /// stop these runs, then start the job (`concurrency: replace`)
    Replace {
        stop: Vec<String>,
        job: Job,
    },
    Start(Job),
}

impl State {
    pub fn log(&mut self, at: i64, result: &str, why: &str, key: &str, session: Option<String>) {
        self.deliveries.push_back(Delivery { at, result: result.into(), why: why.into(), key: key.into(), session });
        while self.deliveries.len() > DELIVERIES_MAX {
            self.deliveries.pop_front();
        }
    }
    fn job(&mut self, events: Vec<TriggerEvent>, at: i64) -> Job {
        self.next_job += 1;
        Job { id: format!("j{}", self.next_job), events, at, why: String::new() }
    }
    fn hold(&mut self, mut job: Job, why: String, at: i64) -> Decision {
        job.why.clone_from(&why);
        let key = job.events.first().map(|e| e.key.clone()).unwrap_or_default();
        if !self.queue.iter().any(|j| j.id == job.id) {
            self.queue.push_back(job);
            while self.queue.len() > QUEUE_MAX {
                if let Some(old) = self.queue.pop_front() {
                    let k = old.events.first().map(|e| e.key.clone()).unwrap_or_default();
                    self.log(at, "dropped", "its queue is full (100 held jobs)", &k, None);
                }
            }
        }
        self.log(at, "held", &why, &key, None);
        Decision::Held(why)
    }
}

/// `*` matches any run of characters; everything else itself.
pub fn glob(p: &str, v: &str) -> bool {
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == v;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !v.starts_with(first) || v.len() < first.len() + last.len() || !v.ends_with(last) {
        return false;
    }
    let mut at = first.len();
    let end = v.len() - last.len();
    for mid in &parts[1..parts.len() - 1] {
        match v[at..end].find(mid) {
            Some(i) => at += i + mid.len(),
            None => return false,
        }
    }
    true
}

/// Whether a filter's wanted value takes the payload's.
fn takes(key: &str, want: &Value, got: Option<&Value>) -> bool {
    let Some(got) = got else { return false };
    match want {
        Value::Array(list) => list.iter().any(|w| takes(key, w, Some(got))),
        Value::String(w) => {
            let one = |g: &Value| {
                let g = match g {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if key == "keyword" || key == "text" {
                    g.to_lowercase().contains(&w.to_lowercase())
                } else if w.starts_with('/') {
                    // a path: itself or anything under it
                    let r = w.trim_end_matches('/');
                    g == r || g.starts_with(&format!("{r}/"))
                } else {
                    glob(w, &g)
                }
            };
            match got {
                Value::Array(a) => a.iter().any(one),
                g => one(g),
            }
        }
        other => got == other,
    }
}

/// Whether the event passes the trigger's `match` (flat fields included).
pub fn filters_pass(spec: &TriggerSpec, ev: &TriggerEvent) -> bool {
    spec.all_filters().iter().all(|(k, want)| {
        // a keyword is looked for in the message's text
        let field = if k == "keyword" {
            ev.payload.get("text").or_else(|| ev.payload.get("keyword")).cloned()
        } else if k.contains('.') {
            // a flat key with a dot in it (`{"repo.name": …}`) is itself first
            ev.payload.get(k).cloned().or_else(|| at_path(&ev.payload, k))
        } else {
            ev.payload.get(k).cloned()
        };
        // a project matches the payload's project or its folder
        let field = if k == "project" { field.or_else(|| ev.payload.get("cwd").cloned()) } else { field };
        takes(k, want, field.as_ref())
    })
}

/// A dotted key into the payload (`data.labels.name`); a list on the way is looked through, so the answer is every
/// value found (a Linear issue's label names). `None` when nothing is there.
fn at_path(v: &Value, path: &str) -> Option<Value> {
    let mut here = vec![v];
    for part in path.split('.') {
        here = here
            .into_iter()
            .flat_map(|x| match x {
                Value::Array(a) => a.iter().filter_map(|y| y.get(part)).collect::<Vec<_>>(),
                o => o.get(part).into_iter().collect(),
            })
            .collect();
    }
    match here.as_slice() {
        [] => None,
        [one] if !one.is_array() => Some((*one).clone()),
        many => Some(Value::Array(many.iter().flat_map(|x| x.as_array().cloned().unwrap_or_else(|| vec![(*x).clone()])).collect())),
    }
}

/// `users`: who may start it. `anyone` opens it; else the sender's name or id must be listed.
pub fn user_allowed(spec: &TriggerSpec, ev: &TriggerEvent) -> bool {
    if spec.users.is_empty() {
        return ev.on != "chat.message";
    }
    if spec.users.iter().any(|u| u == "anyone") {
        return true;
    }
    let who = ["user", "userName", "userId"].iter().filter_map(|k| ev.payload.get(*k).and_then(Value::as_str)).collect::<Vec<_>>();
    spec.users.iter().any(|u| who.contains(&u.as_str()))
}

/// The event as `if` and the template see it.
pub fn event_scope(ev: &TriggerEvent) -> Value {
    json!({ "event": { "on": ev.on, "key": ev.key, "at": ev.at, "summary": ev.summary, "payload": ev.payload, "subject": ev.subject } })
}

/// The prompt, filled: `{event.summary}`, `{event.payload.x}`, `{event.key}`; a batch lists every event.
pub fn fill(template: &str, job: &Job) -> String {
    let Some(first) = job.events.first() else { return template.to_owned() };
    let scope = event_scope(first);
    let mut out = String::new();
    let mut rest = template;
    while let Some(i) = rest.find("{event.") {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        let Some(j) = tail.find('}') else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let path = &tail[..j];
        let mut cur = &scope;
        for part in path.split('.') {
            cur = cur.get(part).unwrap_or(&Value::Null);
        }
        out.push_str(&match cur {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        });
        rest = &tail[j + 1..];
    }
    out.push_str(rest);
    if job.events.len() > 1 {
        use std::fmt::Write as _;
        let _ = write!(out, "\n\n{} events:\n", job.events.len());
        for e in &job.events {
            let _ = writeln!(out, "- {}", if e.summary.is_empty() { &e.key } else { &e.summary });
        }
    }
    out
}

/// An event comes in.
pub fn admit(name: &str, spec: &TriggerSpec, st: &mut State, ev: TriggerEvent, w: &World) -> Decision {
    let key = ev.key.clone();
    if !spec.on() {
        return Decision::Nothing;
    }
    if let Some(why) = st.unavailable.clone() {
        return Decision::Skipped(why);
    }
    if !key.is_empty() && st.seen.contains(&key) {
        return Decision::Nothing;
    }
    if !filters_pass(spec, &ev) {
        return Decision::Nothing;
    }
    if !key.is_empty() {
        st.seen.push_back(key.clone());
        while st.seen.len() > SEEN_MAX {
            st.seen.pop_front();
        }
    }
    let skip = |st: &mut State, why: &str| {
        st.log(w.now, "skipped", why, &key, None);
        Decision::Skipped(why.to_owned())
    };
    if let Some(why) = st.paused.clone() {
        return skip(st, &format!("paused: {why}"));
    }
    if ev.by.as_deref() == Some(format!("trigger:{name}").as_str()) {
        return skip(st, "its own task's event (no loops)");
    }
    // a pipeline's review is a step of the task it reviews, not a task of its own: that task's event already
    // came (the pipeline skips trigger-started tasks the same way, router pipeline.rs)
    if ev.by.as_deref().is_some_and(|b| b.starts_with("pipeline:")) {
        return skip(st, "a pipeline step of a task, not a task of its own");
    }
    if ev.depth >= MAX_DEPTH {
        return skip(st, &format!("{} causes deep: a loop of triggers (cut at {MAX_DEPTH})", ev.depth));
    }
    if !user_allowed(spec, &ev) {
        return skip(st, "from someone not in its users");
    }
    if !spec.cond.trim().is_empty() {
        match wisp_workflows_api::expr::eval(&spec.cond, &event_scope(&ev)) {
            Ok(v) if wisp_workflows_api::expr::truthy(&v) => {}
            Ok(_) => return Decision::Nothing,
            Err(e) => return skip(st, &format!("if: {e}")),
        }
    }
    if spec.when.is_some() && !w.in_window {
        if spec.when.as_ref().is_some_and(|x| x.outside == "queue") {
            let job = st.job(vec![ev], w.now);
            let mut job = job;
            job.why = "waits for its hours".into();
            st.queue.push_back(job);
            st.log(w.now, "queued", "outside its hours: waits for them", &key, None);
            return Decision::Queued("outside its hours".into());
        }
        return skip(st, "outside its hours");
    }
    if let Some(d) = duration_ms(&spec.debounce).filter(|d| *d > 0) {
        st.batch.push(ev);
        let due = *st.batch_due.get_or_insert(w.now + d);
        st.log(w.now, "batched", &format!("{} in the batch", st.batch.len()), &key, None);
        return Decision::Batched { due };
    }
    let job = st.job(vec![ev], w.now);
    gate(spec, st, job, w)
}

/// A debounced batch whose window closed: one job for all its events.
pub fn flush(spec: &TriggerSpec, st: &mut State, w: &World) -> Option<Decision> {
    if st.batch_due.is_none_or(|d| d > w.now) || st.batch.is_empty() {
        return None;
    }
    let events = std::mem::take(&mut st.batch);
    st.batch_due = None;
    let job = st.job(events, w.now);
    Some(gate(spec, st, job, w))
}

/// A job, once its event is admitted: hold, wait, replace or start.
pub fn gate(spec: &TriggerSpec, st: &mut State, job: Job, w: &World) -> Decision {
    if w.member_paused {
        return st.hold(job, "its member is paused: it goes when they're resumed".into(), w.now);
    }
    if let Some(until) = st.cooldown_until.filter(|u| *u > w.now) {
        return st.hold(job, format!("cooling down after a failure (until {until})"), w.now);
    }
    if let Some((n, window)) = rate_of(&spec.rate) {
        while st.runs.front().is_some_and(|t| *t <= w.now - window) {
            st.runs.pop_front();
        }
        if st.runs.len() >= n as usize {
            let next = st.runs.front().map_or(w.now, |t| t + window);
            return st.hold(job, format!("rate {} reached: next at {next}", spec.rate), w.now);
        }
    }
    let day = w.now.div_euclid(86_400_000);
    if let Some(cap) = spec.budget.as_ref().and_then(|b| b.per_day) {
        let spent = if st.spent.0 == day { st.spent.1 } else { 0.0 };
        if spent >= cap {
            return st.hold(job, format!("today's budget reached (${spent:.2} of ${cap:.2})"), w.now);
        }
    }
    let key = job.events.first().map(|e| e.key.clone()).unwrap_or_default();
    if !st.running.is_empty() {
        let c = spec.concurrency.as_str();
        match c {
            "queue" => {
                let mut job = job;
                job.why = "waits for its running job".into();
                st.queue.push_back(job);
                st.log(w.now, "queued", "waits for its running job", &key, None);
                return Decision::Queued("waits for its running job".into());
            }
            "replace" => {
                let stop = st.running.clone();
                return start(spec, st, job, w, Some(stop));
            }
            _ if c.starts_with("parallel:") => {
                let n: usize = c["parallel:".len()..].parse().unwrap_or(1);
                if st.running.len() >= n {
                    let mut job = job;
                    job.why = format!("{n} running already");
                    st.queue.push_back(job);
                    st.log(w.now, "queued", &format!("{n} running already"), &key, None);
                    return Decision::Queued(format!("{n} running already"));
                }
            }
            _ => {
                st.log(w.now, "skipped", "already running", &key, None);
                return Decision::Skipped("already running".into());
            }
        }
    }
    start(spec, st, job, w, None)
}

fn start(spec: &TriggerSpec, st: &mut State, job: Job, w: &World, stop: Option<Vec<String>>) -> Decision {
    let key = job.events.first().map(|e| e.key.clone()).unwrap_or_default();
    // approval: the job waits for a yes, unless it runs in Full auto (Full auto never asks)
    if spec.approval && !w.full_auto {
        st.awaiting.push(job.clone());
        st.log(w.now, "awaiting", "waits for a yes", &key, None);
        return Decision::Awaiting(job);
    }
    st.runs.push_back(w.now);
    st.last_run_at = Some(w.now);
    st.runs_total += 1;
    match stop {
        Some(stop) => Decision::Replace { stop, job },
        None => Decision::Start(job),
    }
}

/// The queued jobs that may go now, in order (a resumed member, a rate window that opened, a run that ended):
/// it stops at the first one that's still held.
pub fn drain(spec: &TriggerSpec, st: &mut State, w: &World) -> Vec<Decision> {
    let mut out = Vec::new();
    while let Some(job) = st.queue.pop_front() {
        let before = st.queue.len();
        let d = gate(spec, st, job.clone(), w);
        let held = matches!(d, Decision::Held(_) | Decision::Queued(_) | Decision::Skipped(_));
        if held {
            // put it back where it was (gate queued it at the end)
            if st.queue.len() > before {
                if let Some(j) = st.queue.pop_back() {
                    st.queue.push_front(j);
                }
            } else {
                st.queue.push_front(job);
            }
            break;
        }
        out.push(d);
    }
    out
}

/// A job started as task `session`.
pub fn started(st: &mut State, job: &Job, session: &str, now: i64) {
    st.running.push(session.to_owned());
    let depth = job.events.iter().map(|e| e.depth).max().unwrap_or(0) + 1;
    st.depths.insert(session.to_owned(), depth);
    while st.depths.len() > 200 {
        let Some(k) = st.depths.keys().next().cloned() else { break };
        st.depths.remove(&k);
    }
    let key = job.events.first().map(|e| e.key.clone()).unwrap_or_default();
    st.log(now, "started", "", &key, Some(session.to_owned()));
}

/// How a job's run ended.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Outcome {
    pub failed: bool,
    /// its member answered `quiet` (nothing to do)
    pub quiet: bool,
    pub cost: f64,
}

/// A run ended. → why the trigger paused, when that made it pause (the host notifies).
pub fn ended(spec: &TriggerSpec, st: &mut State, session: &str, o: Outcome, now: i64) -> Option<String> {
    if !st.running.iter().any(|s| s == session) {
        return None;
    }
    st.running.retain(|s| s != session);
    crate::plan::ended(st, session);
    let day = now.div_euclid(86_400_000);
    st.spent = if st.spent.0 == day { (day, st.spent.1 + o.cost) } else { (day, o.cost) };
    if o.quiet {
        st.log(now, "skipped by member", "nothing to do, it said", "", Some(session.to_owned()));
        return None;
    }
    if !o.failed {
        st.failures = 0;
        st.log(now, "done", "", "", Some(session.to_owned()));
        return None;
    }
    st.failures += 1;
    st.log(now, "failed", &format!("{} in a row", st.failures), "", Some(session.to_owned()));
    if let Some(c) = duration_ms(&spec.cooldown) {
        st.cooldown_until = Some(now + c);
    }
    if st.failures >= PAUSE_AFTER && st.paused.is_none() {
        let why = format!("{PAUSE_AFTER} failed runs in a row");
        st.paused = Some(why.clone());
        return Some(why);
    }
    None
}

pub use wisp_automations_api::spec::{wake_cycle, wake_edges};

const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn day_no(d: &str) -> Option<u32> {
    let d = d.trim().to_lowercase();
    DAYS.iter().position(|x| d.starts_with(x)).and_then(|i| u32::try_from(i).ok())
}

/// Whether weekday `wd` (0 = Sunday) is in `days` (`mon`, `mon-fri`, `weekdays`, `weekends`; empty: every day).
fn day_in(days: &[String], wd: u32) -> bool {
    days.is_empty()
        || days.iter().any(|d| match d.trim().to_lowercase().as_str() {
            "weekdays" => (1..=5).contains(&wd),
            "weekends" => wd == 0 || wd == 6,
            "every day" | "daily" | "*" => true,
            r => match r.split_once('-') {
                Some((a, b)) => match (day_no(a), day_no(b)) {
                    (Some(a), Some(b)) if a <= b => (a..=b).contains(&wd),
                    (Some(a), Some(b)) => wd >= a || wd <= b,
                    _ => false,
                },
                None => day_no(r) == Some(wd),
            },
        })
}

fn minute_of(hm: &str) -> Option<u32> {
    let (h, m) = hm.trim().split_once(':').unwrap_or((hm.trim(), "0"));
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h <= 24 && m < 60).then_some(h * 60 + m)
}

/// `when`'s window at a local instant: its days and its hours (`09:00-18:00`; `22:00-06:00` wraps past midnight,
/// and its early hours belong to the day before).
pub fn in_window(w: &When, local_ms: i64) -> bool {
    let l = local_fields(local_ms);
    let now = l.hour * 60 + l.minute;
    let Some((a, b)) = w.hours.split_once('-').and_then(|(a, b)| Some((minute_of(a)?, minute_of(b)?))) else {
        return day_in(&w.days, l.weekday);
    };
    if a <= b {
        return day_in(&w.days, l.weekday) && now >= a && now < b;
    }
    if now >= a { day_in(&w.days, l.weekday) } else { now < b && day_in(&w.days, (l.weekday + 6) % 7) }
}

/// Whether a trigger on `on` can run: some plugin offers `on` (a durable event type in its manifest or a
/// `triggerSources` entry) and is on. `owners` is every plugin that lists it, with whether it's on.
pub fn availability(on: &str, owners: &[(String, bool)]) -> Option<String> {
    if owners.iter().any(|(_, up)| *up) {
        return None;
    }
    match owners.first() {
        Some((p, _)) => Some(format!("its source ({p}) is off: switch it on to run it again")),
        None => Some(format!("no plugin offers {on}")),
    }
}

/// One event's dry run: what `admit` would decide, and the prompt it would send.
#[derive(Debug, Clone, PartialEq)]
pub struct Tried {
    pub event: TriggerEvent,
    pub decision: Decision,
    pub prompt: String,
}

/// `wisp trigger test`: each event through a copy of the trigger's state, in order (so a debounce or a rate
/// shows as it would), and the prompt each job would get. The real state isn't touched and nothing starts.
pub fn dry_run(name: &str, spec: &TriggerSpec, st: &State, events: Vec<TriggerEvent>, w: &World) -> Vec<Tried> {
    let mut copy = st.clone();
    events
        .into_iter()
        .map(|ev| {
            let d = admit(name, spec, &mut copy, ev.clone(), w);
            let job = match &d {
                Decision::Start(j) | Decision::Awaiting(j) | Decision::Replace { job: j, .. } => j.clone(),
                _ => Job { events: vec![ev.clone()], ..Job::default() },
            };
            if let Decision::Start(j) = &d {
                // as if it ran: the next event sees it running (concurrency)
                copy.running.push(format!("dry-{}", j.id));
            }
            Tried { event: ev, decision: d, prompt: fill(&spec.prompt, &job) }
        })
        .collect()
}

/// A decision as a word, for the log and `trigger.fired`.
pub fn word(d: &Decision) -> (&'static str, String) {
    match d {
        Decision::Nothing => ("nothing", String::new()),
        Decision::Skipped(w) => ("skipped", w.clone()),
        Decision::Batched { due } => ("batched", format!("until {due}")),
        Decision::Queued(w) => ("queued", w.clone()),
        Decision::Held(w) => ("held", w.clone()),
        Decision::Awaiting(_) => ("awaiting", "waits for a yes".into()),
        Decision::Replace { .. } | Decision::Start(_) => ("started", String::new()),
    }
}

/// After a poll: when to poll again, and whether it counts as a failure. A rate limit waits for its reset
/// and isn't one; an error backs off (doubling, at most an hour).
pub fn next_poll(every_ms: i64, now: i64, failures: u32, outcome: PollOutcome) -> (i64, u32) {
    match outcome {
        PollOutcome::Ok => (now + every_ms, 0),
        // no reset said (0): an hour
        PollOutcome::RateLimited { reset_at } if reset_at <= 0 => (now + 3_600_000, failures),
        PollOutcome::RateLimited { reset_at } => (reset_at.max(now + 1_000), failures),
        PollOutcome::Failed => {
            let f = failures + 1;
            let back = every_ms.saturating_mul(1 << f.min(6)).min(3_600_000);
            (now + back, f)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollOutcome {
    Ok,
    RateLimited { reset_at: i64 },
    Failed,
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
