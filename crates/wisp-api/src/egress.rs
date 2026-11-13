//! Every row the sync stream sends passes its owner's `kernel.egress` view first (ADR-0050): snapshots, resumes,
//! windows and committed changes alike, so no client, peer or box ever gets what a view hides. A kind no view
//! names goes as it is, at the cost of one lookup.
use std::sync::Arc;

use wisp_kernel::egress::{RowView, VIEWS};
use wisp_protocol::{Change, PatchOp, Row};
use wisp_sync::ChangeRow;

/// Where the views come from: the kernel's plugins that are on, read at each use (a plugin switched off stops
/// viewing at once).
pub trait ViewSource: Send + Sync + 'static {
    fn views(&self) -> Vec<Arc<dyn RowView>>;
}

/// No plugin views anything (tests, a build without a kernel).
#[derive(Debug, Clone, Copy, Default)]
pub struct NoViews;

impl ViewSource for NoViews {
    fn views(&self) -> Vec<Arc<dyn RowView>> {
        Vec::new()
    }
}

impl ViewSource for wisp_kernel::Kernel {
    fn views(&self) -> Vec<Arc<dyn RowView>> {
        self.contributions(&VIEWS)
    }
}

fn owner<'a>(views: &'a [Arc<dyn RowView>], kind: &str) -> Option<&'a Arc<dyn RowView>> {
    views.iter().find(|v| v.kinds().contains(&kind))
}

/// Rows as a snapshot, resume or window sends them.
pub fn rows(views: &[Arc<dyn RowView>], rows: &mut [Row]) {
    if views.is_empty() {
        return;
    }
    // one batch per kind, so a view can read a row against the others (an output against its call)
    let mut kinds: Vec<String> = rows.iter().map(|r| r.e.clone()).collect();
    kinds.sort_unstable();
    kinds.dedup();
    for kind in kinds {
        let Some(v) = owner(views, &kind) else { continue };
        let mut batch: Vec<&mut serde_json::Value> = rows.iter_mut().filter(|r| r.e == kind).map(|r| &mut r.v).collect();
        v.rows(&kind, &mut batch);
    }
}

/// A committed change as the stream sends it.
pub fn change(views: &[Arc<dyn RowView>], c: &mut ChangeRow) {
    let Some(view) = owner(views, &c.entity) else { return };
    let kind = c.entity.as_str();
    match &mut c.change {
        Change::Upsert { v } => view.row(kind, v),
        Change::Append { v } => view.rows(kind, &mut v.iter_mut().collect::<Vec<_>>()),
        Change::Patch { ops } => {
            for op in ops {
                if let PatchOp::Add { path, value } | PatchOp::Replace { path, value } | PatchOp::Test { path, value } = op {
                    view.patch(kind, path, value);
                }
            }
        }
        Change::Del => {}
    }
}
