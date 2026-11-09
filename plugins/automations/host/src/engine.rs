//! The one trigger engine (ADR-0043), wired: triggers come from the `trigger` kind and from `trigger.provider@1`
//! (the crew's wakes); events come from the durable log (`on: <type>`), the tick (`schedule`, `once`, polled
//! sources), `automations.trigger.push` (push sources), the webhook route and `wisp trigger fire`. The decisions
//! are `wisp_automations_core::engine`'s; this file runs them: it starts the target, stops a replaced run,
//! keeps each trigger's state row (`automations_trigger_state`, v1's `TriggerBase` bookkeeping) and emits
//! `trigger.fired`.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_automations_api::commands::{FireOut, LogLine, SourceRow, Tried, TriggerRow};
use wisp_automations_api::{PROVIDERS, Polled, Provided, SOURCE, Target, TriggerEvent, TriggerFired, TriggerSpec, Zone, parse_cron};
use wisp_automations_core::engine::{self as core, Decision, Job, Outcome, PollOutcome, State, World};
use wisp_kernel::{Call, Ctx, EventEnvelope, Result, WireError};
use wisp_store::{Col, EntityDef, Query, Row, Store};

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.automations:triggers".into()]
}

pub const STATE: EntityDef = EntityDef { kind: "automations_trigger_state", table: "automations_trigger_state", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

/// The source names the engine itself offers (listed in its manifest's `triggerSources` too).
const OWN: [&str; 4] = ["schedule", "once", "webhook", "manual"];

/// A trigger the engine runs: declared, or provided by a plugin.
#[derive(Debug, Clone)]
pub struct Live {
    pub name: String,
    pub spec: TriggerSpec,
    /// `trigger` or the providing plugin
    pub from: String,
    pub paused: bool,
    pub full_auto: bool,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").field("declared", &lock(&self.declared).len()).finish_non_exhaustive()
    }
}

pub struct Engine {
    store: std::sync::OnceLock<Store>,
    pub declared: Mutex<Vec<(String, TriggerSpec)>>,
    /// one decision at a time: a state row is read, decided on and written back whole
    gate: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[allow(clippy::needless_pass_by_value)] // for map_err
fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::internal(format!("store: {e}"))
}

/// The machine's zone, or a named one (`Europe/Zurich`).
#[derive(Debug)]
pub struct Tz(jiff::tz::TimeZone);
impl Zone for Tz {
    fn offset_ms(&self, utc_ms: i64) -> i64 {
        jiff::Timestamp::from_millisecond(utc_ms).map_or(0, |ts| i64::from(self.0.to_offset(ts).seconds()) * 1_000)
    }
}
pub fn zone(name: &str) -> Tz {
    Tz((!name.is_empty()).then(|| jiff::tz::TimeZone::get(name).ok()).flatten().unwrap_or_else(jiff::tz::TimeZone::system))
}

/// Whether trigger `on` takes event `ty` (`pr.*` takes `pr.opened`).
fn takes(on: &str, ty: &str) -> bool {
    core::glob(on, ty)
}

