//! Computers reached through the tunnel they hold open (v1 grid/tunnels.js). STUB: the signatures
//! below are the contract other modules (route, the edge) code against; the publish agent fills in
//! the bodies and may add to them, without changing these.
use bytes::Bytes;
use http::HeaderMap;

use crate::error::{Result, bad};

/// What a computer sends in `Upgrade:` to open its tunnel.
pub const TUNNEL_PROTOCOL: &str = "wisp-tunnel";

/// One request the grid itself makes to a computer (route delivery, a status check).
#[derive(Debug, Clone, Default)]
pub struct AskOptions {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    pub timeout_ms: Option<u64>,
}

/// Its answer, whole (at most 64 KiB).
#[derive(Debug, Clone, Default)]
pub struct Asked {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

#[derive(Debug, Default)]
pub struct Tunnels {}

impl Tunnels {
    /// Whether that computer's tunnel is up.
    pub fn online(&self, _computer_id: &str) -> bool {
        false
    }
    /// One request to a computer through its tunnel; 502 when it isn't online.
    pub async fn ask(&self, _computer_id: &str, _opts: AskOptions) -> Result<Asked> {
        Err(bad("This computer isn’t online.", 502))
    }
}
