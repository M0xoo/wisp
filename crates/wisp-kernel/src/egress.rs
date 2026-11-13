//! Rows as they leave the server (ADR-0050). The sync stream (snapshots, resumes, windows and every committed
//! change) passes each row of a kind a plugin owns through that plugin's [`RowView`] before any client, peer or
//! box sees it: wisp.runtime hides .env values there. The store keeps rows as they are; only what leaves changes.
//! Additive (2026-11-13).

use serde_json::Value;

/// A plugin's view of its own kinds' rows on the way out. Called for every row and patch of those kinds that
/// leaves: keep it a pass over the row, no IO.
pub trait RowView: Send + Sync + 'static {
    /// the entity kinds it views (its own)
    fn kinds(&self) -> &'static [&'static str];
    /// a whole row (`v`, the row's columns) as it leaves
    fn row(&self, kind: &str, v: &mut Value);
    /// rows of one kind that leave together (a snapshot, a window, one commit's appends): a view that reads one row
    /// against another (an output against its call) does it here; by default each row alone
    fn rows(&self, kind: &str, rows: &mut [&mut Value]) {
        for v in rows.iter_mut() {
            self.row(kind, v);
        }
    }
    /// one RFC 6902 op's value, landing at `path` (a JSON pointer into the row)
    fn patch(&self, kind: &str, path: &str, v: &mut Value);
}

pub const VIEWS: crate::Point<dyn RowView> = crate::Point::new("kernel.egress", 1);