impl Engine {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { store: std::sync::OnceLock::new(), declared: Mutex::default(), gate: tokio::sync::Mutex::new(()) }
    }

    /// Set once, at start (the store is a service then).
    pub fn open(&self, store: Store) {
        let _ = self.store.set(store);
    }

    fn store(&self) -> Result<&Store> {
        self.store.get().ok_or_else(|| WireError::unavailable("the trigger engine hasn't started"))
    }

    /// Every trigger, declared first; a provided one that's switched off isn't listed.
    pub fn all(&self, ctx: &Ctx) -> Vec<Live> {
        let mut out: Vec<Live> = lock(&self.declared).iter().map(|(n, s)| Live { name: n.clone(), spec: s.clone(), from: "trigger".into(), paused: false, full_auto: s.mode == "auto" }).collect();
        for (owner, p) in ctx.contributions_by(&PROVIDERS) {
            for Provided { name, spec, paused, full_auto } in p.triggers() {
                if !out.iter().any(|l| l.name == name) {
                    out.push(Live { name, spec, from: owner.clone(), paused, full_auto });
                }
            }
        }
        out
    }

    pub async fn load(&self, name: &str) -> State {
        let id = name.to_owned();
        let Ok(store) = self.store() else { return State::default() };
        store.read_async(move |r| r.get(STATE.kind, id.as_str())).await.ok().flatten().and_then(|r| serde_json::from_value(r.get("body")?.clone()).ok()).unwrap_or_default()
    }

    pub async fn save(&self, name: &str, st: &State) -> Result<()> {
        let body = serde_json::to_value(st).map_err(|e| WireError::internal(e.to_string()))?;
        let id = name.to_owned();
        self.store()?
            .write(move |w| {
                let mut r = Row::new();
                r.insert("id".into(), json!(id));
                r.insert("body".into(), body);
                w.upsert(STATE.kind, r).map(|_| ())
            })
            .await
            .map_err(store_err)
    }

    pub async fn states(&self) -> Vec<(String, State)> {
        let Ok(store) = self.store() else { return Vec::new() };
        let rows = store.read_async(|r| r.query(STATE.kind, &Query::new())).await.unwrap_or_default();
        rows.into_iter().filter_map(|r| Some((r.get("id")?.as_str()?.to_owned(), serde_json::from_value(r.get("body")?.clone()).ok()?))).collect()
    }

    fn world(t: &Live, now: i64) -> World {
        let in_window = t.spec.when.as_ref().is_none_or(|w| {
            let z = zone(if w.tz.is_empty() { &t.spec.tz } else { &w.tz });
            core::in_window(w, now + z.offset_ms(now))
        });
        World { now, full_auto: t.full_auto, member_paused: t.paused, in_window }
    }

    /// An event for every trigger on it (or only `only`): each decides, and what's decided runs.
    pub async fn dispatch(&self, ctx: &Ctx, call: &Call, ev: &TriggerEvent, only: Option<&str>, now: i64) -> Vec<(String, FireOut)> {
        let mine: Vec<Live> = self.all(ctx).into_iter().filter(|t| only.is_none_or(|o| o == t.name) && takes(&t.spec.on, &ev.on)).collect();
        let mut out = Vec::new();
        for t in mine {
            let _one = self.gate.lock().await;
            let mut st = self.load(&t.name).await;
            let d = core::admit(&t.name, &t.spec, &mut st, ev.clone(), &Self::world(&t, now));
            if d == Decision::Nothing {
                continue;
            }
            let o = self.act(ctx, call, &t, &mut st, d, now).await;
            if let Err(e) = self.save(&t.name, &st).await {
                tracing::warn!(trigger = %t.name, "state not saved: {}", e.message);
            }
            out.push((t.name.clone(), o));
        }
        out
    }

    /// Runs a decision: starts, replaces, or says why not (`trigger.fired`).
    async fn act(&self, ctx: &Ctx, call: &Call, t: &Live, st: &mut State, d: Decision, now: i64) -> FireOut {
        let key = match &d {
            Decision::Start(j) | Decision::Awaiting(j) | Decision::Replace { job: j, .. } => j.events.first().map(|e| e.key.clone()).unwrap_or_default(),
            _ => st.deliveries.back().map(|l| l.key.clone()).unwrap_or_default(),
        };
        let (word, why) = core::word(&d);
        let mut out = FireOut { result: word.into(), why, session: None };
        let job = match d {
            Decision::Start(j) => Some(j),
            Decision::Replace { stop, job } => {
                for id in stop {
                    if let Err(e) = ctx.run_json(call, "runtime.stop", json!({ "id": id })).await {
                        tracing::warn!(trigger = %t.name, "couldn't stop {id}: {}", e.message);
                    }
                    st.running.retain(|r| *r != id);
                    st.log(now, "replaced", "a newer event replaced it", &key, Some(id));
                }
                Some(job)
            }
            _ => None,
        };
        if let Some(job) = job {
            let made = match self.store() {
                Ok(store) => start(ctx, call, store, t, &job).await,
                Err(e) => Err(e),
            };
            match made {
                Ok(sid) => {
                    core::started(st, &job, &sid, now);
                    out.session = Some(sid);
                }
                Err(e) => {
                    st.log(now, "failed", &format!("didn't start: {}", e.message), &key, None);
                    out = FireOut { result: "failed".into(), why: e.message, session: None };
                }
            }
        }
        ctx.emit(call, &TriggerFired { trigger: t.name.clone(), on: t.spec.on.clone(), key, result: out.result.clone(), why: out.why.clone(), session: out.session.clone() });
        out
    }

    /// A run a trigger started ended: its outcome counts (a quiet member's answer is a skip, not a failure).
    pub async fn ended(&self, ctx: &Ctx, session: &str, o: Outcome, from_crew: bool, now: i64) {
        let all = self.all(ctx);
        for (name, mut st) in self.states().await {
            if !st.running.iter().any(|s| s == session) {
                continue;
            }
            let Some(t) = all.iter().find(|t| t.name == name) else { continue };
            // a member's run ends with its report (which says whether it was quiet), not with its turn
            if matches!(t.spec.target(), Target::Crew(_)) != from_crew {
                continue;
            }
            let _one = self.gate.lock().await;
            if let Some(why) = core::ended(&t.spec, &mut st, session, o, now) {
                notify(ctx, &name, &why);
            }
            let call = ctx.root_call();
            for d in core::drain(&t.spec, &mut st, &Self::world(t, now)) {
                self.act(ctx, &call, t, &mut st, d, now).await;
            }
            let _ = self.save(&name, &st).await;
        }
    }

    /// The tick: availability, schedules, one-offs, closed debounce windows, the queues, the polls.
    pub async fn tick(&self, ctx: &Ctx, now: i64) {
        let call = ctx.root_call();
        let owners = owners_of(ctx);
        for t in self.all(ctx) {
            let _one = self.gate.lock().await;
            let mut st = self.load(&t.name).await;
            let before = st.clone();
            let list: Vec<(String, bool)> = owners.iter().filter(|(on, _, _)| takes(&t.spec.on, on) || takes(on, &t.spec.on)).map(|(_, p, up)| (p.clone(), *up)).collect();
            st.unavailable = core::availability(&t.spec.on, &list);
            let w = Self::world(&t, now);
            let mut decisions = Vec::new();
            if let Some(ev) = due_event(&t, &st, now) {
                if t.spec.on == "schedule" {
                    st.last_minute = ev.payload.get("minute").and_then(Value::as_i64);
                }
                decisions.push(core::admit(&t.name, &t.spec, &mut st, ev, &w));
            }
            decisions.extend(core::flush(&t.spec, &mut st, &w));
            if !st.queue.is_empty() {
                decisions.extend(core::drain(&t.spec, &mut st, &w));
            }
            for d in decisions.into_iter().filter(|d| *d != Decision::Nothing) {
                self.act(ctx, &call, &t, &mut st, d, now).await;
            }
            if st.unavailable.is_none() && st.next_poll_at.is_none_or(|at| at <= now) {
                self.poll(ctx, &call, &t, &mut st, now).await;
            }
            if st != before {
                let _ = self.save(&t.name, &st).await;
            }
        }
    }

    async fn poll(&self, ctx: &Ctx, call: &Call, t: &Live, st: &mut State, now: i64) {
        let Some(src) = ctx.contributions(&SOURCE).into_iter().find(|s| s.ons().iter().any(|o| o.mode == "poll" && o.on == t.spec.on)) else { return };
        let every = src.ons().iter().find(|o| o.on == t.spec.on).and_then(|o| o.every).unwrap_or(5);
        let every_ms = i64::from(t.spec.every.unwrap_or(every).max(1)) * 60_000;
        let spec = serde_json::to_value(&t.spec).unwrap_or_default();
        let (outcome, events) = match src.poll(&t.spec.on, &spec, st.cursor.clone()).await {
            Ok(Polled { events, cursor, retry_at: None }) => {
                st.cursor = cursor;
                (PollOutcome::Ok, events)
            }
            Ok(Polled { retry_at: Some(reset_at), .. }) => (PollOutcome::RateLimited { reset_at }, Vec::new()),
            Err(e) => {
                tracing::warn!(trigger = %t.name, "poll failed: {}", e.message);
                (PollOutcome::Failed, Vec::new())
            }
        };
        let (next, f) = core::next_poll(every_ms, now, st.poll_failures, outcome);
        st.next_poll_at = Some(next);
        st.poll_failures = f;
        let w = Self::world(t, now);
        for ev in events {
            let d = core::admit(&t.name, &t.spec, st, ev, &w);
            if d != Decision::Nothing {
                self.act(ctx, call, t, st, d, now).await;
            }
        }
    }

    /// `automations.trigger.ls`
    pub async fn rows(&self, ctx: &Ctx) -> Vec<TriggerRow> {
        let mut out = Vec::new();
        for t in self.all(ctx) {
            let st = self.load(&t.name).await;
            let (state, why) = if !t.spec.on() {
                ("off", String::new())
            } else if let Some(w) = &st.unavailable {
                ("unavailable", w.clone())
            } else if let Some(w) = &st.paused {
                ("paused", w.clone())
            } else {
                ("on", String::new())
            };
            out.push(TriggerRow { name: t.name.clone(), spec: serde_json::to_value(&t.spec).unwrap_or_default(), from: t.from.clone(), state: state.into(), why, last_run_at: st.last_run_at, runs: st.runs_total, queued: u32::try_from(st.queue.len()).unwrap_or(u32::MAX), awaiting: u32::try_from(st.awaiting.len()).unwrap_or(u32::MAX) });
        }
        out
    }

    pub fn find(&self, ctx: &Ctx, name: &str) -> Result<Live> {
        self.all(ctx).into_iter().find(|t| t.name == name).ok_or_else(|| WireError::not_found(format!("no trigger named {name} (wisp trigger ls lists them)")))
    }

    /// `wisp trigger fire`: an event by hand. Its filters, `if` and hours don't apply (you asked for it); its
    /// rate, concurrency, budget and approval do.
    pub async fn fire(&self, ctx: &Ctx, call: &Call, name: &str, payload: Option<Value>, summary: Option<String>, now: i64) -> Result<FireOut> {
        let mut t = self.find(ctx, name)?;
        t.spec.filters.clear();
        t.spec.project.clear();
        t.spec.branch.clear();
        t.spec.label.clear();
        t.spec.users = vec!["anyone".into()];
        t.spec.cond.clear();
        t.spec.when = None;
        t.spec.debounce.clear();
        let ev = TriggerEvent { on: t.spec.on.clone(), key: format!("manual:{now}"), at: now, payload: payload.unwrap_or_else(|| json!({})), summary: summary.unwrap_or_else(|| format!("{name}, fired by hand")), ..TriggerEvent::default() };
        let _one = self.gate.lock().await;
        let mut st = self.load(name).await;
        let d = core::admit(name, &t.spec, &mut st, ev, &Self::world(&t, now));
        let out = self.act(ctx, call, &t, &mut st, d, now).await;
        self.save(name, &st).await?;
        Ok(out)
    }

    /// `automations.trigger.approve`: a yes starts the waiting job, a no drops it (said in the log).
    pub async fn approve(&self, ctx: &Ctx, call: &Call, name: &str, job: &str, yes: bool, now: i64) -> Result<FireOut> {
        let t = self.find(ctx, name)?;
        let _one = self.gate.lock().await;
        let mut st = self.load(name).await;
        let Some(i) = st.awaiting.iter().position(|j| j.id == job) else {
            return Err(WireError::not_found(format!("{name} has no job {job} waiting for a yes")));
        };
        let j = st.awaiting.remove(i);
        let key = j.events.first().map(|e| e.key.clone()).unwrap_or_default();
        let out = if yes {
            st.runs.push_back(now);
            st.last_run_at = Some(now);
            st.runs_total += 1;
            self.act(ctx, call, &t, &mut st, Decision::Start(j), now).await
        } else {
            st.log(now, "declined", "you said no", &key, None);
            FireOut { result: "declined".into(), why: "you said no".into(), session: None }
        };
        self.save(name, &st).await?;
        Ok(out)
    }

    /// `automations.trigger.resume`: a paused trigger runs again, and its held jobs go.
    pub async fn resume(&self, ctx: &Ctx, name: &str, now: i64) -> Result<()> {
        let t = self.find(ctx, name)?;
        let _one = self.gate.lock().await;
        let mut st = self.load(name).await;
        st.paused = None;
        st.failures = 0;
        st.cooldown_until = None;
        let call = ctx.root_call();
        for d in core::drain(&t.spec, &mut st, &Self::world(&t, now)) {
            self.act(ctx, &call, &t, &mut st, d, now).await;
        }
        self.save(name, &st).await
    }

    /// `wisp trigger test`: the dry run, over the given event or its `on`'s last N durable events.
    pub async fn test(&self, ctx: &Ctx, call: &Call, name: &str, event: Option<TriggerEvent>, last: u32, now: i64) -> Result<Vec<Tried>> {
        let t = self.find(ctx, name)?;
        let events = if let Some(e) = event {
            vec![e]
        } else {
            let rows = ctx.run_json(call, "events.tail", json!({ "type": t.spec.on, "limit": last.clamp(1, 50) })).await.unwrap_or_default();
            rows.as_array().into_iter().flatten().filter_map(from_row).collect()
        };
        let st = self.load(name).await;
        Ok(core::dry_run(name, &t.spec, &st, events, &Self::world(&t, now))
            .into_iter()
            .map(|x| {
                let (w, why) = core::word(&x.decision);
                let result = match w {
                    "started" => "would start",
                    "queued" => "would queue",
                    "held" => "would hold",
                    "skipped" => "would skip",
                    "batched" => "would batch",
                    "awaiting" => "would wait for a yes",
                    _ => "not for it",
                };
                Tried { key: x.event.key, summary: x.event.summary, result: result.into(), why, prompt: x.prompt }
            })
            .collect())
    }

    pub async fn log(&self, name: &str) -> Vec<LogLine> {
        self.load(name).await.deliveries.into_iter().rev().map(|d| LogLine { at: d.at, result: d.result, why: d.why, key: d.key, session: d.session }).collect()
    }
}

