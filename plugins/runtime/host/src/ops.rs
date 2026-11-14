//! The commands that edit a task without running anything (rename, archive, read state, ext slots, the
//! queue's edits, notes, settle, delete) and the reads (get, list, turns, activity, presentation, search).
//!
//! size-ok: the non-running task commands are one table of thin store transactions

use std::sync::Arc;

use serde_json::Value;
use wisp_runtime_api::commands::{ActivityPage, CardArgs, Created, FollowedUp, ListArgs, QueueEditArgs};
use wisp_runtime_api::events::SessionDeleted;
use wisp_runtime_api::model::{Activity, Presentation, Session, SessionState, Step, Summary, Tone, Turn, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};
use wisp_runtime_core::blocks::{PARSER_VERSION, presentation};
use wisp_runtime_core::land;
use wisp_runtime_core::queue::{self, Queue, SendNow};

use crate::error::{Result, RuntimeError};
use crate::host::Emitted;
use crate::rows;
use crate::runtime::Runtime;

impl Runtime {
    /// Loads the task under its lock, lets `f` change it, writes it.
    pub(crate) async fn edit(self: &Arc<Self>, id: &str, f: impl FnOnce(&mut Session) -> Result<()>) -> Result<Session> {
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        f(&mut s)?;
        self.persist(&mut s, Vec::new()).await?;
        Ok(s)
    }

    pub async fn rename(self: &Arc<Self>, id: &str, title: &str) -> Result<()> {
        let title = title.trim().to_owned();
        if title.is_empty() {
            return Err(RuntimeError::Invalid("a title can't be empty".into()));
        }
        self.edit(id, |s| {
            s.title = title;
            // merged into runtime's slot: replacing it dropped what else it keeps (a channel's cap, an open ask)
            match s.ext.get_mut("wisp.runtime").and_then(serde_json::Value::as_object_mut) {
                Some(own) => {
                    own.insert("titleAuto".into(), false.into());
                }
                None => {
                    s.ext.insert("wisp.runtime".into(), serde_json::json!({ "titleAuto": false }));
                }
            }
            Ok(())
        })
        .await
        .map(drop)
    }

    pub async fn archive(self: &Arc<Self>, id: &str, archived: bool) -> Result<()> {
        self.edit(id, |s| {
            s.archived = archived;
            Ok(())
        })
        .await
        .map(drop)
    }

    /// The mode the task's next turns run in.
    pub async fn set_mode(self: &Arc<Self>, id: &str, mode: wisp_runtime_api::model::Mode) -> Result<()> {
        self.edit(id, |s| {
            s.mode = mode;
            Ok(())
        })
        .await
        .map(drop)
    }

    /// This task's runs lean ('on'), never ('off'), or as `runtime.leanRuns` says (None).
    pub async fn set_lean(self: &Arc<Self>, id: &str, lean: Option<String>) -> Result<()> {
        if lean.as_deref().is_some_and(|l| l != "on" && l != "off") {
            return Err(RuntimeError::Invalid("lean is on, off, or none to follow Settings".into()));
        }
        self.edit(id, |s| {
            s.lean = lean;
            Ok(())
        })
        .await
        .map(drop)
    }

    /// The harness the task's next turns run on (the turn running finishes where it is).
    pub async fn set_agent(self: &Arc<Self>, id: &str, agent: &str) -> Result<()> {
        if agent.trim().is_empty() {
            return Err(RuntimeError::Invalid("a harness id is needed".into()));
        }
        self.edit(id, |s| {
            agent.trim().clone_into(&mut s.agent);
            Ok(())
        })
        .await
        .map(drop)
    }

    /// Saved for later (`ext["wisp.runtime"].forLater`, the list's For later section), or taken out.
    pub async fn for_later(self: &Arc<Self>, id: &str, on: bool, at: Option<i64>) -> Result<()> {
        self.edit(id, |s| {
            let at = at.unwrap_or(s.updated_at);
            let slot = s.ext.entry("wisp.runtime".into()).or_insert_with(|| serde_json::json!({}));
            if let Some(o) = slot.as_object_mut() {
                if on {
                    o.insert("forLater".into(), serde_json::json!({ "at": at, "by": "you" }));
                } else {
                    o.remove("forLater");
                }
            }
            Ok(())
        })
        .await
        .map(drop)
    }

