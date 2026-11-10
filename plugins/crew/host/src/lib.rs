//! wisp.crew host (v1 server/crew.js, routes/crew.js): the members, their jobs as ordinary runtime
//! tasks (`runtime.create` with `ext["wisp.crew"]`), check-ins on their schedule (the 20 s tick), and
//! the crew note every job's system prompt carries (`runtime.prompt@1`). The rules are wisp-crew-core's.
//!
//! The crew lives in crew-owned store tables (`store.rs`): every change is one transaction of the rows it
//! touched. v1's config.json crew is imported once at start.

mod jobs;
mod kind;
mod store;
mod transfer;
mod wakes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use wisp_crew_api::commands::{self as c, Layout};
use wisp_crew_api::{CrewExt, Member, MemberView};
use wisp_crew_core::cron::{CronOnly, Utc};
use wisp_crew_core::kit::Ids;
use wisp_crew_core::member::{Checks, normalize_member};
use wisp_crew_core::mentions::handle_of;
use wisp_crew_core::schedule::next_checkin;
use wisp_kernel::services::Paths;
use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};
use wisp_runtime_api::model::Session;
use wisp_runtime_api::points::{OUTCOME, Outcome, PROMPT, PromptPart, TurnOutcome};

#[derive(Debug, Default)]
pub struct CrewPlugin;

/// The crew as the commands read it (the tables' rows, cached).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    #[serde(default)]
    pub crew: Vec<Member>,
    #[serde(default)]
    pub crew_layout: Layout,
}

pub(crate) struct State {
    pub saved: Mutex<Saved>,
    /// member id → the tasks its jobs run as (newest last)
    pub jobs: Mutex<std::collections::HashMap<String, Vec<String>>>,
    store: std::sync::OnceLock<wisp_store::Store>,
    /// members changed (or gone) since the last save
    dirty: Mutex<std::collections::BTreeSet<String>>,
    layout_dirty: std::sync::atomic::AtomicBool,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn wire(e: wisp_crew_core::Error) -> WireError {
    use wisp_crew_core::Error as E;
    match e {
        E::Invalid(m) => WireError::invalid(m),
        E::NotFound(m) => WireError::not_found(m),
        E::Conflict(m) => WireError::conflict(m),
        E::TooMany(m) => WireError::conflict(m).with_details(serde_json::json!({ "status": wisp_crew_api::STATUS_TOO_MANY })),
    }
}

pub(crate) struct NewIds;
impl Ids for NewIds {
    fn next_id(&mut self) -> String {
        wisp_kernel::ids::uuid7().replace('-', "").chars().rev().take(16).collect()
    }
}

impl State {
    fn new() -> Self {
        Self { saved: Mutex::default(), jobs: Mutex::default(), store: std::sync::OnceLock::new(), dirty: Mutex::default(), layout_dirty: false.into() }
    }

    /// The tables, then v1's crew once, then the cache. At start, before any command.
    async fn open(&self, store: wisp_store::Store, home: Option<PathBuf>) -> std::result::Result<(), WireError> {
        store::install(&store).map_err(WireError::from)?;
        if let Some(h) = home {
            store::import_v1(&store, &h).await.map_err(WireError::from)?;
        }
        let (crew, layout, jobs) = store::load(&store).await.map_err(WireError::from)?;
        *lock(&self.saved) = Saved { crew, crew_layout: layout };
        let mut j = lock(&self.jobs);
        for (m, s) in jobs {
            j.entry(m).or_default().push(s);
        }
        drop(j);
        let _ = self.store.set(store);
        Ok(())
    }

