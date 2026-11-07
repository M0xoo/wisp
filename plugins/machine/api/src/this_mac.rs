//! This Mac's contract (v1 server/machine.js, server/load.js, routes/machine.js): what agents cost this
//! computer, the RAM/CPU load guard, stopping what finished runs left running, File a fix, Pause
//! automations and the battery hold.
//!
//! - [`view`]: the rows `GET /machine` answers, in v1's JSON shape (camelCase, same key order).
//! - [`commands`]: `machine.read`, `machine.stop`, `machine.fix`, `machine.harness.clean`,
//!   `machine.automations.pause`, `machine.load` (each id is its permission).
//! - [`service`]: `machine.service@1`, the read-only load questions crew, automations and budget ask.
//! - [`points`]: what other plugins provide: the live runs and their pids, facts about a task, the
//!   harnesses' own disk, and who files a fix.

pub mod commands;
pub mod num;
pub mod points;
pub mod service;
pub mod view;

pub use commands::*;
pub use points::*;
pub use service::*;
pub use view::*;

/// Sync topic for the page (and the event a client re-reads `GET /machine` on).
pub const TOPIC: &str = "machine";
/// The ext slot (on a task) where a heavy run's `res` is kept for its list row.
pub const EXT: &str = "wisp.machine";
