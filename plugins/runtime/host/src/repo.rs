//! The store side of wisp.runtime: reads run on the blocking pool (`read_async`), writes are closures on
//! the writer thread, one transaction each, every row recorded in the change feed. Nothing here blocks an
//! async worker.

use serde_json::Value;
use wisp_runtime_api::model::{QueueItem, Session, Step, Summary, Turn};
use wisp_store::{Cond, Query, Store, Writer};

use crate::error::{Result, RuntimeError};
use crate::rows;

/// Reads a whole task: its row and its queue.
pub fn load_session(r: &wisp_store::Reader<'_>, id: &str) -> wisp_store::Result<Option<Session>> {
    let Some(row) = r.get("session", id)? else {
        return Ok(None);
    };
    let queue = r
        .query("queue_item", &Query::new().eq("session_id", id).asc("pos"))?
        .iter()
        .filter_map(rows::queue_of)
        .collect();
    Ok(rows::session_of(row, queue).ok())
}

/// Writes a task's row (with its list row) and its queue, in the writer's transaction.
pub fn save_session(w: &mut Writer<'_>, s: &Session, summary: &Summary) -> Result<()> {
    w.upsert("session", rows::session_row(s, summary)?)?;
    save_queue(w, s)
}

/// The queue table as the task's queue: items gone are deleted, the rest upserted in order. Untouched
/// rows still write (their `pos` may be the same): the queue is short, a handful of rows at most.
pub fn save_queue(w: &mut Writer<'_>, s: &Session) -> Result<()> {
    let id = s.id.as_str();
    let had = w.query(
        "queue_item",
        &Query::new()
            .select(&["id", "pos", "body"])
            .eq("session_id", id),
    )?;
    for row in &had {
        let rid = row.get("id").and_then(Value::as_str).unwrap_or_default();
        if !s.queue.iter().any(|q| q.id == rid) {
            w.del("queue_item", rid)?;
        }
    }
    for (pos, q) in s.queue.iter().enumerate() {
        let row = rows::queue_row(id, pos, q)?;
        let same = had.iter().any(|h| {
            h.get("id") == row.get("id")
                && h.get("pos") == row.get("pos")
                && h.get("body") == row.get("body")
        });
        if !same {
            w.upsert("queue_item", row)?;
        }
    }
    Ok(())
}

pub fn save_turn(w: &mut Writer<'_>, t: &Turn) -> Result<()> {
    w.upsert("turn", rows::turn_row(t)?)?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Repo {
    pub store: Store,
}

impl Repo {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn session(&self, id: &str) -> Result<Session> {
        let key = id.to_owned();
        self.store
            .read_async(move |r| load_session(r, &key))
            .await?
            .ok_or_else(|| RuntimeError::NoTask(id.to_owned()))
    }

    /// The task's turns, newest last: `limit` of them before index `before` (all when not given).
    pub async fn turns(
        &self,
        id: &str,
        before: Option<u32>,
        limit: Option<u32>,
    ) -> Result<Vec<Turn>> {
        let mut q = Query::new().eq("session_id", id).desc("idx");
        if let Some(b) = before {
            q = q.cond("idx", Cond::Lt(b.into()));
        }
        if let Some(n) = limit {
            q = q.limit(n.into());
        }
        let rows = self.store.read_async(move |r| r.query("turn", &q)).await?;
        let mut turns = rows.iter().map(rows::turn_of).collect::<Result<Vec<_>>>()?;
        turns.reverse();
        Ok(turns)
    }

    /// One turn by id.
    pub async fn turn(&self, id: &str) -> Result<Turn> {
        let key = id.to_owned();
        let row = self
            .store
            .read_async(move |r| r.get("turn", key.as_str()))
            .await?;
        row.as_ref()
            .map(rows::turn_of)
            .transpose()?
            .ok_or_else(|| RuntimeError::NoTurn(id.to_owned()))
    }

    /// A turn's steps after `since` (its per-session seq), oldest first.
    pub async fn steps(&self, turn: &str, since: Option<u64>) -> Result<Vec<Step>> {
        let mut q = Query::new().eq("turn_id", turn).asc("seq");
        if let Some(s) = since {
            q = q.cond("seq", Cond::Gt(s.into()));
        }
        let rows = self.store.read_async(move |r| r.query("event", &q)).await?;
        Ok(rows.iter().filter_map(rows::step_of).collect())
    }

    /// The next free seq of a task's event log.
    pub async fn next_seq(&self, session: &str) -> Result<u64> {
        let q = Query::new()
            .select(&["seq"])
            .eq("session_id", session)
            .desc("seq")
            .limit(1);
        let rows = self.store.read_async(move |r| r.query("event", &q)).await?;
        Ok(rows
            .first()
            .and_then(|r| r.get("seq"))
            .and_then(Value::as_u64)
            .map_or(1, |s| s + 1))
    }

    /// Every list row, from the cached `summary` column only (a projection: one small JSON per task).
    pub async fn summaries(&self) -> Result<Vec<Summary>> {
        let q = Query::new().select(&["id", "summary"]).desc("updated_at");
        let rows = self
            .store
            .read_async(move |r| r.query("session", &q))
            .await?;
        Ok(rows.iter().filter_map(rows::summary_of).collect())
    }

    /// Every task (no queue), newest first: for history queries, which read each task's spec.
    pub async fn sessions(&self) -> Result<Vec<Session>> {
        let q = Query::new().desc("created_at");
        let rows = self.store.read_async(move |r| r.query("session", &q)).await?;
        Ok(rows.into_iter().filter_map(|r| rows::session_of(r, Vec::new()).ok()).collect())
    }

    /// Ids of tasks whose last turn was running when wisp stopped (crash or restart).
    pub async fn running_turns(&self) -> Result<Vec<Turn>> {
        let q = Query::new().eq("status", "running");
        let rows = self.store.read_async(move |r| r.query("turn", &q)).await?;
        rows.iter().map(rows::turn_of).collect()
    }

    pub async fn queue_of(&self, id: &str) -> Result<Vec<QueueItem>> {
        Ok(self.session(id).await?.queue)
    }
}
