//! wisp-store (ADR-0004, plan §4): one SQLite file (rusqlite, bundled SQLite, WAL, `synchronous=NORMAL`,
//! STRICT tables, foreign keys on, cached prepared statements) with migrations per owner, one write path
//! that records every row in the change feed, idempotent mutations, content-addressed blobs, FTS5,
//! retention, write coalescing, atomic JSON files and the v1 import framework.
//!
//! The public API is documented in `README.md`; plugin crates code against it, so it only grows.
//!
//! ```no_run
//! # async fn demo() -> wisp_store::Result<()> {
//! use std::sync::Arc;
//! use wisp_store::{Location, Store, SystemClock, row};
//! let store = Store::open(Location::Path("wisp.db".into()), Arc::new(SystemClock))?;
//! store.write(|w| { w.upsert("setting", row!({"key": "theme", "value": "dark", "locked_by": null}))?; Ok(()) }).await?;
//! # Ok(()) }
//! ```

mod blob;
mod changes;
mod clock;
mod coalescer;
mod commit;
mod entity;
mod error;
mod import;
mod json_file;
mod json_out;
pub mod json_patch;
mod listeners;
mod migrate;
mod query;
mod reads;
mod retention;
mod row;
mod schema;
mod search;
mod store;
mod thread;
mod writer;

pub use blob::{BlobInfo, Codec, GcResult, INLINE_MAX, Owner, hash_of};
pub use changes::{ChangeOp, ChangeRow, Delta, MAX_LIMIT};
pub use clock::{ManualClock, SystemClock};
pub use coalescer::{Buffered, Coalescer, CoalescerOptions, OnError};
pub use entity::{Col, EntityDef, Row, Topic};
pub use error::{Result, StoreError};
pub use import::{ImportFile, ImportHandler, ImportOptions, ImportReport, Pattern, import_files};
pub use json_file::JsonFile;
pub use json_patch::PatchOp;
pub use listeners::Subscription;
pub use migrate::{MigrateReport, Migration, Up};
pub use query::{Cond, Dir, Query};
pub use reads::Reader;
pub use row::{Id, from_row, is_topic, to_row};
pub use schema::{KERNEL_OWNER, PLUGIN, SETTING};
pub use search::{SearchHit, to_match};
pub use store::{
    DEFAULT_RETENTION, EpochFn, Location, PruneResult, Retention, Store, StoreOptions,
};
pub use writer::{MutationResult, Writer};

/// rusqlite, for owners' `Up::Fn` data migrations (so a plugin needs no SQLite dependency of its own).
pub use rusqlite;

/// A `Row` from a JSON object literal: `row!({"id": "a", "title": "x"})`.
#[macro_export]
macro_rules! row {
    ($($json:tt)+) => {
        match ::serde_json::json!($($json)+) {
            ::serde_json::Value::Object(m) => m,
            _ => ::serde_json::Map::new(),
        }
    };
}
