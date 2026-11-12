//! wisp-terminal-core: wisp.terminal's pure, sans-IO logic (no tokio, fs, net or clock: time, platform,
//! environment and lookups come in as values). The host wires it to proc, the kernel and HTTP.
//!
//! - `flow`: the terminal state machine (plan §4.6.3)
//! - `order`: numbered input, delivered in order with a gap skip
//! - `replay`: the 1 MB replay a late page sees, and UTF-8 decoding of the output stream
//! - `sse`: the event-stream frames, as v1 wrote them
//! - `size`, `env`, `folder`: sizes, the environment and the folder a terminal starts with
//! - `apps`, `plan`, `quote`: terminal apps per platform and the steps that open one
//! - `route`: what a v1 route body asks for
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod apps;
pub mod env;
pub mod error;
pub mod flow;
pub mod folder;
pub mod order;
pub mod plan;
pub mod quote;
pub mod replay;
pub mod route;
pub mod run;
pub mod size;
pub mod sse;

#[cfg(test)]
mod testrand;

pub use error::TerminalError;
