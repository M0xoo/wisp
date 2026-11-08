//! wisp.crew host (v1 server/crew.js, routes/crew.js): the members, their jobs as ordinary runtime
//! tasks (`runtime.create` with `ext["wisp.crew"]`), check-ins on their schedule (the 20 s tick), and
//! the crew note every job's system prompt carries (`runtime.prompt@1`). The rules are wisp-crew-core's.
//!
//! The crew is kept as v1 kept it in config.json (`crew`, `crewLayout`), in `<home>/crew.json`, written
//! atomically; its rows move into crew-owned store tables with the plugin's migrations.

mod jobs;

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
use wisp_runtime_api::points::{PROMPT, PromptPart};

#[derive(Debug, Default)]
pub struct CrewPlugin;

/// `crew.json`: v1's `crew` and `crewLayout`.
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
    file: Option<PathBuf>,
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

struct NewIds;
impl Ids for NewIds {
    fn next_id(&mut self) -> String {
        wisp_kernel::ids::uuid7().replace('-', "").chars().rev().take(16).collect()
    }
}

impl State {
    fn load(file: Option<PathBuf>) -> Self {
        let saved = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { saved: Mutex::new(saved), jobs: Mutex::default(), file }
    }

    pub async fn save(&self) {
        let Some(file) = self.file.clone() else { return };
        let Ok(bytes) = serde_json::to_vec_pretty(&*lock(&self.saved)) else { return };
        let tmp = file.with_extension("json.tmp");
        if tokio::fs::write(&tmp, bytes).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &file).await;
        }
    }

    pub fn member(&self, key: &str) -> std::result::Result<Member, WireError> {
        let s = lock(&self.saved);
        let k = key.trim_start_matches('@');
        s.crew.iter().find(|m| m.id == key || m.name.eq_ignore_ascii_case(k) || handle_of(&m.name) == handle_of(k)).cloned().ok_or_else(|| WireError::not_found("No such crew member."))
    }

    pub fn put(&self, m: Member) {
        let mut s = lock(&self.saved);
        match s.crew.iter_mut().find(|x| x.id == m.id) {
            Some(x) => *x = m,
            None => s.crew.push(m),
        }
    }

    pub fn view(&self, m: &Member, running: u32, now: i64) -> MemberView {
        let jobs = u32::try_from(lock(&self.jobs).get(&m.id).map_or(0, Vec::len)).unwrap_or(u32::MAX);
        MemberView { member: m.clone(), running, jobs, next_at: next_checkin(m, now, &Utc), handle: handle_of(&m.name), on: Vec::new() }
    }

    /// A new or edited member, checked against the rest of the crew.
    pub fn normalize(&self, body: &c::MemberBody, prev: Option<&Member>, now: i64) -> std::result::Result<Member, WireError> {
        let taken = lock(&self.saved).crew.clone();
        if prev.is_none() && taken.len() >= wisp_crew_api::MAX_CREW {
            return Err(WireError::conflict(format!("A crew has at most {} members.", wisp_crew_api::MAX_CREW)));
        }
        let exists = |p: &str| std::path::Path::new(p).is_dir();
        let machine_ok = |_: &str| false;
        let checks = Checks { taken: &taken, exists: &exists, machine_ok: &machine_ok, words: &CronOnly };
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

impl Plugin for CrewPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let file = s.ctx().service::<Paths>().ok().map(|p| p.home().join("crew.json"));
        let st = Arc::new(State::load(file));
        let note: Arc<dyn PromptPart> = Arc::new(Note(st.clone()));
        s.contribute(&PROMPT, note);
        jobs::register(s, &st);
        let tick = st.clone();
        s.on_start(move |ctx| async move {
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
    fn a_member_is_made_from_v1s_body_and_found_by_handle() {
        let st = State::load(None);
        let body = c::MemberBody { name: Some("Ada Lovelace".into()), role: Some("CI watcher".into()), cron: Some("*/30 * * * *".into()), ..c::MemberBody::default() };
        let m = st.normalize(&body, None, 1_000).unwrap();
        assert_eq!((m.name.as_str(), m.cron.as_str(), m.agent.as_str()), ("Ada Lovelace", "*/30 * * * *", "auto"));
        st.put(m.clone());
        assert_eq!(st.member("@ada-lovelace").unwrap().id, m.id);
        let dup = st.normalize(&c::MemberBody { name: Some("ada lovelace".into()), ..c::MemberBody::default() }, None, 2_000);
        assert!(dup.is_err(), "the same name twice");
    }
}