    /// Writes what changed since the last save in one transaction: the members touched (or deleted),
    /// and the layout when it moved.
    pub async fn save(&self) {
        let Some(store) = self.store.get().cloned() else { return };
        let ids: Vec<String> = std::mem::take(&mut *lock(&self.dirty)).into_iter().collect();
        let layout = self.layout_dirty.swap(false, std::sync::atomic::Ordering::Relaxed).then(|| lock(&self.saved).crew_layout.clone());
        let rows: Vec<(String, Option<Member>)> = {
            let s = lock(&self.saved);
            ids.into_iter().map(|id| { let m = s.crew.iter().find(|m| m.id == id).cloned(); (id, m) }).collect()
        };
        if rows.is_empty() && layout.is_none() {
            return;
        }
        let r = store
            .write(move |w| {
                for (id, m) in &rows {
                    if let Some(m) = m { store::put_member(w, m)? } else {
                        w.del(store::MEMBER.kind, id.as_str())?;
                        w.del(store::LAYOUT.kind, id.as_str())?;
                    }
                }
                if let Some(l) = &layout {
                    let had = w.query(store::LAYOUT.kind, &wisp_store::Query::new())?;
                    for row in had {
                        if let Some(id) = row.get("id").and_then(serde_json::Value::as_str).filter(|id| !l.contains_key(*id)) {
                            w.del(store::LAYOUT.kind, id)?;
                        }
                    }
                    for (id, p) in l {
                        store::put_point(w, id, *p)?;
                    }
                }
                Ok(())
            })
            .await;
        if let Err(e) = r {
            tracing::warn!(error = %e, "crew: saving");
        }
    }

    /// A member left: its row and its place go at the next save.
    pub fn remove(&self, id: &str) {
        {
            let mut s = lock(&self.saved);
            s.crew.retain(|x| x.id != id);
            s.crew_layout.remove(id);
        }
        lock(&self.dirty).insert(id.to_owned());
    }

    pub fn set_layout(&self, l: Layout) {
        lock(&self.saved).crew_layout = l;
        self.layout_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// A job started as task `session`.
    pub async fn add_job(&self, member: &str, session: &str, at: i64) {
        lock(&self.jobs).entry(member.to_owned()).or_default().push(session.to_owned());
        let Some(store) = self.store.get().cloned() else { return };
        let mut r = wisp_store::Row::new();
        r.insert("session_id".into(), serde_json::json!(session));
        r.insert("crew_id".into(), serde_json::json!(member));
        r.insert("at".into(), serde_json::json!(at));
        if let Err(e) = store.write(move |w| w.upsert(store::JOB.kind, r).map(|_| ())).await {
            tracing::warn!(error = %e, "crew: a job");
        }
    }

    pub fn member(&self, key: &str) -> std::result::Result<Member, WireError> {
        let s = lock(&self.saved);
        let k = key.trim_start_matches('@');
        s.crew.iter().find(|m| m.id == key || m.name.eq_ignore_ascii_case(k) || handle_of(&m.name) == handle_of(k)).cloned().ok_or_else(|| WireError::not_found("No such crew member."))
    }

    pub fn put(&self, m: Member) {
        lock(&self.dirty).insert(m.id.clone());
        let mut s = lock(&self.saved);
        match s.crew.iter_mut().find(|x| x.id == m.id) {
            Some(x) => *x = m,
            None => s.crew.push(m),
        }
    }

    pub fn view(&self, m: &Member, running: u32, now: i64) -> MemberView {
        let jobs = u32::try_from(lock(&self.jobs).get(&m.id).map_or(0, Vec::len)).unwrap_or(u32::MAX);
        MemberView { member: m.clone(), running, jobs, next_at: next_checkin(m, now, &Utc), handle: handle_of(&m.name), on: m.wakes.iter().map(|w| w.on.clone()).collect() }
    }

    /// A new or edited member, checked against the rest of the crew.
    pub fn normalize(&self, body: &c::MemberBody, prev: Option<&Member>, now: i64, profiles: &[String]) -> std::result::Result<Member, WireError> {
        let taken = lock(&self.saved).crew.clone();
        if prev.is_none() && taken.len() >= wisp_crew_api::MAX_CREW {
            return Err(WireError::conflict(format!("A crew has at most {} members.", wisp_crew_api::MAX_CREW)));
        }
        let exists = |p: &str| std::path::Path::new(p).is_dir();
        let machine_ok = |_: &str| false;
        let agent_ok = |a: &str| profiles.iter().any(|p| p == a);
        let checks = Checks { taken: &taken, exists: &exists, machine_ok: &machine_ok, words: &CronOnly, agent_ok: &agent_ok };
        normalize_member(body, prev, &checks, &mut NewIds, now).map_err(wire)
    }
}

/// Every job's system prompt carries the member's identity, brief, notebook and log (v1 `crewNote`).
struct Note(Arc<State>);

impl PromptPart for Note {
    fn id(&self) -> &'static str {
        "wisp.crew"
    }
    fn part(&self, s: &Session) -> String {
        let Some(job) = s.ext.get(wisp_crew_api::PLUGIN_ID).and_then(|v| serde_json::from_value::<CrewExt>(v.clone()).ok()) else { return String::new() };
        let Ok(m) = self.0.member(&job.id) else { return String::new() };
        wisp_crew_core::note::crew_note(&m, &job, None, &Utc)
    }
}

/// How a member's job lands (v1 runner.js `#finishTurn` with `crewOut`): quiet (archived), For later, or
/// filed under Done, from its crew block. A quiet job that scheduled a follow-up is filed, not archived (#760).
struct Filed;

impl TurnOutcome for Filed {
    fn id(&self) -> &'static str {
        "wisp.crew"
    }
    fn outcome(&self, s: &Session, turn: &wisp_runtime_api::model::Turn) -> Option<Outcome> {
        let job = s.ext.get(wisp_crew_api::PLUGIN_ID).and_then(|v| serde_json::from_value::<CrewExt>(v.clone()).ok())?;
        let mut p = turn.presentation.as_ref().and_then(|p| serde_json::to_value(p).ok()).unwrap_or_default();
        let data = wisp_crew_core::memory::take_crew_block(&mut p);
        let f = wisp_crew_core::filing::file_turn(job.job, turn.idx as usize + 1, data.as_ref()).keeping(scheduled(s));
        Some(Outcome { quiet: f.quiet, filed: f.filed, later: f.later })
    }
}

