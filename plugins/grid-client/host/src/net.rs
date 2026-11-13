//! Talking to a grid: one HTTP client (no proxy: a peer's traffic never goes through `HTTP_PROXY`), whose
//! resolver answers `*.localhost` itself (127.0.0.1, as browsers do), so a grid on this machine works at
//! `http://wisp.localhost:8080` and its boxes at `<handle>.wisp.localhost:8080` without touching
//! `/etc/hosts`. Every other name goes to the system resolver.
use std::net::{SocketAddr, ToSocketAddrs as _};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use wisp_kernel::{Result, WireError};

#[derive(Debug, Default)]
struct LocalFirst;

impl reqwest::dns::Resolve for LocalFirst {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_ascii_lowercase();
        Box::pin(async move {
            if host == "localhost" || host.ends_with(".localhost") {
                let a: Box<dyn Iterator<Item = SocketAddr> + Send> = Box::new(std::iter::once(SocketAddr::from(([127, 0, 0, 1], 0))));
                return Ok(a);
            }
            let found = tokio::task::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs().map(Iterator::collect::<Vec<_>>))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
            let a: Box<dyn Iterator<Item = SocketAddr> + Send> = Box::new(found.into_iter());
            Ok(a)
        })
    }
}

/// A client for a grid and its boxes. `h1`: HTTP/1.1 only (the tunnel's Upgrade).
pub fn client(h1: bool) -> reqwest::Client {
    let b = reqwest::Client::builder().no_proxy().dns_resolver(Arc::new(LocalFirst)).connect_timeout(Duration::from_secs(10));
    let b = if h1 { b.http1_only() } else { b };
    b.build().unwrap_or_default()
}

/// A JSON call to the grid: its status and body (`{}` when it has none).
pub async fn call(
    http: &reqwest::Client,
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
    headers: &[(&str, &str)],
) -> Result<(u16, Value)> {
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
    let mut b = http.request(m, url).timeout(Duration::from_secs(30));
    if let Some(t) = token {
        b = b.bearer_auth(t);
    }
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    if let Some(body) = body {
        b = b.json(body);
    }
    let r = b.send().await.map_err(|e| WireError::unavailable(format!("{}: {e}", host_of(url))))?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    let v = if text.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "error": text.chars().take(200).collect::<String>() }))
    };
    Ok((status, v))
}

/// A refusal in the grid's words.
pub fn refused(status: u16, v: &Value) -> WireError {
    let msg = v.get("error").and_then(Value::as_str).map_or_else(|| format!("the grid said {status}"), str::to_owned);
    match status {
        401 | 403 => WireError::forbidden(msg),
        404 | 410 => WireError::not_found(msg),
        _ if status >= 500 => WireError::unavailable(msg),
        _ => WireError::invalid(msg),
    }
}

pub fn host_of(url: &str) -> &str {
    url.split_once("://").map_or(url, |(_, r)| r.split('/').next().unwrap_or(r))
}