/// Every `on` some plugin offers, its plugin, and whether that's on: durable event types and `triggerSources`
/// in the manifests (so a source whose plugin is off is still known by name).
pub fn owners_of(ctx: &Ctx) -> Vec<(String, String, bool)> {
    let up: Vec<String> = ctx.plugin_status().into_iter().filter(|s| s.state == "active" || s.state == "resolved").map(|s| s.id).collect();
    let mut out = Vec::new();
    for m in ctx.manifests() {
        let on = up.contains(&m.id);
        for e in m.contributes.get("events").and_then(Value::as_array).into_iter().flatten() {
            if e.get("durable").and_then(Value::as_bool) == Some(true)
                && let Some(t) = e.get("type").and_then(Value::as_str)
            {
                out.push((t.to_owned(), m.id.clone(), on));
            }
        }
        for t in m.contributes.get("triggerSources").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            out.push((t.to_owned(), m.id.clone(), on));
        }
    }
    if !out.iter().any(|(t, _, _)| t == "schedule") {
        out.extend(OWN.iter().map(|t| ((*t).to_owned(), wisp_automations_api::PLUGIN_ID.to_owned(), true)));
    }
    out
}

/// `automations.sources`: what each source offers, and whether its plugin is on.
pub fn sources(ctx: &Ctx) -> Vec<SourceRow> {
    let mut out: Vec<SourceRow> = ctx.contributions_by(&SOURCE).into_iter().flat_map(|(c, s)| s.ons().into_iter().map(move |on| SourceRow { plugin: c.clone(), available: true, on })).collect();
    for (on, plugin, up) in owners_of(ctx) {
        if !out.iter().any(|r| r.on.on == on) {
            out.push(SourceRow { plugin, available: up, on: wisp_automations_api::SourceOn { title: on.clone(), on, fields: json!({}), mode: "event".into(), every: None } });
        }
    }
    out.sort_by(|a, b| a.on.on.cmp(&b.on.on));
    out
}