/// The task has follow-ups or a reminder still to come (wisp.later's mirror on the task).
fn scheduled(s: &Session) -> bool {
    // read by key, not by the full row: a mirror written by a newer wisp.later still counts
    let Some(l) = s.ext.get(wisp_later_api::PLUGIN_ID) else { return false };
    l.get("later").and_then(serde_json::Value::as_array).is_some_and(|a| !a.is_empty()) || l.get("reminder").is_some_and(|r| !r.is_null())
}

/// A member's job ended: `crew.reported` (ADR-0043), from the runtime's durable task facts, so a hand-off
/// survives a restart. `quiet`: the job's crew block said there was nothing to do.
fn reported(s: &mut Setup, st: &Arc<State>) {
    for (name, failed) in [("reported", false), ("reported_failed", true)] {
        let st = st.clone();
        let on = move |ctx: wisp_kernel::Ctx, call: wisp_kernel::Call, f: wisp_runtime_api::events::TaskFact| {
            let st = st.clone();
            async move {
                let Some(id) = f.crew.clone() else { return Ok(()) };
                let Ok(m) = st.member(&id) else { return Ok(()) };
                let turns = ctx.run_json(&call, "runtime.turns", serde_json::json!({ "id": f.session_id })).await.unwrap_or_default();
                let mut p = turns.as_array().and_then(|t| t.last()).and_then(|t| t.get("presentation").cloned()).unwrap_or_default();
                let quiet = wisp_crew_core::memory::take_crew_block(&mut p).is_some_and(|d| d.quiet);
                ctx.emit(&call, &wisp_crew_api::events::Reported { crew_id: m.id, member: m.name, session_id: f.session_id.0.clone(), status: if failed { "error".into() } else { "done".into() }, quiet, text: f.text.chars().take(500).collect() });
                Ok(())
            }
        };
        if failed {
            s.on_durable::<wisp_runtime_api::events::TaskFailed, _, _>(name, move |ctx, call, d| {
                let on = on.clone();
                async move { if let wisp_kernel::durable::Durable::Event { event, .. } = d { on(ctx, call, event.0).await } else { Ok(()) } }
            });
        } else {
            s.on_durable::<wisp_runtime_api::events::TaskFinished, _, _>(name, move |ctx, call, d| {
                let on = on.clone();
                async move { if let wisp_kernel::durable::Durable::Event { event, .. } = d { on(ctx, call, event.0).await } else { Ok(()) } }
            });
        }
    }
}

