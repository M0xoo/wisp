//! The rest of v1 runner.js's surface, over the same session, turn and queue primitives: an agent's
//! questions (`ask`, `answer`, `pollAnswer`) and live approvals, blocked actions allowed for one
//! follow-up, /btw side questions, compacting, subagents (`delegate`, `results`), forking, `quick`
//! side runs, a signed-out turn's sign-in and rerun, a turn billed past its plan, and the harnesses
//! as Settings → Agents shows them. One module per surface; this one holds the helpers they share.

mod agents;
mod ask;
mod blocked;
mod btw;
mod delegate;
mod fork;
mod quick;
mod sandbox;
mod sign_in;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;
use wisp_runtime_api::TurnId;
use wisp_runtime_api::model::{Activity, Session, ToolKind, Turn, TurnStatus};

use crate::error::{Result, RuntimeError};
use crate::runtime::Runtime;

pub(crate) use ask::ask_id;
pub(crate) use sign_in::SignIn;

/// How often a wait on an answer or on subagents looks again.
const POLL_MS: u64 = 250;
const SLOT: &str = "wisp.runtime";

fn slot(s: &Session) -> Option<&serde_json::Map<String, Value>> {
    s.ext.get(SLOT)?.as_object()
}

fn str_at(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Appends to a list in the slot (made if missing).
fn push(m: &mut serde_json::Map<String, Value>, k: &str, v: Value) {
    match m.get_mut(k) {
        Some(Value::Array(a)) => a.push(v),
        _ => {
            m.insert(k.into(), Value::Array(vec![v]));
        }
    }
}

fn tool_row(tool: ToolKind, label: String) -> Activity {
    Activity::Tool { tool, label, file: None, detail: None, call_id: None, output: None, title: None }
}

/// Runs `f` on runtime's own ext slot (made an object if it wasn't one), then puts it back.
fn with_slot<R>(ext: &mut BTreeMap<String, Value>, f: impl FnOnce(&mut serde_json::Map<String, Value>) -> R) -> R {
    let mut m = match ext.remove(SLOT) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let out = f(&mut m);
    ext.insert(SLOT.into(), Value::Object(m));
    out
}

impl Runtime {
    /// `runtime.held`: the task's held turn (its last) started or skipped.
    pub async fn held(self: &Arc<Self>, id: &str, start: bool) -> Result<()> {
        let turn = self
            .last_turn(id)
            .await?
            .filter(|t| t.status == TurnStatus::Held)
            .ok_or_else(|| RuntimeError::Conflict("nothing is held on this task".into()))?;
        self.release(id, turn.id.as_str(), start).await
    }

    async fn last_turn(&self, id: &str) -> Result<Option<Turn>> {
        Ok(self.repo.turns(id, None, Some(1)).await?.pop())
    }

    async fn turn_of(&self, id: &str, turn: Option<&TurnId>) -> Result<Turn> {
        match turn {
            Some(t) => self.repo.turn(t.as_str()).await,
            None => self.last_turn(id).await?.ok_or_else(|| RuntimeError::NoTurn(id.to_owned())),
        }
    }
}
