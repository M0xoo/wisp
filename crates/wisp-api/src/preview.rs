//! Previews on a wisp Grid (v1 http/preview.js, edge case 10): a page the agent left running here
//! (localhost:5173) shown at its own address. The grid's edge signs the user in and sends the request on,
//! through the trusted proxy, with `x-wisp-preview: <port>`; this passes it to that port on the loopback,
//! websockets (dev servers' live reload) included. Off unless `WISP_PREVIEW_URL` is set; never this wisp's
//! own port (that would skip its checks). The page sees `Host: localhost:<port>` (dev servers refuse
//! other hosts) and nothing from wisp; a redirect to localhost:<port> stays on the preview's address.
use http::{HeaderMap, HeaderValue, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::respond::{self, Answer};

const HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "host",
    "http2-settings",
];

pub type PreviewClient = Client<HttpConnector, Incoming>;

pub fn client() -> PreviewClient {
    let mut c = HttpConnector::new();
    c.set_nodelay(true);
    Client::builder(TokioExecutor::new()).build(c)
}

/// The port asked for, or None: a real one, never this wisp's own.
pub fn preview_port(h: &HeaderMap, own: u16) -> Option<u16> {
    let raw = h.get("x-wisp-preview")?.to_str().ok()?;
    if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u16>().ok().filter(|p| *p >= 1 && *p != own)
}

/// What the page sees: no hop-by-hop headers, nothing from wisp, Host = localhost:<port>.
pub fn request_headers(h: &HeaderMap, port: u16, upgrade: bool) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(h.len());
    for (k, v) in h {
        let n = k.as_str();
        if !HOP.contains(&n) && !n.starts_with("x-wisp-") {
            out.append(k.clone(), v.clone());
        }
    }
    if let Ok(v) = HeaderValue::from_str(&format!("localhost:{port}")) {
        out.insert(http::header::HOST, v);
    }
    if upgrade {
        out.insert(
            http::header::CONNECTION,
            HeaderValue::from_static("Upgrade"),
        );
        if let Some(u) = h.get(http::header::UPGRADE) {
            out.insert(http::header::UPGRADE, u.clone());
        }
    }
    out
}

/// A redirect to <http://localhost>:<port>/x stays on the preview's address: /x.
pub fn local_redirect(location: &str, port: u16) -> String {
    let lower = location.to_ascii_lowercase();
    for scheme in ["http://", "https://"] {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let prefix = format!("{scheme}{host}:{port}");
            if lower.starts_with(&prefix) {
                let rest = &location[prefix.len()..];
                if rest.is_empty() {
                    return "/".into();
                }
                if rest.starts_with('/') {
                    return rest.to_owned();
                }
            }
        }
    }
    location.to_owned()
}

pub fn answer_headers(h: &HeaderMap, port: u16, upgrade: bool) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(h.len());
    for (k, v) in h {
        // an upgrade's answer keeps its Connection and Upgrade: the client needs them to switch
        let keep = !HOP.contains(&k.as_str())
            || (upgrade && (k == http::header::CONNECTION || k == http::header::UPGRADE));
        if keep {
            out.append(k.clone(), v.clone());
        }
    }
    if let Some(loc) = out
        .get(http::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(|l| local_redirect(l, port))
        && let Ok(v) = HeaderValue::from_str(&loc)
    {
        out.insert(http::header::LOCATION, v);
    }
    out
}

fn escape(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '<' | '>' | '&'))
        .collect()
}

/// Nothing answered on that port: a page saying so, in the frame.
pub fn failed_page(port: u16, refused: bool, detail: &str) -> Answer {
    let title = if refused {
        format!("Nothing answers on port {port} of this computer")
    } else {
        format!("Port {port} didn’t answer")
    };
    let text = if refused {
        "The server the agent started there has stopped, or listens on another port. Ask it to start it again."
    } else {
        detail
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{t}</title><style>body{{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#888;background:transparent}}div{{max-width:30em;padding:24px;text-align:center}}b{{display:block;color:#aaa;margin-bottom:6px}}</style><div><b>{t}</b>{x}</div>",
        t = escape(&title),
        x = escape(text)
    );
    respond::text(
        502,
        "text/html; charset=utf-8",
        body,
        &[("cache-control".into(), "no-store".into())],
    )
}

fn refused(e: &hyper_util::client::legacy::Error) -> bool {
    use std::error::Error;
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            return io.kind() == std::io::ErrorKind::ConnectionRefused;
        }
        src = s.source();
    }
    e.is_connect()
}

