//! wisp-claude-core: Claude Code's `stream-json` parser and what it needs, sans-IO (plan §3.1 rule 3).
//! Lines in, v1's events out ([`ClaudeParser`], a `wisp_harness_kit::LineParser`); the only disk it
//! asks for is a Write's "before", as an `IoStep` the host's driver runs in place. Gate G6: the 34
//! recorded runs in `tests/fixtures` parse exactly as v1 parsed them (`tests/g6.rs`).

// Docs here quote the CLI's own JSON keys (tool_use_id, modelUsage) as prose, not as code to link.
#![allow(clippy::doc_markdown)]

pub mod describe;
pub mod limits;
pub mod line;
pub mod msg;
pub mod parser;
pub mod result;
pub mod subagents;
pub mod usage;

pub use parser::{ClaudeOptions, ClaudeParser};