/// The schedule's or the one-off's event, when it's due.
fn due_event(t: &Live, st: &State, now: i64) -> Option<TriggerEvent> {
    match t.spec.on.as_str() {
        "schedule" => {
            let c = parse_cron(&t.spec.cron).ok()?;
            let z = zone(&t.spec.tz);
            let d = wisp_automations_core::schedule::due(&c, &z, st.last_minute, now)?;
            let summary = if d.late { format!("{} (missed while this computer was off: run once now)", t.spec.cron) } else { t.spec.cron.clone() };
            Some(TriggerEvent { on: "schedule".into(), key: format!("schedule:{}", d.minute), at: now, payload: json!({ "minute": d.minute, "late": d.late }), summary, ..TriggerEvent::default() })
        }
        "once" => t.spec.at.filter(|at| *at <= now).map(|at| TriggerEvent { on: "once".into(), key: format!("once:{at}"), at: now, payload: json!({ "at": at }), summary: "its time came".into(), ..TriggerEvent::default() }),
        _ => None,
    }
}

/// A durable event as a trigger sees it.
pub fn from_envelope(env: &EventEnvelope, by: Option<String>, depth: u32) -> TriggerEvent {
    let data = env.data();
    TriggerEvent { on: env.ty.clone(), key: env.key.clone().unwrap_or_else(|| format!("{}#{}", env.ty, env.durable_seq.unwrap_or(env.seq))), at: env.at, summary: summary_of(&env.ty, &data), subject: env.subject.clone(), by, depth: env.depth.max(depth), payload: data }
}

