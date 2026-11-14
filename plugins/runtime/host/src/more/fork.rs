//! Compacting, rerunning a signed-out turn, adopting a shared or outside session, and forking.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::commands::{FollowUpArgs, FollowedUp, ForkArgs, RerunArgs};
use wisp_runtime_api::model::{Session, SessionState, Turn, TurnStatus};
use wisp_runtime_api::{SessionId, TurnId};

use super::{SLOT, with_slot};
use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

impl Runtime {
    /// `runtime.compact`: `/compact` as the next turn, by wisp (it doesn't count as your follow-up).
    pub async fn compact(self: &Arc<Self>, id: &SessionId) -> Result<FollowedUp> {
        self.follow_up(FollowUpArgs {
            id: id.clone(),
            text: "/compact".into(),
            queue: Some(true),
            by: Some("compact".into()),
            ..FollowUpArgs::default()
        })
        .await
    }

    /// `runtime.rerun` (v1 `rerunSignedOut`): a signed-out turn's request again, once, in the same
    /// conversation, on another account if one is given.
    pub async fn rerun(self: &Arc<Self>, a: RerunArgs) -> Result<FollowedUp> {
        let none = FollowedUp { turn_id: None, queued: None };
        let t = {
            let _g = self.task_lock(a.id.as_str()).await;
            let mut s = self.repo.session(a.id.as_str()).await?;
            let Some(mut t) = self.last_turn(a.id.as_str()).await?.filter(|t| t.id == a.turn_id) else { return Ok(none) };
            let signed_out = t.ext.get(SLOT).and_then(|x| x.get("authFailed")).and_then(Value::as_bool).unwrap_or(false);
            let again = t.ext.get(SLOT).and_then(|x| x.get("rerun")).is_some();
            if !signed_out || again || t.status != TurnStatus::Error || s.state == SessionState::Running || !s.queue.is_empty() {
                return Ok(none);
            }
            // once only: the mark is saved before anything is sent (two tabs, a phone, a restart)
            with_slot(&mut t.ext, |m| m.insert("rerun".into(), json!(self.now())));
            if let Some(acc) = a.account.filter(|x| !x.is_empty()) {
                s.account = Some(acc);
            }
            self.persist(&mut s, vec![t.clone()]).await?;
            t
        };
        // the run goes through `before:run` like any turn: the guard may hold it (v1's `guard.check`)
        let sent = self
            .follow_up(FollowUpArgs {
                id: a.id.clone(),
                text: t.prompt.clone(),
                attachments: t.attachments.clone(),
                queue: Some(false),
                by: t.by.clone(),
                ..FollowUpArgs::default()
            })
            .await;
        if sent.is_err() {
            // it never went: the card offers it again (v1 runner.js:2036)
            let _g = self.task_lock(a.id.as_str()).await;
            let mut s = self.repo.session(a.id.as_str()).await?;
            let mut t = self.repo.turn(t.id.as_str()).await?;
            with_slot(&mut t.ext, |m| m.remove("rerun"));
            self.persist(&mut s, vec![t]).await?;
        }
        sent
    }

