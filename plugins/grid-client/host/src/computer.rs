//! This computer on the grid (v1 server/grid-tunnel.js): `wisp computer on` adds it to the account (once)
//! and holds a tunnel open: it dials out (`GET /api/computers/<id>/tunnel`, `Upgrade: wisp-tunnel`, the
//! device token), then serves HTTP/2 on that connection. Each request the grid sends is handed to wisp
//! here on its loopback, as a page on this computer would make it (core's `local_headers`): the grid
//! already checked it's you asking. Nothing listens on this computer.
//!
//! - A stream with `x-wisp-preview: <port>` is a page on this computer, passed to that port only while
//!   "Show local pages in previews" (`grid-client.previews`) is on; 403 with why otherwise.
//! - It redials after a drop (Wi-Fi, sleep, a grid restart) after 1, 2, 5, 15, then every 30 s, and gives
//!   up only when the grid says this device or computer is gone (401/404).
//! - **A box never gets a laptop token:** on a grid box (`WISP_BOX`) this refuses to run.
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use serde_json::{Value, json};
use wisp_grid_client_api::{self as api, ComputerState, PREVIEWS};
use wisp_grid_client_core::{Dialed, TUNNEL_PROTOCOL, dialed, local_headers, preview_port, retry_ms};
use wisp_kernel::{CancellationToken, Result, WireError};

use crate::net;
use crate::state::{St, lock};

type Body = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;

pub const BOX_REFUSAL: &str = "A box never gets a laptop token: a grid box can't be one of your computers.";

fn on_a_box() -> bool {
    std::env::var("WISP_BOX").is_ok_and(|v| !v.is_empty() && v != "0")
}

fn set_state(st: &Arc<St>, state: &str, error: &str, retry: Option<u64>) {
    {
        let mut c = lock(&st.computer);
        c.state = state.into();
        c.error = error.into();
        c.retry_in_ms = retry;
    }
    crate::view::publish(st);
}

pub fn view(st: &St) -> ComputerState {
    let mut c = lock(&st.computer).clone();
    if let Some(a) = st.account() {
        c.on = a.computer_on;
        c.label = a.computer_label;
        c.url = if c.label.is_empty() { String::new() } else { wisp_grid_client_core::label_host(&a.grid, &c.label).map(|h| format!("{}://{h}", a.grid.split("://").next().unwrap_or("https"))).unwrap_or_default() };
    }
    c
}

/// Turns this computer on (or off) on the grid.
pub async fn set(st: &Arc<St>, on: bool, name: Option<String>) -> Result<ComputerState> {
    if on && on_a_box() {
        return Err(WireError::forbidden(BOX_REFUSAL));
    }
    if !on {
        stop(st);
        if let Some(mut a) = st.account() {
            a.computer_on = false;
            st.save_account(Some(a)).await?;
        }
        set_state(st, "off", "", None);
        return Ok(view(st));
    }
    let (mut a, token) = st.signed_in().await.map_err(WireError::invalid)?;
    let name = name.unwrap_or_else(|| crate::signin::device_name().trim_end_matches(" (wisp)").to_owned());
    if a.computer_id.is_empty() || a.computer_name != name {
        let (status, c) = net::call(&st.http, "POST", &format!("{}/api/computers", a.grid), Some(&token), Some(&json!({ "name": name })), &[]).await?;
        if status >= 400 {
            return Err(net::refused(status, &c));
        }
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        (a.computer_id, a.computer_label, a.computer_name) = (s("id"), s("label"), name);
    }
    a.computer_on = true;
    st.save_account(Some(a.clone())).await?;
    start(st, &a.grid, &a.computer_id, &token);
    Ok(view(st))
}

pub fn stop(st: &St) {
    if let Some(c) = lock(&st.dialer).take() {
        c.cancel();
    }
}

/// Starts (or restarts) the dialer.
pub fn start(st: &Arc<St>, grid: &str, id: &str, token: &str) {
    stop(st);
    let cancel = CancellationToken::new();
    *lock(&st.dialer) = Some(cancel.clone());
    let (st2, grid, id, token) = (st.clone(), grid.to_owned(), id.to_owned(), token.to_owned());
    st.ctx.spawn(async move { dial_loop(st2, grid, id, token, cancel).await });
}

