//! Preview's proxy (v1 server/runs.js `#proxy`, ADR-0049): the task's app again on a port of its own on 127.0.0.1,
//! framable by the panel and with the element picker's script in its HTML pages. What's decided is
//! `wisp_terminal_core::pick`; this moves the bytes: a request from a loopback Host only, `/__wisp/pick.js` answered
//! here, everything else passed to the app (the port its output printed, else its PORT), the answer framable, an HTML
//! page (decompressed if the app compressed it anyway) with the script added, a websocket (live reload) piped both
//! ways. One per running Preview; it stops with the run.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io::Read as _;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use wisp_kernel::CancellationToken;
use wisp_terminal_core::pick;

type Body = BoxBody<Bytes, std::io::Error>;
type Upstream = Client<HttpConnector, Incoming>;

const HOP: [&str; 8] = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"];

fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|never| match never {}).boxed()
}

fn plain(status: u16, ctype: &str, body: impl Into<Bytes>) -> Response<Body> {
    let mut r = Response::new(full(body));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    if let Ok(v) = HeaderValue::from_str(ctype) {
        r.headers_mut().insert(http::header::CONTENT_TYPE, v);
    }
    r.headers_mut().insert(http::header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

/// What the app answered on: the port it printed, else the one it was given.
pub type Target = Arc<dyn Fn() -> u16 + Send + Sync>;

/// The proxies that run, by task.
#[derive(Default)]
pub struct Proxies {
    map: Mutex<HashMap<String, CancellationToken>>,
}

impl std::fmt::Debug for Proxies {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Proxies").finish_non_exhaustive()
    }
}

impl Proxies {
    /// Starts task `id`'s proxy on its port unless it runs already. False when the port can't be had (the panel then
    /// shows the app itself and doesn't offer Pick, as v1).
    pub async fn start(&self, id: &str, target: Target, parent: &CancellationToken) -> bool {
        if self.map.lock().unwrap_or_else(PoisonError::into_inner).get(id).is_some_and(|t| !t.is_cancelled()) {
            return true;
        }
        let port = pick::proxy_port_for(id);
        let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await else { return false };
        let stop = parent.child_token();
        self.map.lock().unwrap_or_else(PoisonError::into_inner).insert(id.to_owned(), stop.clone());
        let mut c = HttpConnector::new();
        c.set_nodelay(true);
        let upstream: Upstream = Client::builder(TokioExecutor::new()).build(c);
        tokio::spawn(async move {
            loop {
                let conn = tokio::select! {
                    () = stop.cancelled() => break,
                    c = listener.accept() => c,
                };
                let Ok((stream, _)) = conn else { continue };
                let (upstream, target) = (upstream.clone(), target.clone());
                let stop = stop.clone();
                tokio::spawn(async move {
                    let svc = service_fn(move |req| {
                        let (upstream, target) = (upstream.clone(), target.clone());
                        async move { Ok::<_, Infallible>(handle(&upstream, req, target()).await) }
                    });
                    let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).with_upgrades();
                    tokio::select! {
                        () = stop.cancelled() => {}
                        _ = conn => {}
                    }
                });
            }
        });
        true
    }

    /// Stops task `id`'s proxy (its run stopped).
    pub fn stop(&self, id: &str) {
        if let Some(t) = self.map.lock().unwrap_or_else(PoisonError::into_inner).remove(id) {
            t.cancel();
        }
    }

    /// Whether task `id`'s proxy runs.
    pub fn running(&self, id: &str) -> bool {
        self.map.lock().unwrap_or_else(PoisonError::into_inner).get(id).is_some_and(|t| !t.is_cancelled())
    }
}

fn header_pairs(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_owned(), v.to_owned()))).collect()
}

fn to_map(pairs: &[(String, String)]) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(pairs.len());
    for (k, v) in pairs {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            out.append(k, v);
        }
    }
    out
}

/// The app's body as text: plain, or decompressed when it compressed anyway (gzip, deflate, br). None if it can't be read.
fn decoded(bytes: &[u8], encoding: Option<&str>) -> Option<String> {
    let mut out = Vec::new();
    match encoding.map(|e| e.trim().to_ascii_lowercase()).as_deref() {
        None | Some("" | "identity") => out.extend_from_slice(bytes),
        Some("gzip" | "x-gzip") => {
            flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).ok()?;
        }
        Some("deflate") => {
            flate2::read::ZlibDecoder::new(bytes).read_to_end(&mut out).ok()?;
        }
        Some("br") => {
            brotli::Decompressor::new(bytes, 4096).read_to_end(&mut out).ok()?;
        }
        Some(_) => return None,
    }
    String::from_utf8(out).ok()
}

