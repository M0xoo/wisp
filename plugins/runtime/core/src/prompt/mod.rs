//! Prompt assembly (v1 protocol.js and friends).

pub mod btw;
pub mod handoff;
pub mod lean;
pub mod mentions;
mod protocol_text;
pub mod refusal;
pub mod side;
pub mod subagents;
pub mod system;
pub(crate) mod text;

pub use system::{BlockDoc, SystemOpts, block_docs, system_prompt};