    /// `runtime.adopt`: a read-only task holding someone else's turns (a `full` share); fork it to go on.
    pub async fn adopt(self: &Arc<Self>, a: wisp_runtime_api::spec::AdoptArgs) -> Result<wisp_runtime_api::commands::Created> {
        let now = self.now();
        let mut s = Session {
            id: SessionId::new(),
            title: a.title,
            agent: a.agent,
            cwd: a.cwd,
            state: SessionState::Done,
            created_at: now,
            updated_at: now,
            ..Session::default()
        };
        for (k, v) in a.ext {
            s.ext.insert(k, v);
        }
        let spec = serde_json::to_value(&a.spec).unwrap_or_default();
        // an outside session stays live: its follow-ups continue it in its CLI (ADR-0035)
        if a.resume_id.is_some() {
            s.resume_id.clone_from(&a.resume_id);
        } else {
            with_slot(&mut s.ext, |m| m.insert("readOnly".into(), json!(true)));
        }
        with_slot(&mut s.ext, |m| m.insert("spec".into(), spec));
        let copies: Vec<Turn> = a
            .turns
            .into_iter()
            .filter_map(|t| serde_json::from_value::<Turn>(t).ok())
            .map(|t| Turn { id: TurnId::new(), session_id: s.id.clone(), ..t })
            .collect();
        if copies.is_empty() {
            return Err(RuntimeError::Invalid("a shared task to import has its turns (a full share)".into()));
        }
        let summary = self.persist(&mut s, copies).await?;
        self.host.emit(crate::host::Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(wisp_runtime_api::commands::Created { id: s.id, turn_id: None })
    }

    /// An outside session already adopted (ADR-0035: never twice): its task, with the session's turns past
    /// the ones it has appended. None when no task came from it.
    pub async fn readopt(
        self: &Arc<Self>,
        session: &str,
        a: &wisp_runtime_api::spec::AdoptArgs,
    ) -> Result<Option<wisp_runtime_api::commands::Created>> {
        // adopted from it before, or wisp's own task that ran as it (`wisp open` comes back to it)
        let found = self.repo.sessions().await?.into_iter().find(|s| {
            s.ext.get("wisp.adopted").and_then(|v| v.get("session")).and_then(Value::as_str) == Some(session)
                || s.resume_id.as_deref() == Some(session)
        });
        let Some(mut s) = found else { return Ok(None) };
        let have = self.repo.turns(s.id.as_str(), None, None).await?.len();
        let new: Vec<Turn> = a
            .turns
            .iter()
            .skip(have)
            .filter_map(|t| serde_json::from_value::<Turn>(t.clone()).ok())
            .enumerate()
            .map(|(i, t)| Turn { id: TurnId::new(), session_id: s.id.clone(), idx: u32::try_from(have + i).unwrap_or(u32::MAX), ..t })
            .collect();
        if !new.is_empty() {
            s.updated_at = self.now();
            self.persist(&mut s, new).await?;
        }
        Ok(Some(wisp_runtime_api::commands::Created { id: s.id, turn_id: None }))
    }

    /// `runtime.fork`: a new task with this one's turns up to `turn_id`, resuming a copy of its conversation.
    pub async fn fork(self: &Arc<Self>, a: ForkArgs) -> Result<wisp_runtime_api::commands::Created> {
        let src = self.repo.session(a.id.as_str()).await?;
        let upto = self.turn_of(a.id.as_str(), a.turn_id.as_ref()).await?;
        let turns: Vec<Turn> = self.repo.turns(a.id.as_str(), None, None).await?.into_iter().filter(|t| t.idx <= upto.idx).collect();
        let now = self.now();
        let mut s = Session {
            id: SessionId::new(),
            title: a.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| format!("{} (fork)", src.title)),
            agent: src.agent.clone(),
            model: src.model.clone(),
            effort: src.effort.clone(),
            account: src.account.clone(),
            mode: src.mode,
            cwd: src.cwd.clone(),
            dirs: src.dirs.clone(),
            state: SessionState::Review,
            resume_id: upto.resume_id.clone().or_else(|| src.resume_id.clone()),
            created_at: now,
            updated_at: now,
            ..Session::default()
        };
        with_slot(&mut s.ext, |m| m.insert("forkOf".into(), json!({ "id": src.id, "turnId": upto.id })));
        // a capped task's fork stays under its cap (v1 capped.js: copied to whatever it starts)
        if let Some(cap) = src.ext.get("wisp.runtime").and_then(|o| o.get("capped")).filter(|c| !c.is_null()).cloned() {
            with_slot(&mut s.ext, |m| m.insert("capped".into(), cap));
        }
        with_slot(&mut s.ext, |m| m.insert("next".into(), json!({ "fork": true })));
        let copies: Vec<Turn> = turns.into_iter().map(|t| Turn { id: TurnId::new(), session_id: s.id.clone(), ..t }).collect();
        let summary = self.persist(&mut s, copies).await?;
        self.host.emit(crate::host::Emitted::Created(wisp_runtime_api::events::SessionCreated { session: (*summary).clone() }));
        Ok(wisp_runtime_api::commands::Created { id: s.id, turn_id: None })
    }
}
