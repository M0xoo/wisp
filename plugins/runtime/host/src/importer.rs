//! v1's sessions (`~/.wisp/sessions/*.json`) into the store (plan §4.8), one transaction per file and
//! resumable by (file, mtime, size) through the store's import framework. A one-time migration
//! (`wisp import`, ADR-0031): nothing is written back to v1's files.
//!
//! `.light/` files are not read: they are v1's cache of the same data, and the full file is the truth.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use wisp_runtime_api::commands::ImportReport;
use wisp_runtime_core::import::{self, Imported};
use wisp_runtime_core::summary::{RowFacts, summarize};
use wisp_store::{ImportOptions, StoreError, Writer};

use crate::error::Result;
use crate::repo;
use crate::rows;
use crate::runtime::Runtime;

/// Writes one v1 file's rows (upserts: a file v1 rewrote since imports again over its old rows).
fn write_imported(w: &mut Writer<'_>, i: &Imported) -> std::result::Result<(), StoreError> {
    let internal = |e: crate::error::RuntimeError| StoreError::Internal(e.to_string());
    let last = i.turns.last().map(|t| &t.turn);
    let report = i
        .turns
        .iter()
        .rev()
        .map(|t| &t.turn)
        .find(|t| t.by.as_deref() != Some("compact"));
    let followups = i
        .turns
        .iter()
        .skip(1)
        .filter(|t| !matches!(t.turn.by.as_deref(), Some("wisp" | "compact")))
        .count();
    let facts = RowFacts {
        last,
        report,
        turn_count: u32::try_from(i.turns.len()).unwrap_or(u32::MAX),
        followups: u32::try_from(followups).unwrap_or(u32::MAX),
        ..RowFacts::default()
    };
    // its usage on the row from the start (v1 #785); a lead's subagents add theirs on its next write
    let mut fields = std::collections::BTreeMap::new();
    let parts: Vec<_> = i.turns.iter().map(|t| wisp_runtime_core::task_usage::turn_usage(&t.turn)).collect();
    crate::usage_row::put(&mut fields, &wisp_runtime_core::task_usage::own_of(&parts), &[]);
    let summary = summarize(&i.session, &facts, fields);
    repo::save_session(w, &i.session, &summary).map_err(internal)?;
    let mut seq = 1u64;
    for t in &i.turns {
        repo::save_turn(w, &t.turn).map_err(internal)?;
        let events: Vec<_> = t
            .steps
            .iter()
            .map(|(at, item)| {
                let row =
                    rows::v0_event_row(i.session.id.as_str(), t.turn.id.as_str(), seq, *at, item);
                seq += 1;
                row
            })
            .collect();
        if !events.is_empty() {
            w.append("event", events)?;
        }
    }
    Ok(())
}

impl Runtime {
    /// `runtime.import`: every v1 session file new or changed since its last import.
    pub async fn import_v1(self: &Arc<Self>, dir: Option<PathBuf>) -> Result<ImportReport> {
        let dir = dir.unwrap_or_else(|| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".wisp/sessions")
        });
        let handler: wisp_store::ImportHandler = Arc::new(|f, w| {
            let v: Value = f.json()?;
            let i = import::from_v1(&v)
                .map_err(|e| StoreError::Internal(format!("{}: {e}", f.name)))?;
            // a session imported earlier keeps its later events: its old log is replaced as a whole
            w.del("session", i.session.id.as_str())?;
            write_imported(w, &i)
        });
        let r = wisp_store::import_files(
            &self.repo.store,
            ImportOptions::new("runtime.sessions", dir),
            handler,
        )
        .await?;
        // the list cache learns the new rows; a re-imported task's turns were rewritten behind `persist`
        self.usage.clear();
        for s in self.repo.summaries().await? {
            self.lock_list().insert(s.id.0.clone(), Arc::new(s));
        }
        Ok(ImportReport {
            imported: u32::try_from(r.imported.len()).unwrap_or(u32::MAX),
            skipped: u32::try_from(r.unchanged).unwrap_or(u32::MAX),
            failed: r
                .failed
                .into_iter()
                .map(|(f, why)| format!("{f}: {why}"))
                .collect(),
        })
    }
}
