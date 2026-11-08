//! Ending a turn and landing its task (v1 runner.js `#finishTurn`, `release`), applied in one transaction:
//! the turn's head (status, answer, stats, captured edits), the task's state, then `turn.ended` always and
//! `turn.finished` when someone should hear of it. The decisions are `wisp_runtime_core::land`'s.

use std::sync::Arc;

use serde_json::json;
use wisp_runtime_api::events::{TurnEnded, TurnFinished};
use wisp_runtime_api::model::{Session, Turn, TurnStatus};
use wisp_runtime_core::activity::{Effect, Head};
use wisp_runtime_core::land::{self, Ending, Facts};
use wisp_runtime_core::queue::{self, Queue};

use crate::drive::Drive;
use crate::error::Result;
use crate::host::Emitted;
use crate::runtime::Runtime;

impl Runtime {
    /// The run's result is in: flush its activity, end the turn, land the task.
    pub(crate) async fn finish(self: &Arc<Self>, d: &mut Drive, e: Effect) {
        d.finished = true;
        d.coal.flush().await;
        if let Some(l) = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(&d.sid)
        {
            l.finished = true;
        }
        let n_events = u32::try_from(d.seq).unwrap_or(u32::MAX);
        if let Err(err) = self.end_turn(&d.sid, &d.tid, &d.head, e, n_events).await {
            tracing::warn!(task = %d.sid, %err, "a turn's end was not recorded");
        }
    }

    async fn end_turn(
        self: &Arc<Self>,
        sid: &str,
        tid: &str,
        head: &Head,
        e: Effect,
        n_events: u32,
    ) -> Result<()> {
        let Effect::Finish {
            text,
            is_error,
            stopped,
            stats,
            auth_failed,
        } = e
        else {
            return Ok(());
        };
        let _guard = self.task_lock(sid).await;
        let mut s = self.repo.session(sid).await?;
        let mut turn = self.repo.turn(tid).await?;
        let (stopping, interrupted) = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(sid)
            .map_or((false, false), |l| {
                (l.stopping || l.interrupting, l.interrupting)
            });
        let harness = self
            .harness(&turn.agent)
            .map(|h| h.info().name.clone())
            .unwrap_or_default();
        let ending = Ending {
            stopped: stopped || stopping,
            interrupted,
            is_error,
            text: &text,
            harness: &harness,
            changes: &head.changes,
            reason: None,
        };
        let blocks = self.host.blocks();
        let (status, presentation) = land::end_presentation(&ending, |t| {
            wisp_runtime_core::blocks::presentation(t, &blocks)
        });
        turn.status = status;
        turn.ended_at = Some(self.now());
        turn.stats = stats.as_ref().map(land::turn_stats);
        turn.text = head
            .text
            .clone()
            .or_else(|| (!text.is_empty()).then(|| text.clone()));
        turn.is_error = status == TurnStatus::Error;
        turn.changed_files = u32::try_from(head.changes.len()).ok().filter(|n| *n > 0);
        turn.n_events = n_events;
        turn.resume_id.clone_from(&head.resume_id);
        if !head.changes.is_empty() || !head.blocked.is_empty() || auth_failed {
            turn.ext.insert("wisp.runtime".into(), json!({ "changes": head.changes, "blocked": head.blocked, "authFailed": auth_failed }));
        }
        if status == TurnStatus::Done
            && turn.idx == 0
            && title_auto(&s)
            && let Some(t) = land::topic_title(&presentation)
        {
            s.title = t;
        }
        turn.presentation = Some(presentation);
        if head.resume_id.is_some() {
            s.resume_id.clone_from(&head.resume_id);
        }
        // v1 runner.js:1812: a question the turn left open goes with it (no stale ask in review)
        self.cancel_asks(&mut s);
        let landing = self.landing(&s, &turn, stopped || stopping, interrupted);
        s.state = landing.state;
        s.unread = landing.unread;
        if landing.archive {
            s.archived = true;
        }
        s.updated_at = self.now();
        let summary = self.persist(&mut s, vec![turn.clone()]).await?;
        self.emit_end(&s, &turn, interrupted, &landing, &summary, &text);
        self.mirror_v1(&s);
        if let Some(id) = landing.run_after
            && let Some(step) = self.host.after_steps().into_iter().find(|a| a.id() == id)
        {
            let (s2, t2) = (s.clone(), turn.clone());
            tokio::spawn(async move {
                if let Err(err) = step.run(s2, t2).await {
                    tracing::warn!(%err, "an after-turn step failed");
                }
            });
        }
        if landing.handing {
            self.release_linger(sid);
        }
        Ok(())
    }

