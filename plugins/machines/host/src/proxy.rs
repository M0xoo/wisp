//! The app reaching a peer through this wisp (round 18): `/api/peer/<machine>/…` forwards the sync protocol
//! (`GET` and `POST /api/events`, `POST /api/cmd`) over the machine's own link (its transport, its token), so the
//! app adds the peer by that base and a task there (a sandbox's, another computer's) shows and opens like one here.
//! The app never holds the machine's token; the caller needs `machines:call`.

use std::sync::Arc;

use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Setup, WireError};
use wisp_machines_api::{Body, ChannelRequest};

use crate::{Slot, state};

/// The headers that go along: the client's id and the command's idempotency key, and the body's type.
const PASS: [&str; 5] = ["content-type", "x-wisp-client", "idempotency-key", "last-event-id", "accept"];

fn forward(req: &Request, rest: &str) -> ChannelRequest {
    let q: Vec<String> = req.query.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
    let path = if q.is_empty() { rest.to_owned() } else { format!("{rest}?{}", q.join("&")) };
    let headers = req.headers.iter().filter(|(k, _)| PASS.contains(&k.to_ascii_lowercase().as_str())).cloned().collect();
    ChannelRequest { method: req.method.clone(), path, headers, body: if req.body.is_empty() { Body::Empty } else { Body::Bytes(req.body.clone()) }, timeout_ms: None, passive: false }
}

fn encode(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~,".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    for (method, pattern, rest) in [("GET", "/peer/:id/api/events", "/events"), ("POST", "/peer/:id/api/events", "/events"), ("POST", "/peer/:id/api/cmd", "/cmd")] {
        let sl = slot.clone();
        s.route(Route {
            method,
            pattern,
            permission: "machines:call",
            doc: false,
            summary: "A peer's sync protocol, through this wisp's link to it",
            raw: false,
            max_body: Some(8 << 20),
            handler: Arc::new(move |_ctx, _call, req| {
                let sl = sl.clone();
                Box::pin(async move {
                    let st = state(&sl)?;
                    let id = req.param("id").unwrap_or_default().to_owned();
                    let ch = st.channel(&id).map_err(WireError::from)?;
                    let mut resp = ch.request(forward(&req, rest)).await?;
                    let ty = resp.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")).map_or_else(|| "application/json".to_owned(), |(_, v)| v.clone());
                    if ty.starts_with("text/event-stream") {
                        // the stream, as it comes, until the app or the link goes
                        let (tx, out) = Response::stream(ty);
                        tokio::spawn(async move {
                            while let Some(chunk) = resp.body.recv().await {
                                if tx.send(chunk).await.is_err() {
                                    resp.cancel.cancel();
                                    return;
                                }
                            }
                        });
                        return Ok(out);
                    }
                    let mut body = Vec::new();
                    while let Some(chunk) = resp.body.recv().await {
                        body.extend(chunk);
                    }
                    Ok(Response::Bytes { status: resp.status, content_type: ty, body, headers: Vec::new() })
                })
            }),
        });
    }
}
