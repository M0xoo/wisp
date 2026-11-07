//! wisp-machines-core: the pure core of `wisp.machines` (plan §7.2, ADR-0010), sans-IO. Everything a
//! peer connection decides lives here, so it is tested without a network, an ssh or a clock: the
//! ssh argv and the remote bootstrap, what a failure means, the v1 relay's id rewriting, the peer's
//! sync client (a cursor per (peer, epoch), passive subscriptions, commands kept by idempotency key),
//! the connection state machine and the card a peer shows.

pub mod bootstrap;
pub mod hint;
pub mod hosts;
pub mod reachable;
pub mod relay;
pub mod reply;
pub mod shell;
pub mod sse;
pub mod ssh;
pub mod conn;
pub mod mirror;
pub mod negotiate;
pub mod peer_client;
pub mod route;
pub mod view;