/// Passes the request to localhost:<port>; an upgrade (a websocket) is then piped both ways.
pub async fn forward(
    client: &PreviewClient,
    mut req: http::Request<Incoming>,
    port: u16,
) -> Answer {
    let upgrade = req.headers().contains_key(http::header::UPGRADE);
    let path = req
        .uri()
        .path_and_query()
        .map_or("/", http::uri::PathAndQuery::as_str)
        .to_owned();
    let Ok(uri) = format!("http://localhost:{port}{path}").parse::<http::Uri>() else {
        return failed_page(port, false, "bad path");
    };
    let server_side = upgrade.then(|| hyper::upgrade::on(&mut req));
    let headers = request_headers(req.headers(), port, upgrade);
    let (mut parts, body) = req.into_parts();
    parts.uri = uri;
    parts.headers = headers;
    parts.version = http::Version::HTTP_11;
    let mut resp = match client.request(http::Request::from_parts(parts, body)).await {
        Ok(r) => r,
        Err(e) => return failed_page(port, refused(&e), &e.to_string()),
    };
    let headers = answer_headers(resp.headers(), port, upgrade);
    let status = resp.status();
    if let (Some(server_side), StatusCode::SWITCHING_PROTOCOLS) = (server_side, status) {
        let client_side = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(a), Ok(b)) = (server_side.await, client_side.await) {
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
            }
        });
        let mut out = http::Response::new(respond::empty());
        *out.status_mut() = status;
        *out.headers_mut() = headers;
        return out;
    }
    let mut out = http::Response::new(resp.into_body().map_err(std::io::Error::other).boxed());
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn ports() {
        assert_eq!(
            preview_port(&hm(&[("x-wisp-preview", "5173")]), 4477),
            Some(5173)
        );
        assert_eq!(
            preview_port(&hm(&[("x-wisp-preview", "4477")]), 4477),
            None,
            "never this wisp itself"
        );
        for bad in ["0", "65536", "123456", "", "80a", "-1", " 80"] {
            assert_eq!(
                preview_port(&hm(&[("x-wisp-preview", bad)]), 4477),
                None,
                "{bad}"
            );
        }
        assert_eq!(preview_port(&hm(&[]), 4477), None);
    }

    #[test]
    fn the_page_sees_nothing_from_wisp() {
        let h = hm(&[
            ("host", "p5173--ada.grid.trywisp.dev"),
            ("x-wisp-proxy-secret", "s"),
            ("x-wisp-preview", "5173"),
            ("connection", "keep-alive"),
            ("cookie", "a=1"),
            ("accept", "text/html"),
        ]);
        let out = request_headers(&h, 5173, false);
        assert_eq!(out["host"], "localhost:5173");
        assert!(
            out.get("x-wisp-proxy-secret").is_none()
                && out.get("x-wisp-preview").is_none()
                && out.get("connection").is_none()
        );
        assert_eq!(out["cookie"], "a=1");
        let up = request_headers(
            &hm(&[("upgrade", "websocket"), ("connection", "Upgrade")]),
            5173,
            true,
        );
        assert_eq!(
            (
                up["connection"].to_str().unwrap(),
                up["upgrade"].to_str().unwrap()
            ),
            ("Upgrade", "websocket")
        );
    }

    #[test]
    fn redirects_stay_on_the_preview() {
        assert_eq!(
            local_redirect("http://localhost:5173/login?x=1", 5173),
            "/login?x=1"
        );
        assert_eq!(local_redirect("http://127.0.0.1:5173", 5173), "/");
        assert_eq!(local_redirect("https://[::1]:5173/a", 5173), "/a");
        assert_eq!(local_redirect("http://LOCALHOST:5173/a", 5173), "/a");
        assert_eq!(
            local_redirect("http://localhost:51730/a", 5173),
            "http://localhost:51730/a"
        );
        assert_eq!(
            local_redirect("https://github.com/login", 5173),
            "https://github.com/login"
        );
        assert_eq!(local_redirect("/rel", 5173), "/rel");
    }

    #[test]
    fn failed_page_says_why() {
        let a = failed_page(5173, true, "");
        assert_eq!(a.status(), 502);
        assert_eq!(a.headers()["cache-control"], "no-store");
    }
}
