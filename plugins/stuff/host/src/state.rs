//! The running plugin's state, shared by its commands and routes, and the few answers they share.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::{Value, json};
use wisp_kernel::http::Response;
use wisp_kernel::{Call, Ctx, WireError};
use wisp_stuff_api::commands::{PublishService, TaskFilesService, TaskInfo};
use wisp_stuff_api::{StuffItem, StuffView};

use crate::error::{Error, Result};
use crate::launch::Apps;
use crate::shelf::Shelf;

pub struct Stuff {
    pub shelf: Arc<Shelf>,
    pub apps: Arc<Apps>,
    /// v1 `~/.wisp/shots/<session>/<file>` → its hash in the CAS
    pub shots: RwLock<HashMap<String, String>>,
}

impl std::fmt::Debug for Stuff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stuff").finish_non_exhaustive()
    }
}

/// Set once the plugin has started (its rows are read): commands and routes before that are refused.
pub type Cell = Arc<OnceLock<Arc<Stuff>>>;

pub fn get(cell: &Cell) -> std::result::Result<Arc<Stuff>, WireError> {
    cell.get().cloned().ok_or_else(|| WireError::unavailable("My Stuff is starting"))
}

impl Stuff {
    pub async fn view(&self, it: &StuffItem) -> StuffView {
        self.shelf.view(it, self.apps.state(&it.id)).await
    }

    pub async fn views(&self) -> Vec<StuffView> {
        let mut out = Vec::new();
        for it in self.shelf.list() {
            out.push(self.view(&it).await);
        }
        out
    }

    /// Removed with everything it had: its server stops, its database worker lets go, its public
    /// link goes too (best effort).
    pub async fn remove(&self, ctx: &Ctx, call: &Call, id: &str) -> Result<bool> {
        let Some(it) = self.shelf.get(id) else { return Ok(false) };
        self.apps.stop(id);
        if it.published.is_some()
            && let Ok(p) = ctx.use_service::<PublishService>()
        {
            let _ = p.unpublish(call, id).await;
        }
        self.apps.appdb.release(&self.shelf.data_file(id));
        self.shelf.remove(id).await
    }

    pub async fn reset_data(&self, id: &str) -> Result<StuffItem> {
        self.apps.appdb.release(&self.shelf.data_file(id));
        self.shelf.reset_data(id).await
    }
}

/// The task an item is for, when the runtime says (no runtime: none).
pub async fn task(ctx: &Ctx, call: &Call, id: &str) -> Option<TaskInfo> {
    let t = ctx.use_service::<TaskFilesService>().ok()?;
    t.task(call, id).await.ok().flatten()
}

pub fn json(status: u16, body: Value) -> Response {
    Response::Json { status, body }
}

/// v1's error shape: `{ error }` with its status.
pub fn refusal(e: impl Into<WireError>) -> Response {
    let w: WireError = e.into();
    json(w.status(), json!({ "error": w.message }))
}

/// A route's answer: its body, or v1's `{ error }`.
pub fn answer(r: Result<Response>) -> wisp_kernel::Result<Response> {
    Ok(r.unwrap_or_else(|e| match e {
        Error::Bad(b) => json(b.status, json!({ "error": b.message })),
        other => refusal(other),
    }))
}

pub fn ok_json(v: impl serde::Serialize, status: u16) -> Result<Response> {
    Ok(json(status, serde_json::to_value(v)?))
}
