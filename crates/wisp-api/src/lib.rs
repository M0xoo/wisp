//! wisp-api: the HTTP edge over the kernel (ADR-0013, plan §3, docs/v1-edge-cases.md → The HTTP edge).
//! It knows no feature: routes come from the kernel's `kernel.http` point, `/api/status` parts from
//! `kernel.status`, commands from `Kernel::call`, the v2 sync stream from wisp-sync (`SyncMount`).
//! What it owns is who may talk to wisp and how answers travel:
//! - [`guard`]: Host allow-list, trusted-proxy mode ([`trust`]), Origin rules, JSON-only bodies;
//! - [`auth`]: tokens → a capability set per request; [`body`]: the 2 MB cap;
//! - [`router`]: whole-segment patterns; [`openapi`]: the document, assembled from the routes;
//! - [`respond`]: weak `ETags`, 304s, brotli/gzip off the runtime threads, prepared answers;
//! - [`statics`]: the web bundle, the phone's boot page and `/_pack`; [`preview`]: previews;
//! - [`sync`]: `/api/events` (v2 mounted, v1 kept), `/api/cmd`, the `notify` hub; [`status`].
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod auth;
pub mod backend;
pub mod body;
pub mod config;
pub mod edge;
pub mod error;
pub mod guard;
pub mod openapi;
mod own;
pub mod preview;
pub mod respond;
pub mod router;
pub mod serve;
pub mod statics;
pub mod status;
pub mod sync;
pub mod trust;
pub mod v2;

pub use backend::{Backend, Binding};
pub use edge::{API_VERSION, Edge, EdgeConfig};
pub use error::ApiError;
pub use serve::{Server, serve};
pub use sync::{Hub, SyncMount};
pub use trust::TrustedProxy;

/// The port wisp listens on unless told otherwise.
pub const DEFAULT_PORT: u16 = 4477;