enum Ended {
    /// the grid doesn't know us any more
    Gone(String),
    /// it was up and dropped, or never came up
    Retry(String),
    Closed,
}

async fn dial_loop(st: Arc<St>, grid: String, id: String, token: String, cancel: CancellationToken) {
    let mut attempt = 0usize;
    loop {
        set_state(&st, "connecting", "", None);
        let (ended, was_up) = dial_once(&st, &grid, &id, &token, &cancel).await;
        if was_up {
            attempt = 0;
        }
        match ended {
            Ended::Closed => return,
            Ended::Gone(why) => {
                set_state(&st, "gone", &why, None);
                return;
            }
            Ended::Retry(why) => {
                let wait = retry_ms(attempt);
                attempt += 1;
                set_state(&st, "retrying", &why, Some(wait));
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_millis(wait)) => {}
                }
            }
        }
    }
}

/// One dial: the tunnel held until it drops. → why it ended, and whether it was up.
async fn dial_once(st: &Arc<St>, grid: &str, id: &str, token: &str, cancel: &CancellationToken) -> (Ended, bool) {
    let client = net::client(true);
    let req = client.get(format!("{grid}/api/computers/{id}/tunnel")).header("connection", "Upgrade").header("upgrade", TUNNEL_PROTOCOL).bearer_auth(token).timeout(Duration::from_secs(20)).send();
    let resp = tokio::select! {
        () = cancel.cancelled() => return (Ended::Closed, false),
        r = req => match r { Ok(r) => r, Err(e) => return (Ended::Retry(format!("The grid didn’t answer: {e}")), false) },
    };
    let status = resp.status().as_u16();
    match dialed(status) {
        Dialed::Up => {}
        Dialed::Gone => {
            let v: Value = resp.json().await.unwrap_or_default();
            return (Ended::Gone(v.get("error").and_then(Value::as_str).unwrap_or("The grid doesn’t know this computer any more.").to_owned()), false);
        }
        Dialed::Retry => return (Ended::Retry(format!("The grid said {status}.")), false),
    }
    let up = match resp.upgrade().await {
        Ok(u) => u,
        Err(e) => return (Ended::Retry(format!("The tunnel didn’t open: {e}")), false),
    };
    set_state(st, "online", "", None);
    let port = local_port(st);
    let local: Client<HttpConnector, Body> = Client::builder(TokioExecutor::new()).build_http();
    let st2 = st.clone();
    let svc = hyper::service::service_fn(move |req: http::Request<Incoming>| {
        let (st, local) = (st2.clone(), local.clone());
        async move { Ok::<_, std::convert::Infallible>(serve(&st, &local, port, req).await) }
    });
    let conn = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
        .timer(TokioTimer::new())
        .keep_alive_interval(Some(Duration::from_secs(30)))
        .keep_alive_timeout(Duration::from_secs(40))
        .initial_stream_window_size(1 << 20)
        .serve_connection(TokioIo::new(up), svc);
    tokio::select! {
        () = cancel.cancelled() => (Ended::Closed, true),
        r = conn => (Ended::Retry(r.err().map_or_else(|| "The connection to the grid dropped.".to_owned(), |e| format!("The connection to the grid dropped: {e}"))), true),
    }
}

/// This wisp's own port (its loopback address, from the agent access service).
fn local_port(st: &St) -> u16 {
    st.ctx.service::<Arc<dyn wisp_runtime_api::points::AgentAccess>>().ok().map(|a| a.url()).and_then(|u| u.rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse().ok())).unwrap_or(4477)
}

fn answer(status: u16, body: &Value) -> http::Response<Body> {
    let mut r = http::Response::new(http_body_util::Full::new(Bytes::from(body.to_string())).map_err(|e| match e {}).boxed());
    *r.status_mut() = http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::BAD_GATEWAY);
    r.headers_mut().insert("content-type", http::HeaderValue::from_static("application/json"));
    r
}

fn previews_on(st: &St) -> bool {
    matches!(st.ctx.setting(PREVIEWS), Some(Value::Bool(true))) || st.ctx.setting(PREVIEWS).as_ref().and_then(Value::as_str) == Some("on")
}

