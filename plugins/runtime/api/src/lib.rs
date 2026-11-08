//! wisp-runtime-api: the contract of wisp.runtime, the plugin that owns tasks (sessions), their turns
//! and activity, the follow-up queue and the harness lifecycle. Every other plugin that starts, reads
//! or reacts to a task depends on this crate only (ADR-0003).
//!
//! Stability: harness plugins build against [`harness`] while the runtime host is written; every change
//! here is additive (change-a-contract skill). Wire shapes are v1's (camelCase), so v1 clients and the
//! importer map 1:1. Types the UI reads derive `ts_rs::TS` and export under `runtime/`.

pub mod commands;
pub mod events;
pub mod harness;
pub mod hooks;
pub mod model;
pub mod points;
pub mod spec;

/// Kernel-style branded ids (`wisp_kernel::id_type!`), plus `ts_rs::TS` as a plain string for the UI.
macro_rules! ts_id {
    ($name:ident) => {
        #[derive(
            Debug,
            Clone,
            PartialEq,
            Eq,
            Hash,
            PartialOrd,
            Ord,
            Default,
            serde::Serialize,
            serde::Deserialize,
            ts_rs::TS,
        )]
        #[serde(transparent)]
        #[ts(type = "string")]
        pub struct $name(pub String);
        impl $name {
            /// A fresh `UUIDv7` id (legacy v1 ids import unchanged through `From<&str>`).
            pub fn new() -> Self {
                Self(wisp_kernel::ids::uuid7())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }
        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }
    };
}

ts_id!(SessionId);
ts_id!(TurnId);

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.runtime";

/// Sync topics: the list, and one task (its row, turns and activity).
pub const TOPIC_LIST: &str = "list";
pub fn session_topic(id: &str) -> String {
    format!("session:{id}")
}

pub use harness::{
    Exit, HARNESS, Harness, HarnessEvent, HarnessParser, HarnessRun, HarnessSys, Launch,
    ParserInput, ParserOutput, RunDriver, pure,
};
pub use model::{
    Activity, Attachment, Mode, Presentation, QueueItem, Session, SessionState, Summary, Turn,
    TurnStatus,
};
