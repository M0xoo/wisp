//! Computers reached through the tunnel they hold open (v1 grid/tunnels.js). wisp on a computer dials out
//! (`GET /api/computers/<id>/tunnel`, `Upgrade: wisp-tunnel`, its device token) and the grid sends it
//! requests over that one connection: HTTP/2 the other way round, the grid the client and the computer
//! the server (wisp-grid-client's dialer), so requests share it, stream (SSE) and keep their own flow
//! control. Nothing listens on the computer and no router needs opening.
//!
//! - A computer that redials replaces its old tunnel: the new one wins.
//! - The grid pings every 25 s (the computer drops a tunnel silent for 70 s).
//! - What the computer answers mustn't set cookies for the grid's other names: `set-cookie` is dropped,
//!   except a preview's own, host-only.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use http::HeaderMap;
use http_body_util::BodyExt as _;
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::{TokioExecutor, TokioTimer};

use crate::error::{Result, bad};
use crate::http::{Body, Resp, full};

/// What a computer sends in `Upgrade:` to open its tunnel.
pub const TUNNEL_PROTOCOL: &str = "wisp-tunnel";
const PING: Duration = Duration::from_secs(25);
const WINDOW: u32 = 1 << 20;
const ASK_MAX: usize = 64 * 1024;
/// Hop-by-hop, or not allowed in HTTP/2.
pub const HOP: &[&str] =
    &["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "http2-settings"];

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

struct Live {
    send: SendRequest<Body>,
    since: i64,
    generation: u64,
}

/// Cookies a page may set from behind the grid: its own address only (one with `Domain=` would reach the
/// grid's other names: cookie tossing).
pub fn host_only(v: &str) -> bool {
    !v.to_ascii_lowercase().split(';').any(|p| p.trim_start().starts_with("domain"))
}

#[derive(Default)]
pub struct Tunnels {
    live: Mutex<HashMap<String, Live>>,
    generation: AtomicU64,
}

impl std::fmt::Debug for Tunnels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tunnels").field("online", &self.live.lock().map_or(0, |l| l.len())).finish_non_exhaustive()
    }
}

impl Tunnels {
    /// The computer's upgraded connection: from now on the grid speaks HTTP/2 to it. Resolves when the
    /// tunnel is gone; `on_up` runs once it is up.
    pub async fn accept<IO>(self: &Arc<Self>, id: &str, io: IO, now_ms: i64) -> Result<()>
    where
        IO: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
    {
        let (send, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .timer(TokioTimer::new())
            .keep_alive_interval(PING)
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(true)
            .initial_stream_window_size(WINDOW)
            .handshake::<_, Body>(io)
            .await
            .map_err(|e| bad(format!("The tunnel didn't start: {e}"), 502))?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // a computer that reconnected: its new tunnel wins (the old connection ends with its sender)
        self.live.lock().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned(), Live { send, since: now_ms, generation });
        let _ = conn.await;
        let mut l = self.live.lock().unwrap_or_else(PoisonError::into_inner);
        if l.get(id).is_some_and(|t| t.generation == generation) {
            l.remove(id);
        }
        Ok(())
    }

    /// Whether that computer's tunnel is up.
    pub fn online(&self, id: &str) -> bool {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).get(id).is_some_and(|t| !t.send.is_closed())
    }

    /// When it came up.
    pub fn since(&self, id: &str) -> Option<i64> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).get(id).map(|t| t.since)
    }

    /// How many tunnels are up (for the tests and the account page).
    pub fn count(&self) -> usize {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).values().filter(|t| !t.send.is_closed()).count()
    }

    pub fn close(&self, id: &str) {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }

    fn sender(&self, id: &str) -> Option<SendRequest<Body>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).get(id).filter(|t| !t.send.is_closed()).map(|t| t.send.clone())
    }

    /// A request for the computer, through its tunnel, its answer streamed back. None: it isn't online.
    /// `cookies`: let it set its own (a preview's page, on its own address), host-only.
    pub async fn forward(&self, id: &str, mut req: http::Request<Body>, cookies: bool) -> Option<Resp> {
        let mut send = self.sender(id)?;
        for h in HOP {
            req.headers_mut().remove(*h);
        }
        *req.version_mut() = http::Version::HTTP_2;
        if send.ready().await.is_err() {
            return None;
        }
        let answer = match send.send_request(req).await {
            Ok(r) => r,
            Err(e) => return Some(crate::http::json(502, &serde_json::json!({ "error": format!("The computer didn’t answer: {e}") }))),
        };
        let (parts, body) = answer.into_parts();
        let mut out = http::Response::new(body.map_err(std::io::Error::other).boxed());
        *out.status_mut() = parts.status;
        for (k, v) in &parts.headers {
            let name = k.as_str();
            if HOP.contains(&name) || name == "set-cookie" {
                continue;
            }
            out.headers_mut().append(k.clone(), v.clone());
        }
        if cookies {
            for v in parts.headers.get_all("set-cookie") {
                if v.to_str().is_ok_and(host_only) {
                    out.headers_mut().append("set-cookie", v.clone());
                }
            }
        }
        Some(out)
    }

    /// One request to a computer through its tunnel, its answer whole; 502 when it isn't online.
    pub async fn ask(&self, id: &str, opts: AskOptions) -> Result<Asked> {
        let Some(mut send) = self.sender(id) else { return Err(bad("This computer isn’t online.", 502)) };
        let mut b = http::Request::builder()
            .method(if opts.method.is_empty() { "POST" } else { opts.method.as_str() })
            .uri(format!("http://computer{}", opts.path))
            .version(http::Version::HTTP_2);
        for (k, v) in &opts.headers {
            b = b.header(k, v);
        }
        let req = b.body(full(opts.body.unwrap_or_default())).map_err(|e| bad(e.to_string(), 400))?;
        let go = async {
            send.ready().await.map_err(|e| bad(e.to_string(), 502))?;
            let r = send.send_request(req).await.map_err(|e| bad(format!("no answer: {e}"), 502))?;
            let status = r.status().as_u16();
            let headers = r.headers().clone();
            let body = crate::http::read_bytes(r.into_body(), ASK_MAX).await.unwrap_or_default();
            Ok(Asked { status, headers, body })
        };
        tokio::time::timeout(Duration::from_millis(opts.timeout_ms.unwrap_or(30_000)), go)
            .await
            .map_err(|_| bad("The computer took too long.", 504))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_sets_only_its_own_cookies() {
        assert!(host_only("a=1; Path=/; HttpOnly"));
        assert!(!host_only("a=1; Domain=.wisp.localhost"));
        assert!(!host_only("a=1;domain=x"));
    }
}
