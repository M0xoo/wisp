//! The .env values each task's turns read (ADR-0050), so a value read in one turn and quoted in a later one is
//! flagged too: each turn's head is seeded with its task's. In memory only (never stored, never logged; `EnvValues`'
//! `Debug` says how many). A task not in memory (after a start) is read back from its stored steps once.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use serde_json::json;
use wisp_runtime_core::activity::EnvValues;
use wisp_store::{Cond, Query};

use crate::error::Result;
use crate::runtime::Runtime;

/// The event kinds that can show a .env file's text: v2's call and output, and v1's imported calls (`read`, `run`…,
/// their `output` on the row).
const CALL_KINDS: &[&str] =
    &["tool", "tool_output", "read", "edit", "run", "search", "web", "agent", "plan", "wait", "ask", "answer", "background"];

#[derive(Debug, Default)]
pub(crate) struct EnvKnown {
    values: Mutex<HashMap<String, EnvValues>>,
    /// turn → task, for each turn written since the start: a patch on the stream names only its row
    turns: Mutex<HashMap<String, String>>,
}

impl EnvKnown {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, EnvValues>> {
        self.values.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn turns(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.turns.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub(crate) fn forget(&self, id: &str) {
        self.lock().remove(id);
        self.turns().retain(|_, sid| sid != id);
    }
    /// What task `id`'s turns read, when it is in memory (no store read: the sync stream's view asks).
    pub(crate) fn get(&self, id: &str) -> Option<EnvValues> {
        self.lock().get(id).cloned()
    }
    /// Turn `tid` is task `sid`'s: noted as it is written, before its patches leave.
    pub(crate) fn note_turn(&self, tid: &str, sid: &str) {
        let mut t = self.turns();
        if t.get(tid).is_none_or(|s| s != sid) {
            t.insert(tid.to_owned(), sid.to_owned());
        }
    }
    /// The task of a turn written since the start.
    pub(crate) fn task_of(&self, tid: &str) -> Option<String> {
        self.turns().get(tid).cloned()
    }
}

impl Runtime {
    /// What task `sid`'s earlier turns read, to seed its next turn's head with.
    pub(crate) async fn env_known(&self, sid: &str) -> Result<EnvValues> {
        if let Some(v) = self.env.lock().get(sid) {
            return Ok(v.clone());
        }
        let kinds = CALL_KINDS.iter().map(|k| json!(k)).collect();
        let q = Query::new().eq("session_id", sid).cond("kind", Cond::In(kinds)).asc("seq");
        let rows = self.repo.store.read_async(move |r| r.query("event", &q)).await?;
        let steps: Vec<_> = rows.iter().filter_map(crate::rows::step_of).map(|s| s.activity).collect();
        // a turn that ran meanwhile added its own; keep both
        let mut all = self.env.lock();
        let known = all.entry(sid.to_owned()).or_default();
        known.extend(&EnvValues::of_steps(&steps));
        Ok(known.clone())
    }

    /// A turn's head knew these at its end: the task's next turn starts from them. Only a task whose stored reads
    /// were read back: one whose read failed stays unknown, so its next turn reads them again.
    pub(crate) fn env_remember(&self, sid: &str, values: &EnvValues) {
        if let Some(known) = self.env.lock().get_mut(sid) {
            known.extend(values);
        }
    }
}