    /// The queue in this order (the composer's drag).
    pub async fn queue_order(self: &Arc<Self>, id: &str, order: &[String]) -> Result<()> {
        self.edit(id, |s| {
            let mut held = s.queue_held;
            queue::reorder(&mut Queue { items: &mut s.queue, held: &mut held }, order);
            Ok(())
        })
        .await
        .map(drop)
    }

    /// One queued follow-up taken out.
    pub async fn queue_cancel(self: &Arc<Self>, id: &str, item: &str) -> Result<()> {
        self.edit(id, |s| {
            let mut held = s.queue_held;
            queue::remove(&mut Queue { items: &mut s.queue, held: &mut held }, item);
            s.queue_held = held;
            Ok(())
        })
        .await
        .map(drop)
    }

    pub async fn mark_read(self: &Arc<Self>, id: &str, unread: bool) -> Result<()> {
        self.edit(id, |s| {
            s.unread = unread;
            Ok(())
        })
        .await
        .map(drop)
    }

    /// Mark done / Reopen. A running task can't be marked done: stop it first.
    pub async fn set_state(self: &Arc<Self>, id: &str, state: SessionState) -> Result<()> {
        let running = self.run_state(id) != queue::Run::Idle;
        self.edit(id, |s| {
            if running && state != SessionState::Running {
                return Err(RuntimeError::Conflict("it is still working: stop it first".into()));
            }
            s.state = state;
            s.unread = false;
            Ok(())
        })
        .await
        .map(|s| {
            if state == SessionState::Done {
                self.host.emit(crate::host::Emitted::Task("task.done", crate::host::fact(&s, None, "marked", "", None)));
            }
        })
    }

    /// A plugin writes its own ext slot only (the caller's plugin id is checked by the command handler).
    pub async fn set_ext(self: &Arc<Self>, id: &str, plugin: &str, value: Value) -> Result<()> {
        self.edit(id, |s| {
            if value.is_null() {
                s.ext.remove(plugin);
            } else {
                s.ext.insert(plugin.to_owned(), value);
            }
            Ok(())
        })
        .await
        .map(drop)
    }

    pub async fn turn_set_ext(self: &Arc<Self>, id: &str, turn: &str, plugin: &str, value: Value) -> Result<()> {
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let mut t = self.repo.turn(turn).await?;
        if t.session_id != s.id {
            return Err(RuntimeError::NoTurn(turn.to_owned()));
        }
        t.ext.insert(plugin.to_owned(), value);
        self.persist(&mut s, vec![t]).await.map(drop)
    }

    /// An `app` block's state on its turn (`ext["wisp.apps"][block]`); a block id is needed.
    pub async fn app_state(self: &Arc<Self>, id: &str, turn: &str, block: &str, state: Value) -> Result<()> {
        if block.trim().is_empty() {
            return Err(RuntimeError::Invalid("which block?".into()));
        }
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        let mut t = self.repo.turn(turn).await?;
        if t.session_id != s.id {
            return Err(RuntimeError::NoTurn(turn.to_owned()));
        }
        let slot = t.ext.entry("wisp.apps".to_owned()).or_insert_with(|| serde_json::json!({}));
        if !slot.is_object() {
            *slot = serde_json::json!({});
        }
        if let Some(o) = slot.as_object_mut() {
            o.insert(block.to_owned(), state);
        }
        self.persist(&mut s, vec![t]).await.map(drop)
    }

    /// A one-click command in the task's folder (`sh -c`, 2 min at most): its exit code and output.
    pub async fn exec(self: &Arc<Self>, id: &str, command: &str) -> Result<(i32, String)> {
        if command.trim().is_empty() {
            return Err(RuntimeError::Invalid("no command to run".into()));
        }
        let s = self.repo.session(id).await?;
        // a task with no folder has nowhere to run it: never the server's own folder
        let dir = wisp_runtime_api::paths::Folder::of(&s.cwd)
            .map_err(|e| RuntimeError::Invalid(format!("This task has no folder to run a command in ({e}).")))?;
        let opts = wisp_proc::ExecOpts {
            cwd: Some(dir.into_path()),
            timeout: Some(std::time::Duration::from_secs(120)),
            ..wisp_proc::ExecOpts::default()
        };
        let r =
            self.proc.exec("sh", &["-c".to_owned(), command.to_owned()], opts).await.map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let mut out = r.stdout_text();
        out.push_str(&r.stderr_text());
        let cut = out.len().saturating_sub(64 * 1024);
        let start = (cut..out.len()).find(|i| out.is_char_boundary(*i)).unwrap_or(out.len());
        Ok((r.exit.shell_code(), out[start..].to_owned()))
    }

