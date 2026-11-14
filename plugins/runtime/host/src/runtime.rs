//! The runtime service: every command's behaviour, over the store, the proc service and the host seam.
//! A task's commands run one at a time (a per-task lock), each in one store transaction; events go out
//! after it commits. The list is served from memory: one cached row per task, rebuilt when the task's row
//! is written, never per read (plan §4.1: only open or running sessions are kept whole in memory).
//!
//! size-ok: the runtime service's per-task lock and transaction wrap every command here

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::{Clock, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::commands::{Created, FollowUpArgs, FollowedUp, StartArgs};
use wisp_runtime_api::events::{SessionChanged, SessionCreated};
use wisp_runtime_api::model::{Mode, QueueItem, Session, SessionState, Summary, Turn, TurnStatus};
use wisp_runtime_api::{Harness, SessionId};
use wisp_runtime_core::queue::{self, Incoming, Plan, Queue, Run};
use wisp_runtime_core::summary::{RowFacts, summarize};
use wisp_runtime_core::{cap, land, prompt};

use crate::error::{Result, RuntimeError};
use crate::host::{Emitted, Host};
use crate::repo::{self, Repo};
use crate::run::Live;

pub struct Runtime {
    pub repo: Repo,
    pub host: Arc<dyn Host>,
    pub proc: Proc,
    pub clock: Arc<dyn Clock>,
    pub(crate) list: Mutex<BTreeMap<String, Arc<Summary>>>,
    pub(crate) live: Mutex<HashMap<String, Live>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// open questions: ask id → its task (rebuilt at start from the tasks that wait on one)
    asks: Mutex<HashMap<String, String>>,
    /// answers not read yet by `pollAnswer`: ask id → the answer
    answers: Mutex<HashMap<String, String>>,
    /// each task's next activity seq: a turn's drive and wisp's own rows share it
    seqs: Mutex<HashMap<String, u64>>,
    sign_ins: Mutex<HashMap<String, crate::more::SignIn>>,
    /// each task's turns' usage, folded once per turn (`usage_row.rs`)
    pub(crate) usage: crate::usage_row::UsageCache,
    /// each task's .env values its turns read, in memory only (`env_known.rs`, ADR-0050)
    pub(crate) env: crate::env_known::EnvKnown,
    /// the capped tasks' caps, kept as each task's row is written: the edge reads them without waiting, to give a
    /// capped task's agent `agent:capped` (`Runtime::agent_set`)
    pub(crate) caps: Mutex<HashMap<String, Mode>>,
    /// the `runtime.quick` runs under way that a caller named (`runId`), for `runtime.quickCancel` (`more/quick.rs`)
    pub(crate) quick_runs: crate::more::QuickRuns,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime").field("tasks", &self.lock_list().len()).finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Runtime {
    pub fn new(repo: Repo, host: Arc<dyn Host>, proc: Proc, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            repo,
            host,
            proc,
            clock,
            list: Mutex::default(),
            live: Mutex::default(),
            locks: Mutex::default(),
            asks: Mutex::default(),
            answers: Mutex::default(),
            seqs: Mutex::default(),
            sign_ins: Mutex::default(),
            usage: crate::usage_row::UsageCache::default(),
            env: crate::env_known::EnvKnown::default(),
            caps: Mutex::default(),
            quick_runs: crate::more::QuickRuns::default(),
        })
    }

    /// Fills the list cache from the store and marks turns a crash left running as stopped.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let rows = self.repo.summaries().await?;
        {
            let mut list = self.lock_list();
            for s in rows {
                list.insert(s.id.0.clone(), Arc::new(s));
            }
        }
        // every capped task's cap, from its list row: its agent speaks as agent:capped before the row is written again
        self.load_caps();
        // questions open when wisp stopped stay answerable: the ask is on the task (v1 `session.ask`)
        let waiting: Vec<String> = self.lock_list().values().filter(|s| s.state == SessionState::Waiting).map(|s| s.id.0.clone()).collect();
        for t in self.repo.running_turns().await? {
            let s = self.repo.session(t.session_id.as_str()).await?;
            self.end_unfinished(s, t).await?;
        }
        for id in waiting {
            let mut s = self.repo.session(&id).await?;
            let Some(ask) = crate::more::ask_id(&s) else { continue };
            self.asks().insert(ask, id);
            if s.state != SessionState::Waiting {
                // the turn that asked ended with wisp; the task still waits on the user
                s.state = SessionState::Waiting;
                self.persist(&mut s, Vec::new()).await?;
            }
        }
        Ok(())
    }

    pub(crate) fn lock_list(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Arc<Summary>>> {
        lock(&self.list)
    }

    pub(crate) fn asks(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        lock(&self.asks)
    }

    pub(crate) fn answers(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        lock(&self.answers)
    }

    /// The next activity seq of task `sid` (read from the store the first time).
    pub(crate) async fn alloc_seq(&self, sid: &str) -> Result<u64> {
        if let Some(n) = lock(&self.seqs).get_mut(sid) {
            *n += 1;
            return Ok(*n - 1);
        }
        let first = self.repo.next_seq(sid).await?;
        let mut m = lock(&self.seqs);
        let n = m.entry(sid.to_owned()).or_insert(first);
        *n += 1;
        Ok(*n - 1)
    }

    /// The drive's own allocation: synchronous, from a counter its start seeded.
    pub(crate) fn alloc_seq_now(&self, sid: &str, seed: u64) -> u64 {
        let mut m = lock(&self.seqs);
        let n = m.entry(sid.to_owned()).or_insert(seed);
        *n = (*n).max(seed);
        *n += 1;
        *n - 1
    }

    pub(crate) fn sign_ins(&self) -> std::sync::MutexGuard<'_, HashMap<String, crate::more::SignIn>> {
        lock(&self.sign_ins)
    }

    pub(crate) fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The task's lock: its commands run one at a time.
    pub(crate) async fn task_lock(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let m = lock(&self.locks).entry(id.to_owned()).or_default().clone();
        m.lock_owned().await
    }

    pub(crate) fn harness(&self, id: &str) -> Result<Arc<dyn Harness>> {
        self.host.harnesses().into_iter().find(|h| h.info().id == id).ok_or_else(|| RuntimeError::NoHarness(id.to_owned()))
    }

    /// A switch in Settings (on unless switched off), v1's `defaults.<x> !== 'off'`.
    pub(crate) fn on_unless_off(&self, key: &str) -> bool {
        self.host.setting(key).and_then(|v| v.as_bool()).unwrap_or(true)
    }

    /// A setting's text value ('' when unset).
    pub(crate) fn text_setting(&self, key: &str) -> String {
        self.host.setting(key).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
    }

    /// `runtime.leanRuns` (v1 defaults.leanRuns).
    fn lean_setting(&self) -> Option<String> {
        self.host.setting("runtime.leanRuns").and_then(|v| v.as_str().map(str::to_owned))
    }

    /// A task's run is lean (v1 `leanTask`): the task's own choice, else Settings' 'all'.
    pub(crate) fn lean_task(&self, s: &Session) -> bool {
        wisp_runtime_core::prompt::lean::lean_task(s.lean.as_deref(), self.lean_setting().as_deref())
    }

    /// A side run wisp makes for itself is lean unless Settings says off (v1 `leanOn`).
    pub(crate) fn lean_side(&self) -> bool {
        wisp_runtime_core::prompt::lean::lean_on(self.lean_setting().as_deref())
    }

    /// What the task's run is doing, for the queue decider.
    pub(crate) fn run_state(&self, id: &str) -> Run {
        lock(&self.live).get(id).map_or(Run::Idle, Live::state)
    }

    /// Writes the task (and the turns given), rebuilds its list row, emits `session.changed`.
    pub(crate) async fn persist(self: &Arc<Self>, s: &mut Session, turns: Vec<Turn>) -> Result<Arc<Summary>> {
        self.persist_with(s, turns, |_| Ok(())).await
    }

    /// `persist`, with more rows of runtime's own written in the same transaction (a task's watch page).
    pub(crate) async fn persist_with(
        self: &Arc<Self>,
        s: &mut Session,
        turns: Vec<Turn>,
        extra: impl FnOnce(&mut wisp_store::Writer<'_>) -> wisp_store::Result<()> + Send + 'static,
    ) -> Result<Arc<Summary>> {
        // boxed: every write of a task goes through here, so its callers' futures stay small
        Box::pin(self.write_session(s, turns, extra)).await
    }

    async fn write_session(
        self: &Arc<Self>,
        s: &mut Session,
        turns: Vec<Turn>,
        extra: impl FnOnce(&mut wisp_store::Writer<'_>) -> wisp_store::Result<()> + Send + 'static,
    ) -> Result<Arc<Summary>> {
        s.rev += 1;
        // what the task read, in memory from here on: its row keeps where its text quotes it (ADR-0050)
        let known = self.env_known(s.id.as_str()).await.ok().map(|v| v.0);
        let hide = crate::env_row::session_hide(s, known.as_deref());
        let mut summary = self.summary_of(s, turns.last()).await?;
        self.usage_into(s, &turns, &mut summary).await?;
        crate::env_row::summary_hide(&mut summary, known.as_deref());
        let summary = Arc::new(summary);
        for t in &turns {
            self.env.note_turn(t.id.as_str(), s.id.as_str()); // its patches on the stream find its task's values
        }
        let (row, sum, ts, k) = (s.clone(), summary.clone(), turns, known);
        self.repo
            .store
            .write(move |w| {
                // the session first: a new task's turns point at it (a fork's, an adopted share's)
                repo::save_session(w, &row, &sum, Some(&hide)).map_err(|e| wisp_store::StoreError::Internal(e.to_string()))?;
                for t in &ts {
                    repo::save_turn(w, t, k.as_deref()).map_err(|e| wisp_store::StoreError::Internal(e.to_string()))?;
                }
                extra(w)
            })
            .await?;
        self.note_cap(s);
        let before = self.lock_list().insert(s.id.0.clone(), summary.clone());
        self.host.emit(Emitted::Changed(SessionChanged { id: s.id.clone() }));
        self.lead_follows(before.as_deref(), &summary);
        Ok(summary)
    }

    /// The list row: runtime's fields, then each `runtime.summary@1` contributor's.
    pub(crate) async fn summary_of(&self, s: &Session, written: Option<&Turn>) -> Result<Summary> {
        let tail = self.repo.turns(s.id.as_str(), None, Some(2)).await?;
        let mut tail: Vec<Turn> = tail.into_iter().filter(|t| written.is_none_or(|w| w.id != t.id)).collect();
        if let Some(w) = written {
            tail.push(w.clone());
            tail.sort_by_key(|t| t.idx);
        }
        let last = tail.last();
        let report = match last {
            Some(t) if t.by.as_deref() == Some("compact") && t.status == TurnStatus::Done => tail.iter().rev().nth(1),
            other => other,
        };
        let followups =
            self.lock_list().get(s.id.as_str()).and_then(|r| r.fields.get("followups").and_then(serde_json::Value::as_u64)).unwrap_or(0);
        let live_step = self.live_label(s.id.as_str());
        let facts = RowFacts {
            last,
            report,
            turn_count: last.map_or(0, |t| t.idx + 1),
            followups: u32::try_from(followups).unwrap_or(0),
            live_step: live_step.as_deref(),
            ..RowFacts::default()
        };
        let mut fields = BTreeMap::new();
        for f in self.host.summary_fields() {
            f.fields(s, last, &mut fields);
        }
        let mut row = summarize(s, &facts, fields);
        // a follow-up of yours just started (not wisp's repair rounds or a compaction)
        if written.is_some_and(|t| t.idx > 0 && t.status == TurnStatus::Running && !matches!(t.by.as_deref(), Some("wisp" | "compact"))) {
            row.fields.insert("followups".into(), (followups + 1).into());
        }
        Ok(row)
    }

    fn live_label(&self, id: &str) -> Option<String> {
        lock(&self.live).get(id).and_then(|l| l.label.clone())
    }

    /// Auto's pick for a new task, or `None` (no router on, or nothing allowed can run now: the first
    /// harness then, as before).
    fn auto_pick(&self, a: &StartArgs) -> Option<wisp_router_api::Pick> {
        let (router, call) = self.host.router()?;
        let choose = wisp_router_api::ChooseArgs {
            prompt: a.prompt.clone(),
            attachments: u32::try_from(a.attachments.len()).unwrap_or(u32::MAX),
            need_delegate: a.team.is_some(),
            ..wisp_router_api::ChooseArgs::default()
        };
        match router.pick(&call, wisp_router_api::service::PickRequest { choose, level_up: None }) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e.message, "Auto couldn't pick: the first harness runs it");
                None
            }
        }
    }

    /// What the launch teaches Auto (v1 index.js:315): its route, your own pick of a top-level task (your
    /// taste), and a pick that overrode Auto's preview. Subagents, crew and channel jobs teach nothing.
    fn auto_learn(&self, s: &Session, a: &StartArgs, pick: Option<&wisp_router_api::Pick>) {
        use wisp_router_api::service::Outcome;
        let Some((router, call)) = self.host.router() else { return };
        let id = s.id.0.clone();
        let mut out = Vec::new();
        if let Some(p) = pick {
            out.push(Outcome::Launched { id, route: wisp_router_api::StoredRoute::from_route(&p.route) });
        } else if a.parent_id.is_none() && a.by.is_none() {
            let attachments = u32::try_from(a.attachments.len()).unwrap_or(u32::MAX);
            out.push(Outcome::Manual {
                id,
                agent: s.agent.clone(),
                model: s.model.clone(),
                effort: s.effort.clone(),
                prompt: a.prompt.clone(),
                attachments,
            });
            if let Some(o) = &a.auto_override {
                out.push(Outcome::Override {
                    kind: o.kind.clone(),
                    auto: o.key.clone(),
                    chose: wisp_router_api::arm_key(&s.agent, &s.model, &s.effort),
                    prompt: a.prompt.clone(),
                });
            }
        }
        for o in out {
            if let Err(e) = router.report(&call, o) {
                tracing::warn!(error = %e.message, "Auto didn't hear of a launch");
            }
        }
    }

    /// `runtime.create`: a new task, and its first turn starts.
    pub async fn create(self: &Arc<Self>, a: StartArgs) -> Result<Created> {
        if a.prompt.trim().is_empty() {
            return Err(RuntimeError::Invalid("a task needs a prompt".into()));
        }
        let first = self.host.harnesses().into_iter().next();
        // Auto (v1 router.js): nothing named, or `auto`: the router picks harness, model and level
        let pick = if a.agent.as_deref().is_none_or(|x| x.is_empty() || x == "auto") { self.auto_pick(&a) } else { None };
        let agent = pick
            .as_ref()
            .map(|p| p.agent.clone())
            .or_else(|| a.agent.clone().filter(|x| !x.is_empty() && x != "auto"))
            .or_else(|| first.as_ref().map(|h| h.info().id.clone()))
            .unwrap_or_default();
        let model = pick
            .as_ref()
            .map(|p| p.model.clone())
            .filter(|m| !m.is_empty())
            .or_else(|| a.model.clone())
            .or_else(|| self.harness(&agent).ok().and_then(|h| h.info().models.first().map(|m| m.id.clone())))
            .unwrap_or_default();
        let now = self.now();
        let mut s = Session {
            id: SessionId::new(),
            title: a
                .title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| land::auto_title(&prompt::mentions::plain_mentions(&a.prompt))),
            agent,
            model,
            effort: pick.as_ref().map(|p| p.effort.clone()).filter(|e| !e.is_empty()).or_else(|| a.effort.clone()).unwrap_or_default(),
            account: a.account.clone(),
            mode: a.mode.unwrap_or(Mode::Auto),
            cwd: a.cwd.clone().unwrap_or_default(),
            dirs: a.dirs.clone(),
            state: SessionState::Running,
            parent_id: a.parent_id.clone(),
            created_at: now,
            updated_at: now,
            ext: a.ext.clone(),
            ..Session::default()
        };
        // the caller's own fields in runtime's slot (a lead's team, a cap) stay
        let mut own = match s.ext.remove("wisp.runtime") {
            Some(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        // a cap (a channel's, a capped lead's): the tighter of the one asked and one the caller's slot carries
        let cap = cap::tighter(a.cap, cap::of(Some(&serde_json::Value::Object(own.clone()))));
        if let Some(c) = cap {
            if a.mode.is_some_and(|m| m.rank() > c.rank()) {
                let m = a.mode.unwrap_or_default();
                return Err(RuntimeError::Wire(WireError::forbidden(wisp_runtime_core::agent_task::over_cap(m, c))));
            }
            s.mode = cap::at_cap(s.mode, Some(c));
            match cap::stored(c) {
                Some(v) => own.insert("capped".into(), v),
                None => own.remove("capped"),
            };
        }
        own.insert("titleAuto".into(), a.title.is_none().into());
        if a.terminal {
            own.insert("terminal".into(), serde_json::json!({ "prompt": a.prompt, "opened": false }));
        }
        s.ext.insert("wisp.runtime".into(), serde_json::Value::Object(own));
        if let Some(p) = &pick {
            s.ext.insert(wisp_router_api::PLUGIN_ID.into(), serde_json::json!({ "route": p.route }));
        }
        let summary = self.persist(&mut s, Vec::new()).await?;
        self.host.emit(Emitted::Created(SessionCreated { session: (*summary).clone() }));
        self.auto_learn(&s, &a, pick.as_ref());
        let item = QueueItem {
            id: wisp_kernel::ids::uuid7(),
            text: a.prompt,
            attachments: a.attachments,
            at: now,
            by: a.by,
            opts: a.confirm_limit.then(|| serde_json::json!({ "confirmLimit": true })),
            ..QueueItem::default()
        };
        if a.terminal {
            // no headless run: the CLI in its terminal is the task's run (`terminal_argv`)
            self.persist(&mut s, Vec::new()).await?;
            return Ok(Created { id: s.id, turn_id: None });
        }
        if a.hold {
            s.queue.push(item);
            s.queue_held = true;
            s.state = SessionState::Review;
            self.persist(&mut s, Vec::new()).await?;
            return Ok(Created { id: s.id, turn_id: None });
        }
        let turn_id = self.start_turn(s.clone(), item).await?;
        Ok(Created { id: s.id, turn_id: Some(turn_id) })
    }

    /// A task created held for its worktree: it moves into `wt` (`ext["wisp.worktrees"]`, its cwd), and its
    /// first turn starts, or is held with the setup's error when the project's setup failed there
    /// (v1's held-turn card: Start now runs it anyway, Skip stops it).
    pub async fn worktree_ready(
        self: &Arc<Self>,
        id: &str,
        wt: Option<serde_json::Value>,
        setup_failed: Option<String>,
    ) -> Result<Option<wisp_runtime_api::TurnId>> {
        let guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        if let Some(w) = wt {
            if let Some(cwd) = w.get("cwd").and_then(serde_json::Value::as_str).filter(|c| !c.is_empty()) {
                cwd.clone_into(&mut s.cwd);
            }
            s.ext.insert("wisp.worktrees".into(), w);
        }
        if let Some(why) = setup_failed
            && let Some(own) = s.ext.get_mut("wisp.runtime").and_then(serde_json::Value::as_object_mut)
        {
            own.insert("setupFailed".into(), serde_json::json!(why));
        }
        s.queue_held = false;
        if s.queue.is_empty() {
            self.persist(&mut s, Vec::new()).await?;
            return Ok(None);
        }
        let item = s.queue.remove(0);
        self.persist(&mut s, Vec::new()).await?;
        drop(guard);
        Ok(Some(self.start_turn(s, item).await?))
    }

    /// `runtime.followUp` (v1 `reply`): starts a turn, queues, interrupts, answers an open question, or
    /// holds, as the queue decider says.
    pub async fn follow_up(self: &Arc<Self>, a: FollowUpArgs) -> Result<FollowedUp> {
        let guard = self.task_lock(a.id.as_str()).await;
        let mut s = self.repo.session(a.id.as_str()).await?;
        if a.text.trim().is_empty() && a.attachments.is_empty() {
            return Err(RuntimeError::Invalid("a follow-up needs text".into()));
        }
        let opts =
            serde_json::to_value(serde_json::json!({ "mode": a.mode, "run": a.run, "confirmLimit": a.confirm_limit.then_some(true) }))
                .ok()
                .filter(|v| v.as_object().is_some_and(|o| o.values().any(|x| !x.is_null())));
        let has_extras = opts.is_some() || a.by.is_some();
        let item = QueueItem {
            id: wisp_kernel::ids::uuid7(),
            text: a.text,
            attachments: a.attachments,
            at: self.now(),
            by: a.by,
            opts,
            ..QueueItem::default()
        };
        let last_held = self.repo.turns(a.id.as_str(), None, Some(1)).await?.last().is_some_and(|t| t.status == TurnStatus::Held);
        let run = self.run_state(a.id.as_str());
        let mut held = s.queue_held;
        let mut items = std::mem::take(&mut s.queue);
        let d = queue::follow_up(
            &mut Queue { items: &mut items, held: &mut held },
            run,
            crate::more::ask_id(&s).is_some(),
            last_held,
            Incoming {
                item,
                // v1 launch.js: a follow-up sent without saying queues when Settings → follow-ups say queue
                queue: a.queue.unwrap_or_else(|| self.text_setting("runtime.followUp") == "queue"),
                has_extras,
                hold: false,
            },
        );
        s.queue = items;
        s.queue_held = held;
        if d.cancel_after {
            for step in self.host.after_steps() {
                step.cancel(&s, false, None);
            }
        }
        if d.release_held {
            self.release_held(&mut s).await?;
        }
        if d.release_linger {
            self.release_linger(a.id.as_str());
        }
        let out = match d.plan {
            Plan::Start(item) => {
                drop(guard);
                return Ok(FollowedUp { turn_id: Some(self.start_turn(s, item).await?), queued: None });
            }
            Plan::Queued { .. } => FollowedUp { turn_id: None, queued: s.queue.last().map(|q| q.id.clone()) },
            Plan::Interrupt => {
                self.interrupt(a.id.as_str());
                FollowedUp { turn_id: None, queued: s.queue.first().map(|q| q.id.clone()) }
            }
            Plan::Answer(item) => {
                self.persist(&mut s, Vec::new()).await?;
                self.answer_locked(&a.id, &item.text).await?;
                return Ok(FollowedUp { turn_id: None, queued: None });
            }
            Plan::Hold(_) => FollowedUp { turn_id: None, queued: None },
        };
        self.persist(&mut s, Vec::new()).await?;
        drop(guard);
        self.kick(s).await?;
        Ok(out)
    }

    /// Nothing runs and the queue isn't held: its first item goes (a released held turn, a release).
    pub(crate) async fn kick(self: &Arc<Self>, mut s: Session) -> Result<Option<wisp_runtime_api::TurnId>> {
        if self.run_state(s.id.as_str()) != Run::Idle {
            return Ok(None);
        }
        let mut held = s.queue_held;
        let Some(next) = queue::next_after_release(&mut Queue { items: &mut s.queue, held: &mut held }) else {
            return Ok(None);
        };
        Ok(Some(self.start_turn(s, next).await?))
    }

    /// `runtime.stop`: a Stop never discards queued follow-ups, it holds them.
    pub async fn stop(self: &Arc<Self>, id: &str, clear_queue: bool) -> Result<()> {
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let mut held = s.queue_held;
        let plan = queue::stop(&mut Queue { items: &mut s.queue, held: &mut held }, self.run_state(id));
        s.queue_held = held;
        if clear_queue {
            s.queue.clear();
            s.queue_held = false;
        }
        for step in self.host.after_steps() {
            step.cancel(&s, true, None);
        }
        self.cancel_asks(&mut s);
        if plan.stop_run {
            self.stop_run(id);
        } else if s.state == SessionState::Running {
            s.state = SessionState::Review;
        }
        self.persist(&mut s, Vec::new()).await?;
        Ok(())
    }

    /// The held turn goes now: it is dropped from the log and its prompt runs (or queues, if a run is on).
    /// Whether task `id` is `root` or under it (a delegation's parent chain, at most 16 up).
    pub(crate) async fn under(&self, id: &str, root: &str) -> bool {
        let mut at = id.to_owned();
        for _ in 0..16 {
            if at == root {
                return true;
            }
            match self.repo.session(&at).await.ok().and_then(|s| s.parent_id) {
                Some(p) => at = p.0,
                None => return false,
            }
        }
        false
    }

    pub(crate) async fn release_held(self: &Arc<Self>, s: &mut Session) -> Result<()> {
        let Some(t) = self.repo.turns(s.id.as_str(), None, Some(1)).await?.pop().filter(|t| t.status == TurnStatus::Held) else {
            return Ok(());
        };
        let item = QueueItem {
            id: wisp_kernel::ids::uuid7(),
            text: t.prompt.clone(),
            attachments: t.attachments.clone(),
            at: self.now(),
            by: t.by.clone(),
            ..QueueItem::default()
        };
        let tid = t.id.clone();
        self.repo.store.write(move |w| w.del("turn", tid.as_str()).map(|_| ())).await?;
        s.queue.insert(0, item);
        Ok(())
    }
}
