//! A `Channel` that is plain HTTP to a wisp on this computer's loopback: the far end of an ssh `-L`
//! forward, or another wisp here (`loopback`). Bodies stream both ways (the sync stream is SSE). The
//! kernel's net service answers whole bodies only, so the link keeps its own client, loopback only
//! and with no proxy, so `HTTP_PROXY` never sees a peer's traffic.
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::mpsc;
use wisp_kernel::{BoxFuture, CancellationToken, Result, WireError};
use wisp_machines_api::{Body, Channel, ChannelEnd, ChannelRequest, ChannelResponse, EndReason};

pub struct HttpChannel {
    /// `http://127.0.0.1:<port>/api`
    base: String,
    label: String,
    client: reqwest::Client,
    /// cancelled when the way is gone (closed here, the ssh child exited, the plugin switched off)
    scope: CancellationToken,
    end: Arc<Mutex<Option<ChannelEnd>>>,
}

impl std::fmt::Debug for HttpChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpChannel").field("base", &self.base).finish_non_exhaustive()
    }
}

fn closed_end() -> ChannelEnd {
    ChannelEnd { reason: EndReason::Closed, error: None, hint: None, give_up: false }
}

impl HttpChannel {
    pub fn new(base: String, label: String, scope: CancellationToken) -> Arc<Self> {
        let client = reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build().unwrap_or_default();
        Arc::new(Self { base, label, client, scope, end: Arc::new(Mutex::new(None)) })
    }

    /// The way is gone, and why (the first reason wins).
    pub fn end_with(&self, end: ChannelEnd) {
        let mut e = self.end.lock().unwrap_or_else(PoisonError::into_inner);
        if e.is_none() {
            *e = Some(end);
        }
        drop(e);
        self.scope.cancel();
    }

    pub fn scope(&self) -> &CancellationToken {
        &self.scope
    }
}

fn body_of(b: Body) -> Option<reqwest::Body> {
    match b {
        Body::Empty => None,
        Body::Bytes(b) => Some(reqwest::Body::from(b)),
        Body::Stream(rx) => {
            let s = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|c| (Ok::<_, std::io::Error>(c), rx)) });
            Some(reqwest::Body::wrap_stream(s))
        }
    }
}

/// Hands the body on as it comes; stops when the reader goes, the request is cancelled or the way is gone.
async fn pump(mut resp: reqwest::Response, tx: mpsc::Sender<Vec<u8>>, cancel: CancellationToken, scope: CancellationToken) {
    loop {
        tokio::select! {
            () = cancel.cancelled() => return,
            () = scope.cancelled() => return,
            c = resp.chunk() => match c {
                Ok(Some(c)) => {
                    if tx.send(c.to_vec()).await.is_err() {
                        return;
                    }
                }
                Ok(None) | Err(_) => return,
            },
        }
    }
}

impl Channel for HttpChannel {
    fn request(&self, req: ChannelRequest) -> BoxFuture<'static, Result<ChannelResponse>> {
        let url = format!("{}{}", self.base, req.path);
        let (client, scope, label) = (self.client.clone(), self.scope.clone(), self.label.clone());
        Box::pin(async move {
            let method =
                reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
            let mut b = client.request(method, &url);
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            if let Some(body) = body_of(req.body) {
                b = b.body(body);
            }
            if let Some(ms) = req.timeout_ms {
                b = b.timeout(Duration::from_millis(ms));
            }
            let resp = tokio::select! {
                () = scope.cancelled() => return Err(WireError::unavailable(format!("{label}: the connection is gone"))),
                r = b.send() => r.map_err(|e| if e.is_timeout() { WireError::new(wisp_kernel::Code::Timeout, format!("{label}: no answer in time")) } else { WireError::unavailable(format!("{label}: {e}")) })?,
            };
            let status = resp.status().as_u16();
            let headers = resp.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))).collect();
            let (tx, body) = mpsc::channel(64);
            let cancel = CancellationToken::new();
            tokio::spawn(pump(resp, tx, cancel.clone(), scope));
            Ok(ChannelResponse { status, headers, body, cancel })
        })
    }

    fn closed(&self) -> BoxFuture<'static, ChannelEnd> {
        let (scope, end) = (self.scope.clone(), self.end.clone());
        Box::pin(async move {
            scope.cancelled().await;
            // set before the cancel (`end_with`), so it is there now
            end.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_else(closed_end)
        })
    }

    fn close(&self) {
        self.end_with(closed_end());
    }

    fn label(&self) -> String {
        self.label.clone()
    }
}