    pub async fn delete(self: &Arc<Self>, id: &str) -> Result<()> {
        self.stop_run(id);
        let _guard = self.task_lock(id).await;
        let key = id.to_owned();
        // turns, events and queue items go with the row (ON DELETE CASCADE): one change row for the task
        let gone = self.repo.store.write(move |w| w.del("session", key.as_str())).await?;
        if !gone {
            return Err(RuntimeError::NoTask(id.to_owned()));
        }
        let row = self.lock_list().remove(id);
        self.usage.forget(id);
        self.env.forget(id);
        self.caps.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(id);
        // a subagent gone: its lead's usage stops counting it
        if let Some(lead) = row.and_then(|r| r.parent_id.clone()) {
            self.refresh_lead(lead);
        }
        // its kept pictures go with it (v1 store.delete: shots/<id>); a task id never climbs out of the folder
        if let Some(shots) = self.host.shots()
            && !id.is_empty()
            && !id.contains(['/', '\\', '.'])
        {
            let _ = tokio::fs::remove_dir_all(shots.join(id)).await;
        }
        self.host.emit(Emitted::Deleted(SessionDeleted { id: SessionId::from(id) }));
        Ok(())
    }

    /// The queue in the order given, with your edited texts; left-out items keep their place; `remove`
    /// takes items out; `held` sets or lifts a Stop's hold.
    pub async fn queue_edit(self: &Arc<Self>, a: QueueEditArgs) -> Result<()> {
        let s = self
            .edit(a.id.as_str(), |s| {
                let mut held = s.queue_held;
                let mut q = Queue { items: &mut s.queue, held: &mut held };
                for id in &a.remove {
                    queue::remove(&mut q, id);
                }
                let ids: Vec<String> = a.items.iter().map(|i| i.id.clone()).collect();
                queue::reorder(&mut q, &ids);
                for i in &a.items {
                    let before = q.items.iter().find(|x| x.id == i.id).map(|x| x.text.clone());
                    if before.is_some_and(|b| b != i.text) {
                        queue::edit_text(&mut q, &i.id, &i.text);
                    }
                }
                if let Some(h) = a.held {
                    held = h && !s.queue.is_empty();
                }
                s.queue_held = held;
                Ok(())
            })
            .await?;
        self.kick_if_released(s).await
    }

    async fn kick_if_released(self: &Arc<Self>, s: Session) -> Result<()> {
        if !s.queue_held {
            self.kick(s).await?;
        }
        Ok(())
    }

    pub async fn queue_merge(self: &Arc<Self>, id: &str, ids: &[String]) -> Result<()> {
        self.edit(id, |s| {
            let mut held = s.queue_held;
            if !queue::merge(&mut Queue { items: &mut s.queue, held: &mut held }, ids) {
                return Err(RuntimeError::Invalid("pick two or more of your queued follow-ups".into()));
            }
            Ok(())
        })
        .await
        .map(drop)
    }

    pub async fn queue_text(self: &Arc<Self>, id: &str, item: &str, text: &str) -> Result<()> {
        self.edit(id, |s| {
            let mut held = s.queue_held;
            if !queue::edit_text(&mut Queue { items: &mut s.queue, held: &mut held }, item, text) {
                return Err(RuntimeError::Invalid("no such follow-up of yours in the queue".into()));
            }
            Ok(())
        })
        .await
        .map(drop)
    }

    /// Send now (v1 `sendQueued`).
    pub async fn queue_send_now(self: &Arc<Self>, id: &str, item: &str) -> Result<FollowedUp> {
        let run = self.run_state(id);
        let mut start = None;
        let s = self
            .edit(id, |s| {
                let mut held = s.queue_held;
                let (plan, _) = queue::send_now(&mut Queue { items: &mut s.queue, held: &mut held }, run, item)
                    .ok_or_else(|| RuntimeError::Invalid("no such queued follow-up".into()))?;
                s.queue_held = held;
                match plan {
                    SendNow::Start(i) => start = Some(i),
                    SendNow::Interrupt => self.interrupt(id),
                    SendNow::ReleaseLinger => self.release_linger(id),
                    SendNow::Next => {}
                }
                Ok(())
            })
            .await?;
        match start {
            Some(i) => Ok(FollowedUp { turn_id: Some(self.start_turn(s, i).await?), queued: None }),
            None => Ok(FollowedUp { turn_id: None, queued: Some(item.to_owned()) }),
        }
    }

