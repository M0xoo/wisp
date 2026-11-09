//! The `loopback` transport: another wisp on this computer (another `WISP_HOME` on another port),
//! reached straight over 127.0.0.1. Nothing to start or tunnel: the manager's own `tunnel` step
//! checks it answers. It is how a second home on one computer (a test home, a work profile) shows
//! up as a peer, and how the e2e test drives two wisps without ssh. Loopback hosts only
//! (`view::clean_loopback`): this never sends a request off the computer.
use std::sync::Arc;

use wisp_kernel::{BoxFuture, CancellationToken};
use wisp_machines_api::{AddArgs, Channel, Cleaned, ConnectIo, Failing, PeerRow, Transport, TransportFailure};
use wisp_machines_core::bootstrap::{AGENTS, TUNNEL};
use wisp_machines_core::view::clean_loopback;

use crate::http::HttpChannel;

pub const KIND: &str = "loopback";

#[derive(Debug, Default)]
pub struct LoopbackTransport;

/// `[::1]` for a URL, the host as is otherwise.
pub fn url_host(host: &str) -> String {
    if host == "::1" { "[::1]".to_owned() } else { host.to_owned() }
}

impl Transport for LoopbackTransport {
    fn kind(&self) -> &str {
        KIND
    }
    fn steps(&self) -> &'static [(&'static str, &'static str)] {
        &[(TUNNEL, "Reach wisp there"), (AGENTS, "Find coding agents")]
    }
    fn clean(&self, input: &AddArgs, prev: Option<&PeerRow>) -> Failing<Cleaned> {
        clean_loopback(input, prev).map_err(|m| TransportFailure { status: Some(400), ..TransportFailure::new(m) })
    }
    fn connect(&self, peer: PeerRow, _io: Arc<dyn ConnectIo>, cancel: CancellationToken) -> BoxFuture<'static, Failing<Arc<dyn Channel>>> {
        Box::pin(async move {
            let host = url_host(&peer.address);
            let ch: Arc<dyn Channel> = HttpChannel::new(format!("http://{host}:{}/api", peer.port), format!("{host}:{}", peer.port), cancel);
            Ok(ch)
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_this_computer() {
        let t = LoopbackTransport;
        let ok: AddArgs = serde_json::from_value(json!({"address": "127.0.0.1", "port": 4999})).unwrap_or_default();
        assert_eq!(t.clean(&ok, None).ok().and_then(|c| c.port), Some(4999));
        let off: AddArgs = serde_json::from_value(json!({"address": "example.com", "port": 4999})).unwrap_or_default();
        assert_eq!(t.clean(&off, None).err().and_then(|f| f.status), Some(400));
        assert_eq!(url_host("::1"), "[::1]");
        assert_eq!(t.steps().iter().map(|s| s.0).collect::<Vec<_>>(), [TUNNEL, AGENTS]);
    }
}
