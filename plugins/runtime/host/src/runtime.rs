//! The runtime service: every command's behaviour, over the store, the proc service and the host seam.
//! A task's commands run one at a time (a per-task lock), each in one store transaction; events go out
//! after it commits. The list is served from memory: one cached row per task, rebuilt when the task's row
//! is written, never per read (plan §4.1: only open or running sessions are kept whole in memory).
//!
//! size-ok: the runtime service's per-task lock and transaction wrap every command here

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::Clock;
use wisp_proc::Proc;
use wisp_runtime_api::commands::{Created, FollowUpArgs, FollowedUp, StartArgs};
use wisp_runtime_api::events::{SessionChanged, SessionCreated};
use wisp_runtime_api::model::{Mode, QueueItem, Session, SessionState, Summary, Turn, TurnStatus};
use wisp_runtime_api::{Harness, SessionId};
use wisp_runtime_core::queue::{self, Incoming, Plan, Queue, Run};
use wisp_runtime_core::summary::{RowFacts, summarize};
use wisp_runtime_core::{land, prompt};

use crate::error::{Result, RuntimeError};
use crate::host::{Emitted, Host};
use crate::repo::{self, Repo};
use crate::run::Live;

pub struct Runtime {
    pub repo: Repo,
    pub host: Arc<dyn Host>,
    pub proc: Proc,
    pub clock: Arc<dyn Clock>,
    /// v1's sessions folder, kept current during the dual-write release (plan §4.8); None: off
    pub mirror: Option<PathBuf>,
    pub(crate) list: Mutex<BTreeMap<String, Arc<Summary>>>,
    pub(crate) live: Mutex<HashMap<String, Live>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime")
            .field("tasks", &self.lock_list().len())
            .finish_non_exhaustive()
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
            mirror: None,
            list: Mutex::default(),
            live: Mutex::default(),
            locks: Mutex::default(),
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
        for t in self.repo.running_turns().await? {
            let s = self.repo.session(t.session_id.as_str()).await?;
            self.end_unfinished(s, t).await?;
        }
        Ok(())
    }

    pub(crate) fn lock_list(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Arc<Summary>>> {
        lock(&self.list)
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
        self.host
            .harnesses()
            .into_iter()
            .find(|h| h.info().id == id)
            .ok_or_else(|| RuntimeError::NoHarness(id.to_owned()))
    }

    /// What the task's run is doing, for the queue decider.
    pub(crate) fn run_state(&self, id: &str) -> Run {
        lock(&self.live).get(id).map_or(Run::Idle, Live::state)
    }

    /// Writes the task (and the turns given), rebuilds its list row, emits `session.changed`.
    pub(crate) async fn persist(&self, s: &mut Session, turns: Vec<Turn>) -> Result<Arc<Summary>> {
        s.rev += 1;
        let summary = Arc::new(self.summary_of(s, turns.last()).await?);
        let (row, sum, ts) = (s.clone(), summary.clone(), turns);
        self.repo
            .store
            .write(move |w| {
                for t in &ts {
                    repo::save_turn(w, t)
                        .map_err(|e| wisp_store::StoreError::Internal(e.to_string()))?;
                }
                repo::save_session(w, &row, &sum)
                    .map_err(|e| wisp_store::StoreError::Internal(e.to_string()))
            })
            .await?;
        self.lock_list().insert(s.id.0.clone(), summary.clone());
        self.host
            .emit(Emitted::Changed(SessionChanged { id: s.id.clone() }));
        Ok(summary)
    }

    /// The list row: runtime's fields, then each `runtime.summary@1` contributor's.
    pub(crate) async fn summary_of(&self, s: &Session, written: Option<&Turn>) -> Result<Summary> {
        let tail = self.repo.turns(s.id.as_str(), None, Some(2)).await?;
        let mut tail: Vec<Turn> = tail
            .into_iter()
            .filter(|t| written.is_none_or(|w| w.id != t.id))
            .collect();
        if let Some(w) = written {
            tail.push(w.clone());
            tail.sort_by_key(|t| t.idx);
        }
        let last = tail.last();
        let report = match last {
            Some(t) if t.by.as_deref() == Some("compact") && t.status == TurnStatus::Done => {
                tail.iter().rev().nth(1)
            }
            other => other,
        };
        let followups = self
            .lock_list()
            .get(s.id.as_str())
            .and_then(|r| {
                r.fields
                    .get("followups")
                    .and_then(serde_json::Value::as_u64)
            })
            .unwrap_or(0);
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
        if written.is_some_and(|t| {
            t.idx > 0
                && t.status == TurnStatus::Running
                && !matches!(t.by.as_deref(), Some("wisp" | "compact"))
        }) {
            row.fields
                .insert("followups".into(), (followups + 1).into());
        }
        Ok(row)
    }

    fn live_label(&self, id: &str) -> Option<String> {
        lock(&self.live).get(id).and_then(|l| l.label.clone())
    }

    /// `runtime.create`: a new task, and its first turn starts.
    pub async fn create(self: &Arc<Self>, a: StartArgs) -> Result<Created> {
        if a.prompt.trim().is_empty() {
            return Err(RuntimeError::Invalid("a task needs a prompt".into()));
        }
        let first = self.host.harnesses().into_iter().next();
        let agent = a
            .agent
            .clone()
            .filter(|x| !x.is_empty() && x != "auto")
            .or_else(|| first.as_ref().map(|h| h.info().id.clone()))
            .unwrap_or_default();
        let model = a
            .model
            .clone()
            .or_else(|| {
                self.harness(&agent)
                    .ok()
                    .and_then(|h| h.info().models.first().map(|m| m.id.clone()))
            })
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
            effort: a.effort.clone().unwrap_or_default(),
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
        s.ext.insert(
            "wisp.runtime".into(),
            serde_json::json!({ "titleAuto": a.title.is_none() }),
        );
        let summary = self.persist(&mut s, Vec::new()).await?;
        self.host.emit(Emitted::Created(SessionCreated {
            session: (*summary).clone(),
        }));
        let item = QueueItem {
            id: wisp_kernel::ids::uuid7(),
            text: a.prompt,
            attachments: a.attachments,
            at: now,
            by: a.by,
            ..QueueItem::default()
        };
        if a.hold {
            s.queue.push(item);
            s.queue_held = true;
            s.state = SessionState::Review;
            self.persist(&mut s, Vec::new()).await?;
            return Ok(Created {
                id: s.id,
                turn_id: None,
            });
        }
        let turn_id = self.start_turn(s.clone(), item).await?;
        Ok(Created {
            id: s.id,
            turn_id: Some(turn_id),
        })
    }

    /// `runtime.followUp` (v1 `reply`): starts a turn, queues, interrupts, answers an open question, or
    /// holds, as the queue decider says.
    pub async fn follow_up(self: &Arc<Self>, a: FollowUpArgs) -> Result<FollowedUp> {
        let guard = self.task_lock(a.id.as_str()).await;
        let mut s = self.repo.session(a.id.as_str()).await?;
        if a.text.trim().is_empty() && a.attachments.is_empty() {
            return Err(RuntimeError::Invalid("a follow-up needs text".into()));
        }
        let opts = serde_json::to_value(serde_json::json!({ "mode": a.mode, "run": a.run }))
            .ok()
            .filter(|v| {
                v.as_object()
                    .is_some_and(|o| o.values().any(|x| !x.is_null()))
            });
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
        let last_held = self
            .repo
            .turns(a.id.as_str(), None, Some(1))
            .await?
            .last()
            .is_some_and(|t| t.status == TurnStatus::Held);
        let run = self.run_state(a.id.as_str());
        let mut held = s.queue_held;
        let mut items = std::mem::take(&mut s.queue);
        let d = queue::follow_up(
            &mut Queue {
                items: &mut items,
                held: &mut held,
            },
            run,
            false,
            last_held,
            Incoming {
                item,
                queue: a.queue.unwrap_or(true),
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
                return Ok(FollowedUp {
                    turn_id: Some(self.start_turn(s, item).await?),
                    queued: None,
                });
            }
            Plan::Queued { .. } => FollowedUp {
                turn_id: None,
                queued: s.queue.last().map(|q| q.id.clone()),
            },
            Plan::Interrupt => {
                self.interrupt(a.id.as_str());
                FollowedUp {
                    turn_id: None,
                    queued: s.queue.first().map(|q| q.id.clone()),
                }
            }
            Plan::Answer(_) | Plan::Hold(_) => FollowedUp {
                turn_id: None,
                queued: None,
            },
        };
        self.persist(&mut s, Vec::new()).await?;
        drop(guard);
        self.kick(s).await?;
        Ok(out)
    }

    /// Nothing runs and the queue isn't held: its first item goes (a released held turn, a release).
    pub(crate) async fn kick(
        self: &Arc<Self>,
        mut s: Session,
    ) -> Result<Option<wisp_runtime_api::TurnId>> {
        if self.run_state(s.id.as_str()) != Run::Idle {
            return Ok(None);
        }
        let mut held = s.queue_held;
        let Some(next) = queue::next_after_release(&mut Queue {
            items: &mut s.queue,
            held: &mut held,
        }) else {
            return Ok(None);
        };
        Ok(Some(self.start_turn(s, next).await?))
    }

    /// `runtime.stop`: a Stop never discards queued follow-ups, it holds them.
    pub async fn stop(self: &Arc<Self>, id: &str, clear_queue: bool) -> Result<()> {
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let mut held = s.queue_held;
        let plan = queue::stop(
            &mut Queue {
                items: &mut s.queue,
                held: &mut held,
            },
            self.run_state(id),
        );
        s.queue_held = held;
        if clear_queue {
            s.queue.clear();
            s.queue_held = false;
        }
        for step in self.host.after_steps() {
            step.cancel(&s, true, None);
        }
        if plan.stop_run {
            self.stop_run(id);
        } else if s.state == SessionState::Running {
            s.state = SessionState::Review;
        }
        self.persist(&mut s, Vec::new()).await?;
        Ok(())
    }

    /// The held turn goes now: it is dropped from the log and its prompt runs (or queues, if a run is on).
    pub(crate) async fn release_held(self: &Arc<Self>, s: &mut Session) -> Result<()> {
        let Some(t) = self
            .repo
            .turns(s.id.as_str(), None, Some(1))
            .await?
            .pop()
            .filter(|t| t.status == TurnStatus::Held)
        else {
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
        self.repo
            .store
            .write(move |w| w.del("turn", tid.as_str()).map(|_| ()))
            .await?;
        s.queue.insert(0, item);
        Ok(())
    }
}
