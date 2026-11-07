//! The service `machines.peers@1`: a handle on the peers for other plugins (crew, router, sandbox,
//! the session proxy): requests to a peer's wisp, its harnesses, its mirrored rows. Every method
//! takes the `Call` first and checks its permission (`machines:call` or `machines:read`).
use serde_json::{Value, json};
use wisp_kernel::{BoxFuture, Call, Code, Result, Service, WireError};

use crate::rows::{MirrorRow, PeerRow, RemoteAgent};
use crate::transport::{ChannelRequest, ChannelResponse};

pub const PEERS: &str = "machines.peers";

pub trait MachinesService: Send + Sync + 'static {
    /// a JSON call to the peer's API (path under `/api`); fails as v1's `bad(message, status)` did:
    /// [`http_status`] gives the status back, `details.hold` the far side's hold (Ask near the limit)
    fn json(
        &self,
        call: &Call,
        id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<'static, Result<Value>>;
    /// a raw request (files, uploads, terminals)
    fn stream(
        &self,
        call: &Call,
        id: &str,
        req: ChannelRequest,
    ) -> BoxFuture<'static, Result<ChannelResponse>>;
    /// online, or asleep and woken by a request
    fn usable(&self, call: &Call, id: &str) -> Result<bool>;
    fn online(&self, call: &Call, id: &str) -> Result<bool>;
    fn agents_of(&self, call: &Call, id: &str) -> Result<Option<Vec<RemoteAgent>>>;
    /// the rows a peer's list shows (fresh while online, the last seen ones while not)
    fn rows(&self, call: &Call, id: Option<&str>) -> Result<Vec<MirrorRow>>;
    fn terminal_argv(&self, call: &Call, id: &str, command: &str) -> Result<Vec<String>>;
    fn peers(&self, call: &Call) -> Result<Vec<PeerRow>>;
}

#[derive(Debug, Clone, Copy)]
pub struct Peers;
impl Service for Peers {
    const ID: &'static str = PEERS;
    const MAJOR: u32 = 1;
    type Api = dyn MachinesService;
}

/// v1's `bad(message, status)` as a wire error that keeps its status (and a hold, if any), so a
/// route adapter answers the same status v1 did.
pub fn peer_error(message: impl Into<String>, status: u16, hold: Option<Value>) -> WireError {
    let code = match status {
        400 | 422 => Code::Invalid,
        401 | 403 => Code::Forbidden,
        404 => Code::NotFound,
        409 => Code::Conflict,
        413 => Code::TooLarge,
        504 => Code::Timeout,
        502 | 503 => Code::Unavailable,
        _ if status >= 500 => Code::Internal,
        _ => Code::Invalid,
    };
    let mut details = json!({ "status": status });
    if let Some(h) = hold {
        details["hold"] = h;
    }
    WireError {
        retry: matches!(status, 502 | 503),
        ..WireError::new(code, message)
    }
    .with_details(details)
}

/// The HTTP status a route answers with: the peer's own, when the error came from one.
pub fn http_status(e: &WireError) -> u16 {
    e.details
        .as_ref()
        .and_then(|d| d.get("status"))
        .and_then(Value::as_u64)
        .and_then(|s| u16::try_from(s).ok())
        .unwrap_or_else(|| e.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_error_keeps_its_status_and_hold() {
        let e = peer_error("disk full over there", 500, None);
        assert_eq!(http_status(&e), 500);
        assert_eq!(e.code, Code::Internal);
        let e = peer_error("Request Entity Too Large", 413, None);
        assert_eq!((http_status(&e), e.code), (413, Code::TooLarge));
        let e = peer_error("box is offline", 503, None);
        assert!(e.retry);
        let e = peer_error("near the limit", 409, Some(json!({"until": 5})));
        assert_eq!(
            e.details.as_ref().and_then(|d| d.get("hold")),
            Some(&json!({"until": 5}))
        );
        assert_eq!(http_status(&WireError::not_found("x")), 404);
    }
}
