//! Watch (v1 server/watch.js, F-page-32): `runtime.agent.watch`, the `wisp_watch` tool's owner. The page an agent
//! keeps beside its own task: its state in `watch`, its HTML in `watch_page` (written only when the page changed),
//! both on the task's topic, and a marker on the task's row (`watch`: title, caption, seq, rev, closed) written in
//! the same transaction, so the task's More offers Watch. The decisions are in `wisp_runtime_core::watch`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{Setup, WireError};
use wisp_runtime_api::commands as c;
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_api::points::{SUMMARY, SummaryField};
use wisp_runtime_core::watch::{self, Watch};
use wisp_store::Row;

use crate::plugin::{Slot, rt};
use crate::schema::{WATCH, WATCH_PAGE};

fn row(id: &str, body: Value) -> Row {
    let mut r = Row::new();
    r.insert("id".into(), json!(id));
    r.insert("body".into(), body);
    r
}

/// The task's row carries its watch's marker (`ext["wisp.runtime"].watch`) as `watch`.
struct Marker;

impl SummaryField for Marker {
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn plugin(&self) -> &str {
        "wisp.runtime"
    }
    fn fields(&self, session: &Session, _last: Option<&Turn>, out: &mut BTreeMap<String, Value>) {
        if let Some(w) = session.ext.get("wisp.runtime").and_then(|o| o.get("watch")).filter(|w| w.is_object()) {
            out.insert("watch".into(), w.clone());
        }
    }
}

pub fn setup(s: &mut Setup, slot: &Slot) {
    let m: Arc<dyn SummaryField> = Arc::new(Marker);
    s.contribute(&SUMMARY, m);
    let sl = slot.clone();
    s.command::<c::AgentWatch, _, _>(move |_ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            Ok(match r.agent_watch(a).await {
                Ok(text) => c::AgentText { text: Some(text), error: None },
                Err(e) => c::AgentText { text: None, error: Some(e) },
            })
        }
    });
}

impl crate::runtime::Runtime {
    /// One `wisp_watch` call on task `a.session`: what the agent reads back, or what it did wrong.
    ///
    /// # Errors
    /// The refusal in words the agent can act on (no such task, a bad action, a page too large).
    pub async fn agent_watch(self: &Arc<Self>, a: c::AgentWatchArgs) -> Result<String, String> {
        let r = self;
        let id = a.session.clone();
        let _guard = r.task_lock(&id).await;
        let mut s = r.repo.session(&id).await.map_err(|_| format!("No wisp task `{id}` on this computer."))?;
        let key = id.clone();
        let prev: Option<Watch> = r
            .repo
            .store
            .read_async(move |rd| Ok(rd.get(WATCH.kind, key.as_str())?.and_then(|row| row.get("body").cloned()).and_then(|b| serde_json::from_value(b).ok())))
            .await
            .map_err(|e| WireError::from(e).message)?;
        // the one file this call reads (a path page, or its reload), read before deciding: the core does no I/O
        let mut files = BTreeMap::new();
        if let Some(p) = watch::page_path(prev.as_ref(), &a.body, &s.cwd) {
            let meta = tokio::fs::metadata(&p).await.ok();
            if meta.as_ref().is_some_and(|m| m.len() > watch::MAX_HTML as u64) {
                return Err(format!("The page is larger than {} MB.", watch::MAX_HTML / 1_000_000));
            }
            if let Ok(html) = tokio::fs::read_to_string(&p).await {
                files.insert(p, html);
            }
        }
        let done = watch::apply(prev.as_ref(), &a.body, &s.cwd, &|p| files.get(p).cloned(), r.now())?;
        let own = s.ext.entry("wisp.runtime".into()).or_insert_with(|| json!({}));
        if let Some(o) = own.as_object_mut() {
            o.insert("watch".into(), watch::marker(&done.watch));
        }
        let (wid, body, html) = (id.clone(), serde_json::to_value(&done.watch).unwrap_or(Value::Null), done.html);
        r.persist_with(&mut s, Vec::new(), move |w| {
            w.upsert(WATCH.kind, row(&wid, body))?;
            if let Some(h) = html {
                w.upsert(WATCH_PAGE.kind, row(&wid, json!({ "html": h })))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(done.text)
    }
}