    /// A held turn: Start now, or Skip (it stays, stopped, saying what was skipped).
    pub async fn release(self: &Arc<Self>, id: &str, turn: &str, start: bool) -> Result<()> {
        let mut s = self.repo.session(id).await?;
        let mut t = self.repo.turn(turn).await?;
        if t.status != TurnStatus::Held {
            return Err(RuntimeError::Conflict("that turn isn't waiting".into()));
        }
        if start {
            self.release_held(&mut s).await?;
            self.persist(&mut s, Vec::new()).await?;
            return self.kick(s).await.map(drop);
        }
        let held = t.held.clone();
        let harness = self.harness(&t.agent).map(|h| h.info().name.clone()).unwrap_or_default();
        let label = held.as_ref().and_then(|h| h.data.get("label")).and_then(Value::as_str).unwrap_or("Its usage").to_owned();
        t.presentation = Some(land::skipped(held.as_ref().map_or("", |h| h.kind.as_str()), &label, &harness));
        t.status = TurnStatus::Stopped;
        t.ended_at = Some(self.now());
        s.state = SessionState::Done;
        s.unread = false;
        self.persist(&mut s, vec![t]).await.map(drop)
    }

    /// A line in a turn's activity from wisp itself (Auto's check, a repair, a hand-over).
    pub async fn note(self: &Arc<Self>, id: &str, turn: Option<&str>, label: &str, tone: Option<Tone>) -> Result<()> {
        let tid = match turn {
            Some(t) => t.to_owned(),
            None => self.repo.turns(id, None, Some(1)).await?.pop().map(|t| t.id.0).ok_or_else(|| RuntimeError::NoTurn("last".into()))?,
        };
        let a = Activity::Notice { text: label.chars().take(300).collect(), tone };
        self.add_row(id, &tid, a).await
    }

    /// A row in a turn's activity from outside its run (a note, a question, an answer, a delegation).
    pub(crate) async fn add_row(self: &Arc<Self>, id: &str, tid: &str, a: Activity) -> Result<()> {
        let seq = self.alloc_seq(id).await?;
        let row = rows::event_row(id, tid, seq, self.now(), &a)?;
        self.repo.store.write(move |w| w.append("event", vec![row]).map(drop)).await?;
        let step = Step { seq, t: self.now(), activity: a };
        self.host.emit(Emitted::Activity(wisp_runtime_api::events::TurnActivity {
            session_id: id.into(),
            turn_id: tid.into(),
            items: vec![step],
        }));
        Ok(())
    }

    /// An after-turn step is done with the task it held (v1 `settle`).
    pub async fn settle(self: &Arc<Self>, id: &str, quiet: bool) -> Result<()> {
        let running = self.run_state(id) != queue::Run::Idle;
        let _guard = self.task_lock(id).await;
        let mut s = self.repo.session(id).await?;
        if s.state != SessionState::Running {
            return Ok(());
        }
        let last = self.repo.turns(id, None, Some(1)).await?.pop();
        let sub = s.parent_id.is_some();
        let steps = self.host.after_steps();
        let end = |t: &Turn| wisp_runtime_api::points::TurnEnd {
            stopped: t.status == TurnStatus::Stopped,
            is_error: t.status == TurnStatus::Error,
        };
        let Some(l) = land::settle(running, quiet, sub, || {
            last.as_ref().and_then(|t| steps.iter().find(|a| a.wants(&s, t, end(t))).map(|a| a.id().to_owned()))
        }) else {
            return Ok(());
        };
        s.state = l.state;
        s.unread = l.unread;
        let summary = self.persist(&mut s, Vec::new()).await?;
        if l.notify
            && let Some(t) = last
        {
            self.host.emit(Emitted::Finished(wisp_runtime_api::events::TurnFinished {
                session_id: s.id.clone(),
                turn_id: t.id,
                status: t.status,
                interrupted: false,
                summary: (*summary).clone(),
            }));
        }
        Ok(())
    }