/// A row of `events.tail` as a trigger event (the dry run reads the log).
pub fn from_row(v: &Value) -> Option<TriggerEvent> {
    let ty = v.get("type").or_else(|| v.get("ty")).and_then(Value::as_str)?.to_owned();
    let data = v.get("data").cloned().unwrap_or_default();
    let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(0);
    Some(TriggerEvent { key: v.get("key").and_then(Value::as_str).map_or_else(|| format!("{ty}#{seq}"), str::to_owned), at: v.get("at").and_then(Value::as_i64).unwrap_or(0), summary: summary_of(&ty, &data), subject: v.get("subject").and_then(Value::as_str).map(str::to_owned), on: ty, payload: data, ..TriggerEvent::default() })
}

fn summary_of(ty: &str, data: &Value) -> String {
    let s = |k: &str| data.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty());
    let what = s("summary").or_else(|| s("title")).or_else(|| s("text")).or_else(|| s("goal")).or_else(|| s("member")).unwrap_or("");
    let one: String = what.lines().next().unwrap_or("").chars().take(160).collect();
    if one.is_empty() { ty.to_owned() } else { format!("{ty}: {one}") }
}

/// Starts a job's target → the task (or run) it made.
async fn start(ctx: &Ctx, call: &Call, store: &Store, t: &Live, job: &Job) -> Result<String> {
    let by = format!("trigger:{}", t.name);
    let first = job.events.first().cloned().unwrap_or_default();
    let cwd = if t.spec.project.is_empty() { first.payload.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned() } else { t.spec.project.clone() };
    let text = |fallback: &str| {
        let p = if t.spec.prompt.trim().is_empty() { fallback.to_owned() } else { t.spec.prompt.clone() };
        core::fill(&p, job)
    };
    let id_of = |v: &Value| v.get("id").and_then(Value::as_str).or_else(|| v.pointer("/session/id").and_then(Value::as_str)).map(str::to_owned);
    let made = match t.spec.target() {
        Target::Task(task) => crate::run_by(ctx, call, store, task, &cwd, &by).await?,
        Target::Prompt(_) => {
            let mut a = json!({ "prompt": text("{event.summary}"), "title": t.name, "lineage": { "triggeredBy": by }, "ext": { "wisp.automations": { "trigger": t.name, "event": first.key } } });
            for (k, v) in [("cwd", &cwd), ("agent", &t.spec.agent), ("model", &t.spec.model), ("mode", &t.spec.mode)] {
                if !v.is_empty() {
                    a[k] = json!(v);
                }
            }
            ctx.run_json(call, "runtime.create", a).await?
        }
        Target::Crew(member) => ctx.run_json(call, "crew.wake", json!({ "id": member, "why": text("{event.summary}"), "source": by })).await?,
        Target::Workflow(w) => ctx.run_json(call, "workflows.run", json!({ "name": w, "inputs": { "event": core::event_scope(&first)["event"] }, "project": (!cwd.is_empty()).then_some(&cwd) })).await?,
        Target::FollowUp => {
            let Some(id) = first.subject.clone() else {
                return Err(WireError::invalid(format!("{} follows up the event's task, and {} names none", t.name, first.on)));
            };
            ctx.run_json(call, "runtime.followUp", json!({ "id": id, "text": text("{event.summary}"), "queue": true })).await?;
            json!({ "id": id })
        }
    };
    id_of(&made).ok_or_else(|| WireError::internal(format!("{} started, but its answer names no task: {made}", t.name)))
}

/// Three failures in a row paused it: say so where you'll see it.
fn notify(ctx: &Ctx, name: &str, why: &str) {
    tracing::warn!(trigger = %name, "paused: {why}");
    if let Ok(n) = wisp_kernel::services::notify(ctx) {
        n.notice("toast", json!({ "kind": "trigger.paused", "trigger": name, "title": format!("Trigger {name} paused"), "body": format!("{why}. wisp trigger log {name} says what happened; wisp trigger resume {name} runs it again.") }), None);
    }
}

/// The run's outcome from a `task.finished` / `task.failed` payload.
pub fn outcome_of(ty: &str, data: &Value) -> Outcome {
    Outcome { failed: ty == "task.failed" || data.get("status").and_then(Value::as_str) == Some("error"), quiet: data.get("quiet").and_then(Value::as_bool).unwrap_or(false), cost: data.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0) }
}

pub type Shared = Arc<Engine>;