impl Plugin for CrewPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let k: Arc<dyn wisp_resources_api::ResourceKind> = Arc::new(kind::CrewKind::new(s.ctx()));
        s.contribute(&wisp_resources_api::RESOURCE_KIND, k);
        let st = Arc::new(State::new());
        let note: Arc<dyn PromptPart> = Arc::new(Note(st.clone()));
        s.contribute(&PROMPT, note);
        let filed: Arc<dyn TurnOutcome> = Arc::new(Filed);
        s.contribute(&OUTCOME, filed);
        jobs::register(s, &st);
        reported(s, &st);
        wakes::register(s, &st);
        transfer::register(s, &st);
        let tick = st.clone();
        s.on_start(move |ctx| async move {
            let store = ctx.service::<wisp_store::Store>()?.as_ref().clone();
            let home = ctx.service::<Paths>().ok().map(|p| p.home().to_owned());
            tick.open(store, home).await?;
            jobs::start_ticks(&ctx, tick);
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(CrewPlugin.manifest().id, "wisp.crew");
    }

    #[test]
    fn a_quiet_check_in_keeps_its_scheduled_follow_up() {
        let job = CrewExt { id: "m1".into(), job: wisp_crew_api::JobKind::Checkin, ..CrewExt::default() };
        let mut s = Session::default();
        s.ext.insert(wisp_crew_api::PLUGIN_ID.into(), serde_json::to_value(&job).unwrap());
        let crew = serde_json::json!({ "type": "crew", "quiet": true });
        let turn = wisp_runtime_api::model::Turn { presentation: Some(serde_json::from_value(serde_json::json!({ "v": 1, "blocks": [crew] })).unwrap()), ..wisp_runtime_api::model::Turn::default() };
        assert_eq!(Filed.outcome(&s, &turn), Some(Outcome { quiet: true, filed: false, later: false }), "nothing scheduled: archived");
        s.ext.insert(wisp_later_api::PLUGIN_ID.into(), serde_json::json!({ "later": [{ "id": "l1", "at": 5, "text": "check again" }] }));
        assert_eq!(Filed.outcome(&s, &turn), Some(Outcome { quiet: false, filed: true, later: false }), "a follow-up is due: filed under Done so it fires");
        assert_eq!(Filed.outcome(&Session::default(), &turn), None, "not a crew job");
    }

    #[test]
    fn a_member_is_made_from_v1s_body_and_found_by_handle() {
        let st = State::new();
        let body = c::MemberBody { name: Some("Ada Lovelace".into()), role: Some("CI watcher".into()), cron: Some("*/30 * * * *".into()), ..c::MemberBody::default() };
        let m = st.normalize(&body, None, 1_000, &[]).unwrap();
        assert_eq!((m.name.as_str(), m.cron.as_str(), m.agent.as_str()), ("Ada Lovelace", "*/30 * * * *", "auto"));
        st.put(m.clone());
        assert_eq!(st.member("@ada-lovelace").unwrap().id, m.id);
        let dup = st.normalize(&c::MemberBody { name: Some("ada lovelace".into()), ..c::MemberBody::default() }, None, 2_000, &[]);
        assert!(dup.is_err(), "the same name twice");
    }
}
