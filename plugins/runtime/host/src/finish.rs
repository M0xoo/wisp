//! Ending a turn and landing its task (v1 runner.js `#finishTurn`, `release`), applied in one transaction:
//! the turn's head (status, answer, stats, captured edits), the task's state, then `turn.ended` always and
//! `turn.finished` when someone should hear of it. The decisions are `wisp_runtime_core::land`'s.

use std::sync::Arc;

use serde_json::json;
use wisp_runtime_api::events::{TurnEnded, TurnFinished};
use wisp_runtime_api::harness::Harness;
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
        if let Some(l) = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_mut(&d.sid) {
            l.finished = true;
        }
        let n_events = u32::try_from(d.seq).unwrap_or(u32::MAX);
        if let Err(err) = self.end_turn(&d.sid, &d.tid, &d.head, e, n_events).await {
            tracing::warn!(task = %d.sid, %err, "a turn's end was not recorded");
        }
    }

    async fn end_turn(self: &Arc<Self>, sid: &str, tid: &str, head: &Head, e: Effect, n_events: u32) -> Result<()> {
        let Effect::Finish { text, is_error, stopped, stats, auth_failed, stop_reason } = e else {
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
            .map_or((false, false), |l| (l.stopping || l.interrupting, l.interrupting));
        let h = self.harness(&turn.agent).ok();
        let harness = h.as_ref().map(|h| h.info().name.clone()).unwrap_or_default();
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
        let (status, mut presentation) = land::end_presentation(&ending, |t| wisp_runtime_core::blocks::presentation(t, &blocks));
        // a usage limit first (v1 `#atLimit`), then a refusal (v1 `#refused`, never at a limit)
        let ours = s.parent_id.is_none() && !(stopped || stopping);
        let limited = ours && is_error && self.at_limit(&s, &mut turn, &text, &mut presentation).await;
        if ours && !limited {
            refuse(&mut turn, &mut presentation, &text, &stop_reason, is_error, head.changes.len(), &harness, h.as_deref());
        }
        turn.status = status;
        turn.ended_at = Some(self.now());
        turn.stats = stats.as_ref().map(land::turn_stats);
        turn.text = head.text.clone().or_else(|| (!text.is_empty()).then(|| text.clone()));
        turn.is_error = status == TurnStatus::Error;
        turn.changed_files = u32::try_from(head.changes.len()).ok().filter(|n| *n > 0);
        turn.n_events = n_events;
        turn.resume_id.clone_from(&head.resume_id);
        // only what wisp can allow is kept for Allow & retry (a Full auto run's refusals are its harness's own: v1 #777)
        let blocked = wisp_runtime_core::activity::allowable(turn.mode, &head.blocked);
        if !head.changes.is_empty() || !blocked.is_empty() || auth_failed || head.cli.is_some() {
            // `cli`: what the CLI was this turn (version, catalog), for the page's "since the last turn" line
            turn.ext.insert(
                "wisp.runtime".into(),
                json!({ "changes": head.changes, "blocked": blocked, "authFailed": auth_failed, "cli": head.cli }),
            );
        }
        if status == TurnStatus::Done
            && turn.idx == 0
            && title_auto(&s)
            && let Some(t) = land::topic_title(&presentation)
        {
            s.title = t;
        }
        self.keep_media(&s, turn.id.as_str(), &mut presentation.blocks).await;
        turn.presentation = Some(presentation);
        if head.resume_id.is_some() {
            s.resume_id.clone_from(&head.resume_id);
        }
        // v1 runner.js:1812: a question the turn left open goes with it (no stale ask in review)
        self.cancel_asks(&mut s);
        let mut landing = self.landing(&s, &turn, stopped || stopping, interrupted);
        let waits = self.waits_reset(&s, &mut turn, &mut landing);
        s.state = landing.state;
        s.unread = landing.unread;
        if landing.archive {
            s.archived = true;
        }
        s.updated_at = self.now();
        let summary = self.persist(&mut s, vec![turn.clone()]).await?;
        self.emit_end(&s, &turn, interrupted, &landing, &summary, &text);
        if let (true, Some(l)) = (waits, turn.limit.as_ref()) {
            let (rt, sid, agent, until) = (self.clone(), s.id.0.clone(), turn.agent.clone(), l.until);
            tokio::spawn(async move { rt.schedule_reset(&sid, &agent, until).await });
        }
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
        let outcome = self.host.outcomes().iter().find_map(|o| o.outcome(s, turn)).unwrap_or_default();
        let facts = Facts {
            stopped,
            interrupted,
            follow_up_waits: !s.queue.is_empty() && !s.queue_held,
            compact: turn.by.as_deref() == Some("compact"),
            sub: s.parent_id.is_some(),
            ..Facts::default()
        };
        let end = wisp_runtime_api::points::TurnEnd { stopped, is_error: turn.is_error };
        let mut steps = self.host.after_steps();
        steps.sort_by_key(|a| a.order());
        land::land(facts, outcome, || steps.iter().find(|a| a.wants(s, turn, end)).map(|a| a.id().to_owned()))
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
            account: turn.account.clone().or_else(|| s.account.clone()),
            tokens: turn.stats.as_ref().and_then(|x| {
                // cache reads and writes aside: harnesses count them differently, and Drain watch only compares a
                // harness's runs with its own
                let t = x.input_tokens.unwrap_or(0) + x.output_tokens.unwrap_or(0);
                (t > 0).then_some(t)
            }),
            input_tokens: turn.stats.as_ref().and_then(|x| x.input_tokens),
            output_tokens: turn.stats.as_ref().and_then(|x| x.output_tokens),
            cache_tokens: turn.stats.as_ref().and_then(|x| x.cache_tokens),
            cache_read_tokens: turn.stats.as_ref().and_then(cache_reads),
            first: turn.idx == 0,
            inner: s.parent_id.is_some() || matches!(turn.by.as_deref(), Some("wisp" | "compact")),
        }));
        match turn.status {
            TurnStatus::Done => self.host.emit(Emitted::Task("task.finished", crate::host::fact(s, Some(&turn.id), "done", text, cost))),
            TurnStatus::Error => self.host.emit(Emitted::Task("task.failed", crate::host::fact(s, Some(&turn.id), "error", text, cost))),
            _ => {}
        }
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
    pub(crate) async fn finish_now(self: &Arc<Self>, sid: &str, tid: &str, why: &str) -> Result<()> {
        let e = Effect::Finish {
            text: why.to_owned(),
            is_error: true,
            stopped: false,
            stats: None,
            auth_failed: false,
            stop_reason: String::new(),
        };
        self.end_turn(sid, tid, &Head::default(), e, 0).await
    }

    /// A turn a crash or restart left running never finished: it shows stopped (v1 `restartReason`).
    pub(crate) async fn end_unfinished(self: &Arc<Self>, mut s: Session, mut t: Turn) -> Result<()> {
        let ending = Ending {
            stopped: true,
            interrupted: false,
            is_error: false,
            text: "",
            harness: "",
            changes: &[],
            reason: Some(("Stopped", "wisp restarted while this was running. Follow up to pick it back up.")),
        };
        let (status, p) = land::end_presentation(&ending, |_| wisp_runtime_api::model::Presentation::default());
        t.status = status;
        t.presentation = Some(p);
        t.ended_at = Some(t.started_at);
        s.state = wisp_runtime_api::model::SessionState::Review;
        self.persist(&mut s, vec![t]).await?;
        Ok(())
    }

    /// The run let go: the live entry goes, and the next queued follow-up starts (unless a Stop held them).
    pub(crate) async fn release_run(self: &Arc<Self>, sid: &str) {
        self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(sid);
        let next = {
            let _guard = self.task_lock(sid).await;
            let Ok(mut s) = self.repo.session(sid).await else {
                return;
            };
            let mut held = s.queue_held;
            let next = queue::next_after_release(&mut Queue { items: &mut s.queue, held: &mut held });
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

/// The first answer may name the task: its title is still the prompt's, and it isn't one of Compare's runs (they're
/// one ask, and one run's answer shouldn't name it: v1 runner.js `!session.groupId`).
fn title_auto(s: &Session) -> bool {
    crate::group::group_of(s).is_none()
        && s.ext.get("wisp.runtime").and_then(|v| v.get("titleAuto")).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

/// v1 runner.js `#refused`: a turn the model turned down says so, and the card offers another vendor's harness;
/// never for a subagent's run (its lead reads the answer as it is), nor a stopped one.
#[allow(clippy::too_many_arguments, reason = "the turn's end, as the refusal check reads it")]
fn refuse(
    turn: &mut Turn,
    p: &mut wisp_runtime_api::model::Presentation,
    text: &str,
    stop_reason: &str,
    is_error: bool,
    changes: usize,
    name: &str,
    h: Option<&dyn Harness>,
) {
    let ended = wisp_runtime_core::refused::Ended {
        text,
        stop_reason,
        is_error,
        changes,
        agent: &turn.agent,
        model: &turn.model,
        name,
        home: h.and_then(Harness::vendor),
    };
    if let Some((r, blocks)) = wisp_runtime_core::refused::refused(&ended, &p.blocks) {
        turn.refusal = Some(r);
        p.blocks = blocks;
    }
}

/// What a turn read from the cache: Claude's per-model `cacheRead` when it gives them (its `cache_tokens` adds the
/// writes), else the cached input (Codex's `cache_tokens` is reads alone).
fn cache_reads(st: &wisp_runtime_api::model::TurnStats) -> Option<u64> {
    let reads = st.models.as_ref().filter(|m| !m.is_empty()).and_then(|models| {
        models.values().map(|m| m.get("cacheRead").and_then(serde_json::Value::as_u64)).try_fold(0u64, |a, x| x.map(|x| a + x))
    });
    reads.or(st.cache_tokens)
}