/// One stream from the grid: to wisp here, or (a preview) to a page on this computer.
async fn serve(st: &St, local: &Client<HttpConnector, Body>, port: u16, req: http::Request<Incoming>) -> http::Response<Body> {
    let (parts, body) = req.into_parts();
    // a message the grid routed here (`on <this computer> …`): marked by the grid alone (its edge drops the mark
    // from everything else it forwards), handed to wisp.channels, never to wisp's HTTP as the user
    if parts.headers.get("x-wisp-route").and_then(|v| v.to_str().ok()) == Some("grid") {
        if parts.uri.path() != "/api/channels/routed" || parts.method != http::Method::POST {
            return answer(404, &json!({ "error": "not found" }));
        }
        let Ok(b) = http_body_util::Limited::new(body, 64 * 1024).collect().await.map(http_body_util::Collected::to_bytes) else { return answer(413, &json!({ "reply": "That message was too big." })) };
        let args: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
        return match st.ctx.run_json(&st.ctx.root_call(), "channels.routed", args).await {
            Ok(out) => answer(u16::try_from(out["status"].as_u64().unwrap_or(200)).unwrap_or(200), &out["body"]),
            Err(e) => answer(e.status(), &json!({ "reply": e.message })),
        };
    }
    let from: Vec<(String, String)> = parts.headers.iter().filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned()))).collect();
    let preview = parts.headers.get("x-wisp-preview").map(|v| preview_port(v.to_str().ok()));
    let target = match preview {
        Some(_) if !previews_on(st) => return answer(403, &json!({ "error": "This computer doesn’t show its local pages through the grid. Turn on Settings → Machines → Show local pages in previews there." })),
        Some(None) => return answer(404, &json!({ "error": "not found" })),
        Some(Some(p)) => p,
        None => port,
    };
    let headers = if preview.is_some() {
        from.into_iter().filter(|(k, _)| !wisp_grid_client_core::HOP.contains(&k.as_str()) && k != "x-wisp-preview").chain(std::iter::once(("host".to_owned(), format!("127.0.0.1:{target}")))).collect()
    } else {
        local_headers(&from, port, &st.mark)
    };
    let pq = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let mut b = http::Request::builder().method(parts.method.clone()).uri(format!("http://127.0.0.1:{target}{pq}"));
    for (k, v) in &headers {
        b = b.header(k, v);
    }
    let Ok(out) = b.body(body.map_err(std::io::Error::other).boxed()) else { return answer(400, &json!({ "error": "bad request" })) };
    match local.request(out).await {
        Ok(r) => {
            let (mut p, b) = r.into_parts();
            for h in wisp_grid_client_core::HOP {
                p.headers.remove(*h);
            }
            http::Response::from_parts(p, b.map_err(std::io::Error::other).boxed())
        }
        Err(e) => answer(502, &json!({ "error": format!("wisp here didn’t answer: {e}") })),
    }
}

/// At start: a computer that was on dials again.
pub async fn resume(st: &Arc<St>) {
    if let (Some(a), Some(t)) = (st.account(), st.token().await)
        && a.computer_on
        && !a.computer_id.is_empty()
        && !on_a_box()
    {
        start(st, &a.grid, &a.computer_id, &t);
    }
}

/// `grid-client.reply`: `POST /api/channels/reply {thread, text}` with this computer's device token (grid
/// `edge_route.rs`). Always answers what the grid said, so the caller decides whether to try again.
pub async fn reply(st: &St, a: &api::ReplyArgs) -> api::Replied {
    let Ok((acct, token)) = st.signed_in().await else { return api::Replied { status: 401, error: "Not signed in to wisp Cloud".into() } };
    let url = format!("{}/api/channels/reply", acct.grid.trim_end_matches('/'));
    match net::call(&st.http, "POST", &url, Some(&token), Some(&json!({ "thread": a.thread, "text": a.text })), &[]).await {
        Ok((status, v)) => api::Replied { status, error: if status < 300 { String::new() } else { v["error"].as_str().unwrap_or_default().to_owned() } },
        Err(e) => api::Replied { status: 0, error: e.message },
    }
}
