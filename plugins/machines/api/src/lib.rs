//! wisp-machines-api: the contract of `wisp.machines`, the plugin that owns peers (your other
//! computers, cloud computers, sandboxes) and how they are reached (ADR-0010, plan §7.2).
//!
//! A peer row is a computer this wisp reaches, with a `transport`. Its `id` is the local handle (6
//! hex); `peer` is the far side's own stable `peer_id`, learned from its welcome, which v2 ids carry
//! as their origin (`<peer>:<uuid>`). Peers speak the v2 sync protocol only (ADR-0031).
//!
//! How a peer is reached is an implementation of [`TRANSPORT`] (`machines.transport@1`): `ssh` ships
//! in `wisp.machines`, `grid` and `grid-tunnel` in `wisp.grid-client`, and a user's plugin may add one.

pub mod commands;
pub mod events;
pub mod ids;
pub mod rows;
pub mod service;
pub mod transport;

pub use commands::*;
pub use events::*;
pub use ids::{owner_of, secret_key};
pub use rows::*;
pub use service::{MachinesService, PEERS, Peers, http_status, peer_error};
pub use transport::*;

/// The plugin id.
pub const PLUGIN: &str = "wisp.machines";
/// The topic peers and their status are on.
pub const TOPIC: &str = "machines";
