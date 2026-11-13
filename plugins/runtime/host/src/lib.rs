//! wisp-runtime: the host of wisp.runtime (plan §4.1, §4.8, §6.1b). Tasks, their turns and event log in
//! the store; the follow-up queue; the harness lifecycle (a harness's `Launch` spawned through wisp-proc,
//! its output fed to its sans-IO driver, activity appended through the store's Coalescer); interceptors
//! at `before:create`, `before:followUp` and `before:run`; events after commit; v1's session routes; the
//! v1 importer with the dual write. The decisions live in `wisp-runtime-core`; this crate does the I/O.

mod reads;
mod drive;
mod found;
mod group;
pub mod error;
mod env_view;
mod finish;
pub mod host;
mod importer;
mod kinds;
mod limit;
mod media;
mod mentions;
mod more;
mod ops;
mod plugin;
pub mod repo;
pub mod rows;
mod run;
mod setup;
mod side;
mod specs;
mod term;
mod usage_row;
mod watch;
pub mod runtime;
pub mod schema;
pub mod sys;

pub use host::{Emitted, Host, Recorder};
pub use plugin::RuntimePlugin;
pub use runtime::Runtime;
