//! A task's mode cap at the runtime (F-chan-10; the rules are `wisp_runtime_core::cap`): kept in runtime's slot as
//! `capped: { mode }`, noted in memory as the row is written so the edge can name a capped task's agent
//! `agent:capped` without waiting, checked when anything asks the task for a mode, and held to on every turn.

use std::sync::Arc;

use wisp_kernel::WireError;
use wisp_runtime_api::model::{Mode, Session};
use wisp_runtime_core::agent_task::mode_id;
use wisp_runtime_core::cap::{self, Asked};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

const SLOT: &str = "wisp.runtime";

/// The cap a task carries, if any.
pub(crate) fn cap_of(s: &Session) -> Option<Mode> {
    cap::of(s.ext.get(SLOT))
}

impl Runtime {
    /// Keeps the in-memory cap for `s` in step with its row.
    pub(crate) fn note_cap(&self, s: &Session) {
        let mut caps = self.caps.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match cap_of(s) {
            Some(c) => caps.insert(s.id.0.clone(), c),
            None => caps.remove(s.id.as_str()),
        };
    }

    /// The set a task's agent speaks with at the edge: `agent:capped` for an Edits cap, `agent:capped:<mode>`
    /// for another; None: not capped (`agent:session`).
    pub fn agent_set(&self, id: &str) -> Option<String> {
        let caps = self.caps.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        caps.get(id).map(|m| if *m == Mode::Edits { "agent:capped".to_owned() } else { format!("agent:capped:{}", mode_id(*m)) })
    }

    /// `set` asks task `id` for `mode` (a follow-up's, a mode switch): within its cap, fine; above it, refused,
    /// unless the user asked, which takes the cap off this task (v1 capped.js).
    pub async fn mode_asked(self: &Arc<Self>, id: &str, mode: Mode, set: &str) -> Result<()> {
        let s = self.repo.session(id).await?;
        match cap::ask(mode, cap_of(&s), set) {
            Asked::Within => Ok(()),
            Asked::Refused(why) => Err(RuntimeError::Wire(WireError::forbidden(why))),
            Asked::Lift => {
                tracing::info!(task = id, "runtime: the user lifted the task's mode cap");
                self.edit(id, |s| {
                    if let Some(own) = s.ext.get_mut(SLOT).and_then(serde_json::Value::as_object_mut) {
                        own.remove("capped");
                    }
                    Ok(())
                })
                .await
                .map(drop)
            }
        }
    }
}