    fn landing(&self, s: &Session, turn: &Turn, stopped: bool, interrupted: bool) -> land::Landing {
        let outcome = self
            .host
            .outcomes()
            .iter()
            .find_map(|o| o.outcome(s, turn))
            .unwrap_or_default();
        let facts = Facts {
            stopped,
            interrupted,
            follow_up_waits: !s.queue.is_empty() && !s.queue_held,
            compact: turn.by.as_deref() == Some("compact"),
            sub: s.parent_id.is_some(),
            ..Facts::default()
        };
        let end = wisp_runtime_api::points::TurnEnd {
            stopped,
            is_error: turn.is_error,
        };
        let mut steps = self.host.after_steps();
        steps.sort_by_key(|a| a.order());
        land::land(facts, outcome, || {
            steps
                .iter()
                .find(|a| a.wants(s, turn, end))
                .map(|a| a.id().to_owned())
        })
    }

    fn emit_end(
        &self,
        s: &Session,
        turn: &Turn,
        interrupted: bool,
        l: &land::Landing,
        summary: &wisp_runtime_api::model::Summary,
        text: &str,
    ) {
        let error_text = (turn.status == TurnStatus::Error).then(|| text.to_owned());
        let cost = turn.stats.as_ref().and_then(|x| x.cost_usd);
        self.host.emit(Emitted::Ended(TurnEnded {
            session_id: s.id.clone(),
            turn_id: turn.id.clone(),
            status: turn.status,
            interrupted,
            error_text,
            cost_usd: cost,
            changed_files: turn.changed_files,
            agent: turn.agent.clone(),
            model: turn.model.clone(),
        }));
        if l.notify {
            self.host.emit(Emitted::Finished(TurnFinished {
                session_id: s.id.clone(),
                turn_id: turn.id.clone(),
                status: turn.status,
                interrupted,
                summary: summary.clone(),
            }));
        }
    }

    /// A turn that failed before its process ran (the spawn failed).
    pub(crate) async fn finish_now(
        self: &Arc<Self>,
        sid: &str,
        tid: &str,
        why: &str,
    ) -> Result<()> {
        let e = Effect::Finish {
            text: why.to_owned(),
            is_error: true,
            stopped: false,
            stats: None,
            auth_failed: false,
        };
        self.end_turn(sid, tid, &Head::default(), e, 0).await
    }

    /// A turn a crash or restart left running never finished: it shows stopped (v1 `restartReason`).
    pub(crate) async fn end_unfinished(
        self: &Arc<Self>,
        mut s: Session,
        mut t: Turn,
    ) -> Result<()> {
        let ending = Ending {
            stopped: true,
            interrupted: false,
            is_error: false,
            text: "",
            harness: "",
            changes: &[],
            reason: Some((
                "Stopped",
                "wisp restarted while this was running. Follow up to pick it back up.",
            )),
        };
        let (status, p) = land::end_presentation(&ending, |_| {
            wisp_runtime_api::model::Presentation::default()
        });
        t.status = status;
        t.presentation = Some(p);
        t.ended_at = Some(t.started_at);
        s.state = wisp_runtime_api::model::SessionState::Review;
        self.persist(&mut s, vec![t]).await?;
        Ok(())
    }

    /// The run let go: the live entry goes, and the next queued follow-up starts (unless a Stop held them).
    pub(crate) async fn release_run(self: &Arc<Self>, sid: &str) {
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(sid);
        let next = {
            let _guard = self.task_lock(sid).await;
            let Ok(mut s) = self.repo.session(sid).await else {
                return;
            };
            let mut held = s.queue_held;
            let next = queue::next_after_release(&mut Queue {
                items: &mut s.queue,
                held: &mut held,
            });
            if next.is_some() && self.persist(&mut s, Vec::new()).await.is_err() {
                return;
            }
            next.map(|n| (s, n))
        };
        if let Some((s, n)) = next {
            self.spawn_start(s, n);
        }
    }

    /// Starts a queued turn on its own task. A sync step on purpose: a run's end starting the next run
    /// would otherwise make the run's future contain itself, and its `Send` couldn't be proven.
    fn spawn_start(self: &Arc<Self>, s: Session, n: wisp_runtime_api::model::QueueItem) {
        let rt = self.clone();
        let sid = s.id.0.clone();
        tokio::spawn(async move {
            if let Err(err) = rt.start_turn(s, n).await {
                tracing::warn!(task = %sid, %err, "the next queued follow-up did not start");
            }
        });
    }
}

fn title_auto(s: &Session) -> bool {
    s.ext
        .get("wisp.runtime")
        .and_then(|v| v.get("titleAuto"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}