    /// `runtime.card`: a task that is only a message (a reminder that came due): one done turn, unread.
    pub async fn card(self: &Arc<Self>, a: CardArgs) -> Result<Created> {
        let now = self.now();
        let mut s = Session {
            id: SessionId::new(),
            title: a.title,
            agent: a.agent.unwrap_or_else(|| "wisp".into()),
            cwd: a.cwd.unwrap_or_default(),
            state: SessionState::Review,
            unread: true,
            created_at: now,
            updated_at: now,
            ext: a.ext,
            ..Session::default()
        };
        let p = Presentation { blocks: a.blocks, v: PARSER_VERSION, ..Presentation::default() };
        let t = Turn {
            id: TurnId::new(),
            session_id: s.id.clone(),
            prompt: a.prompt,
            agent: s.agent.clone(),
            status: TurnStatus::Done,
            started_at: a.started_at.unwrap_or(now),
            ended_at: Some(now),
            presentation: Some(p),
            ..Turn::default()
        };
        let tid = t.id.clone();
        let summary = self.persist(&mut s, vec![t]).await?;
        self.host.emit(Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(Created { id: s.id, turn_id: Some(tid) })
    }

    // ---------- reads ----------

    pub async fn get(&self, id: &str) -> Result<Session> {
        self.repo.session(id).await
    }

    /// The list, newest first, from memory (rows are rebuilt on write, never per read).
    pub fn list(&self, a: &ListArgs) -> Vec<Arc<Summary>> {
        let mut rows: Vec<Arc<Summary>> =
            self.lock_list().values().filter(|s| a.archived.is_none_or(|x| s.archived == x)).cloned().collect();
        rows.sort_unstable_by_key(|x| std::cmp::Reverse(x.updated_at));
        if let Some(n) = a.limit {
            rows.truncate(n as usize);
        }
        rows
    }

    pub async fn turns(&self, id: &str, before: Option<u32>, limit: Option<u32>) -> Result<Vec<Turn>> {
        self.repo.turns(id, before, limit).await
    }

    /// `runtime.cold`: the task's prompt cache and Compact now, as of now (`wisp_runtime_core::cold`).
    pub async fn cold(&self, id: &str) -> Result<wisp_runtime_api::commands::ColdOut> {
        let s = self.repo.session(id).await?;
        let turns = self.repo.turns(id, None, None).await?;
        let now = self.now();
        Ok(wisp_runtime_api::commands::ColdOut {
            cache: wisp_runtime_core::cold::cold_cache(&s, &turns, now),
            compact: wisp_runtime_core::cold::compact_offer(&s, &turns, now),
        })
    }

    pub async fn activity(&self, turn: &str, since: Option<u64>) -> Result<ActivityPage> {
        let items = self.repo.steps(turn, since).await?;
        Ok(ActivityPage { seq: items.last().map_or(since.unwrap_or(0), |s| s.seq), items })
    }

    /// A turn's presentation; one made by an older parser is rebuilt from its answer (plan §4.2).
    pub async fn presentation(self: &Arc<Self>, id: &str, idx: Option<u32>) -> Result<Option<Presentation>> {
        let turns = self.repo.turns(id, idx.map(|i| i + 1), Some(1)).await?;
        let Some(mut t) = turns.into_iter().last() else {
            return Ok(None);
        };
        let stale = t.presentation.as_ref().is_some_and(|p| p.v < PARSER_VERSION) && t.status == TurnStatus::Done;
        if let (true, Some(text)) = (stale, t.text.clone()) {
            t.presentation = Some(presentation(&text, &self.host.blocks()));
            let row = t.clone();
            self.repo
                .store
                .write(move |w| crate::repo::save_turn(w, &row).map_err(|e| wisp_store::StoreError::Internal(e.to_string())))
                .await?;
        }
        Ok(t.presentation)
    }

    pub async fn search(&self, q: &str, limit: u32) -> Result<Vec<wisp_runtime_api::model::SearchHit>> {
        let text = q.to_owned();
        let hits = self.repo.store.read_async(move |r| r.search(&text, Some(&["session", "turn"]), limit)).await?;
        let mut out = Vec::new();
        for h in hits {
            let (sid, tid) = if h.kind == "turn" {
                (self.repo.turn(&h.id).await.ok().map(|t| t.session_id.0), Some(h.id.clone()))
            } else {
                (Some(h.id.clone()), None)
            };
            let Some(sid) = sid else { continue };
            let Some(row) = self.lock_list().get(&sid).cloned() else {
                continue;
            };
            out.push(wisp_runtime_api::model::SearchHit {
                id: row.id.clone(),
                title: row.title.clone(),
                turn_id: tid.map(TurnId),
                snippet: row.preview.clone(),
                updated_at: row.updated_at,
            });
        }
        Ok(out)
    }
}
