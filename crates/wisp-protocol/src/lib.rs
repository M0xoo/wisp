//! wisp's sync wire types (ADR-0005, plan §4.3): one schema, shared by the server, every client and
//! every peer. These Rust types are the source: `cargo test -p wisp-protocol export_bindings` writes
//! them to `packages/protocol/src/generated/protocol.ts`, which `@wisp/protocol` re-exports.
//!
//! Compatibility (plan §7.3.2): adding a field, message, command or topic is fine; removing or
//! changing one needs `PROTO + 1`.

mod bindings;
mod error;
mod patch;
pub mod tag;
mod topic;
mod wire;

pub use bindings::typescript;
pub use error::ProtocolError;
pub use patch::{PatchOp, apply_patch, diff, escape_pointer, parse_pointer, patched};
pub use topic::{Topic, is_topic};
pub use wire::{
    Ack, Change, ClientMessage, CommandError, CommandRequest, CommandResponse, EntityOp, Hello,
    Mutate, Notice, Patch, PeerInfo, PeerPlugin, Reject, Resync, Row, Rows, ServerMessage,
    Snapshot, Sub, Unsub, Welcome, Window,
};

/// The protocol this build speaks; v1 was the untyped broadcast stream.
pub const PROTO: u32 = 2;
/// The oldest protocol this build still speaks.
pub const PROTO_MIN: u32 = 2;