/// One request to the proxy.
async fn handle(upstream: &Upstream, mut req: Request<Incoming>, port: u16) -> Response<Body> {
    let host = req.headers().get(http::header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !pick::loopback_host(host) {
        return plain(403, "text/plain; charset=utf-8", "Only this computer's own page may open it.");
    }
    let path = req.uri().path_and_query().map_or("/", http::uri::PathAndQuery::as_str).to_owned();
    if req.uri().path() == pick::PICK_PATH {
        return plain(200, "text/javascript; charset=utf-8", pick::PICK_JS);
    }
    let method = req.method().as_str().to_owned();
    let upgrade = req.headers().contains_key(http::header::UPGRADE);
    let Ok(uri) = format!("http://localhost:{port}{path}").parse::<http::Uri>() else {
        return plain(400, "text/plain; charset=utf-8", "That isn't a path.");
    };
    let server_side = upgrade.then(|| hyper::upgrade::on(&mut req));
    let mut headers = HeaderMap::with_capacity(req.headers().len());
    for (k, v) in req.headers() {
        // over loopback, plain: a page the script goes into has to be readable here (v1 dropped accept-encoding)
        if !HOP.contains(&k.as_str()) && k != http::header::ACCEPT_ENCODING {
            headers.append(k.clone(), v.clone());
        }
    }
    if let Ok(v) = HeaderValue::from_str(&format!("localhost:{port}")) {
        headers.insert(http::header::HOST, v);
    }
    if upgrade {
        headers.insert(http::header::CONNECTION, HeaderValue::from_static("Upgrade"));
        if let Some(u) = req.headers().get(http::header::UPGRADE) {
            headers.insert(http::header::UPGRADE, u.clone());
        }
    }
    let (mut parts, body) = req.into_parts();
    parts.uri = uri;
    parts.headers = headers;
    parts.version = http::Version::HTTP_11;
    let mut resp = match upstream.request(Request::from_parts(parts, body)).await {
        Ok(r) => r,
        Err(e) => return plain(502, "text/html; charset=utf-8", failed_page(port, &e.to_string())),
    };
    let status = resp.status();
    let mut kept: Vec<(String, String)> = header_pairs(resp.headers()).into_iter().filter(|(k, _)| !HOP.contains(&k.as_str()) || (upgrade && (k == "connection" || k == "upgrade"))).collect();
    kept = pick::frameable(&kept);
    if let (Some(server_side), StatusCode::SWITCHING_PROTOCOLS) = (server_side, status) {
        let client_side = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(a), Ok(b)) = (server_side.await, client_side.await) {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
            }
        });
        let mut out = Response::new(full(Bytes::new()));
        *out.status_mut() = status;
        *out.headers_mut() = to_map(&kept);
        return out;
    }
    let ctype = resp.headers().get(http::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let length = resp.headers().get(http::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if pick::takes_picker(&method, ctype.as_deref(), length) {
        let encoding = resp.headers().get(http::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let Ok(collected) = resp.into_body().collect().await else { return plain(502, "text/html; charset=utf-8", failed_page(port, "the page broke off")) };
        let bytes = collected.to_bytes();
        // a page it can't read as text goes through as it came (without the picker)
        let (body, rewritten) = match decoded(&bytes, encoding.as_deref()) {
            Some(text) if u64::try_from(bytes.len()).unwrap_or(u64::MAX) <= pick::HTML_MAX => (Bytes::from(pick::with_picker(&text)), true),
            _ => (bytes, false),
        };
        if rewritten {
            // another body than the one the app's headers name
            kept.retain(|(k, _)| !matches!(k.as_str(), "content-encoding" | "content-length" | "etag"));
        }
        let mut out = Response::new(full(body));
        *out.status_mut() = status;
        *out.headers_mut() = to_map(&kept);
        return out;
    }
    let mut out = Response::new(resp.into_body().map_err(std::io::Error::other).boxed());
    *out.status_mut() = status;
    *out.headers_mut() = to_map(&kept);
    out
}

fn failed_page(port: u16, detail: &str) -> String {
    let clean: String = detail.chars().filter(|c| !matches!(c, '<' | '>' | '&')).collect();
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Nothing answers on port {port}</title><style>body{{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;color:#888}}div{{max-width:30em;padding:24px;text-align:center}}b{{display:block;color:#aaa;margin-bottom:6px}}</style><div><b>Nothing answers on port {port} yet</b>{clean}</div>"
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// v1 runs.js: an app that compresses anyway still gets the picker (gzip, deflate, br read back); an encoding it
    /// can't read, or bytes that aren't text, go through as they came.
    #[test]
    fn a_compressed_page_is_read_back_and_an_unreadable_one_goes_as_it_came() {
        let html = "<html><head></head><body>hi</body></html>";
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(html.as_bytes()).unwrap();
        assert_eq!(decoded(&gz.finish().unwrap(), Some("gzip")).as_deref(), Some(html));
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        z.write_all(html.as_bytes()).unwrap();
        assert_eq!(decoded(&z.finish().unwrap(), Some("deflate")).as_deref(), Some(html));
        let mut br = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut br, 4096, 5, 22);
            w.write_all(html.as_bytes()).unwrap();
        }
        assert_eq!(decoded(&br, Some("br")).as_deref(), Some(html));
        assert_eq!(decoded(html.as_bytes(), None).as_deref(), Some(html));
        assert_eq!(decoded(html.as_bytes(), Some("zstd")), None);
        assert_eq!(decoded(&[0xff, 0xfe, 0x00], None), None);
    }

    /// One raw HTTP/1.1 exchange over loopback: the answer's head and body as text.
    async fn get(port: u16, path: &str, host: &str) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// ADR-0049 / v1 runs.js: through the proxy the app is framable (X-Frame-Options and frame-ancestors gone, its
    /// other rules kept), its HTML page carries the picker once, `/__wisp/pick.js` is the script, a request whose Host
    /// isn't this computer's loopback is refused, the app never sees Accept-Encoding, and stopping it frees the port.
    #[tokio::test]
    async fn the_proxy_frames_the_app_adds_the_picker_and_refuses_a_foreign_host() {
        // the app: an HTML page that forbids framing, and says what Accept-Encoding it got
        let app = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let app_port = app.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = app.accept().await else { break };
                tokio::spawn(async move {
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let enc = req.headers().get(http::header::ACCEPT_ENCODING).map_or("none", |v| v.to_str().unwrap_or("?")).to_owned();
                        let mut r = Response::new(full(format!("<!doctype html><html><head><title>app</title></head><body>enc={enc}</body></html>")));
                        r.headers_mut().insert(http::header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
                        r.headers_mut().insert("x-frame-options", HeaderValue::from_static("DENY"));
                        r.headers_mut().insert("content-security-policy", HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'"));
                        Ok::<_, Infallible>(r)
                    });
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
                });
            }
        });
        let proxies = Proxies::default();
        let scope = CancellationToken::new();
        let id = format!("proxy-test-{}", wisp_kernel::ids::uuid7());
        assert!(proxies.start(&id, Arc::new(move || app_port), &scope).await, "the proxy's port");
        let port = pick::proxy_port_for(&id);

        let page = get(port, "/", &format!("localhost:{port}")).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        let lower = page.to_ascii_lowercase();
        assert!(!lower.contains("x-frame-options"), "{page}");
        assert!(lower.contains("content-security-policy: default-src 'self'") && !lower.contains("frame-ancestors"), "{page}");
        assert_eq!(page.matches("<script src=\"/__wisp/pick.js\"></script>").count(), 1, "{page}");
        assert!(page.contains("<head><script src=\"/__wisp/pick.js\"></script><title>"), "as early as it can go: {page}");
        assert!(page.contains("enc=none"), "the app is asked for plain bytes: {page}");

        let js = get(port, "/__wisp/pick.js", &format!("127.0.0.1:{port}")).await;
        assert!(js.contains("text/javascript") && js.contains("wisp: 'pick'"), "{js}");

        let foreign = get(port, "/", &format!("evil.example:{port}")).await;
        assert!(foreign.starts_with("HTTP/1.1 403"), "{foreign}");

        proxies.stop(&id);
        assert!(!proxies.running(&id));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok(), "stopped: the port is free again");
    }
}
