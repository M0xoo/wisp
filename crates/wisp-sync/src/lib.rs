//! wisp's sync server (ADR-0005, plan §4.3–§4.5) as a sans-IO machine: `SyncServer::handle(input,
//! now_ms)` takes what happened (a stream opened, a message, rows committed, a tick, a socket
//! drained, a snapshot read) and returns what to do (frames to send, snapshots and windows to read,
//! commands to run, streams to close). No clock, socket, timer or store inside: the HTTP edge
//! (`wisp-api`) carries the outputs out, so the rules are tested on a scripted clock.
//!
//! - **Resume** only when the epoch matches and the cursor is within `[oldest_seq, head_seq]`.
//! - **Outbox** per connection keyed by `(topic, e, id)`: upsert wins, del drops, appends join,
//!   patches compose; flushed every 50 ms, or at once when idle.
//! - **Priority:** acks, then the client's `session:*` topics, then `list`, then the rest.
//! - **Backpressure:** past ~1 MB buffered, busy topics are dropped and the client told to `resync`.
//! - **Cursor = watermark:** a frame's `id:` never passes a change still queued for the client.
//! - **The client half** (`client::SyncClient`) is the Rust twin of `packages/sync`'s, for the CLI
//!   and any Rust peer that attaches to a wisp.

pub mod client;
mod conn;
mod error;
mod flush;
mod fold;
mod outbox;
mod parse;
mod rows;
mod server;
pub mod sse;
mod types;

pub use client::SyncClient;
pub use error::SyncError;
pub use fold::{compose, fold};
pub use parse::{ParsedHello, Passive, parse_client_message, parse_hello};
pub use rows::window_page;
pub use server::SyncServer;
pub use types::{
    CanRead, ChangeRow, CloseReason, CommandOutcome, ConnId, ConnectQuery, Gone, Input, Output,
    SnapshotAnswer, Stats, SyncOptions,
};
