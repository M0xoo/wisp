//! Small HTTP helpers every part of the grid answers with: the body type, cookies, request bodies, the
//! response shapes, the caller's address behind Caddy, and the rate limiter.
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::Mutex;

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use serde_json::{Map, Value};

use crate::error::{GridError, Result, bad};

/// Every response body: whole (`full`), or streamed (a proxied box, SSE, a file).
pub type Body = BoxBody<Bytes, std::io::Error>;
pub type Resp = Response<Body>;
/// What comes in: hyper's streaming body.
pub type Req = http::Request<hyper::body::Incoming>;

pub fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|e: Infallible| match e {}).boxed()
}

pub fn empty() -> Body {
    full(Bytes::new())
}

pub const BODY_LIMIT: usize = 64 * 1024;

/// Read a whole body, up to `limit` bytes (413 past it).
pub async fn read_bytes<B>(body: B, limit: usize) -> Result<Bytes>
where
    B: hyper::body::Body<Data = Bytes> + Send + Unpin,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let limited = http_body_util::Limited::new(body, limit);
    match limited.collect().await {
        Ok(c) => Ok(c.to_bytes()),
        Err(e) if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() => Err(bad("Too much data.", 413)),
        Err(e) => Err(GridError::Upstream(format!("reading the request: {e}"))),
    }
}

/// A form or JSON body as an object. Fields are strings for a form, anything for JSON.
pub fn parse_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Map<String, Value>> {
    let ct = header_str(headers, "content-type");
    if ct.starts_with("application/json") {
        if bytes.is_empty() {
            return Ok(Map::new());
        }
        let v: Value = serde_json::from_slice(bytes).map_err(|_| bad("Bad JSON.", 400))?;
        return Ok(match v {
            Value::Object(o) => o,
            _ => Map::new(),
        });
    }
    Ok(url::form_urlencoded::parse(bytes).map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect())
}

/// A body field as a string ("" when absent or not a string-like value).
pub fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// A header as text ("" when absent or not text).
pub fn header_str<'a>(h: &'a HeaderMap, name: &str) -> &'a str {
    h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

pub fn cookies(h: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in h.get_all(header::COOKIE) {
        let Ok(line) = line.to_str() else { continue };
        for part in line.split(';') {
            let Some((k, v)) = part.split_once('=') else {
                continue;
            };
            let k = k.trim();
            if k.is_empty() {
                continue;
            }
            // a cookie someone else's page set, badly encoded: not ours to read
            if let Ok(v) = percent_decode(v.trim()) {
                out.insert(k.to_owned(), v);
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> std::result::Result<String, ()> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or(())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// encodeURIComponent.
pub fn encode_component(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CookieOptions<'a> {
    pub secure: bool,
    pub max_age: Option<i64>,
    pub path: Option<&'a str>,
    pub framed: bool,
}

/// A Set-Cookie value. framed: a preview's cookie, set inside a frame of another site (wisp on a
/// computer shows a box's page in its own window): SameSite=None, which needs Secure (https, or
/// *.localhost that browsers count as secure), and Partitioned, so it's kept for that one page and
/// third-party cookie blocking leaves it alone. Previews check Origin on anything but GET.
pub fn cookie(name: &str, value: &str, o: CookieOptions<'_>) -> String {
    let mut parts = vec![format!("{name}={}", encode_component(value)), format!("Path={}", o.path.unwrap_or("/")), "HttpOnly".to_owned()];
    if o.framed {
        parts.extend(["SameSite=None".to_owned(), "Secure".to_owned(), "Partitioned".to_owned()]);
    } else {
        parts.push("SameSite=Lax".to_owned());
        if o.secure {
            parts.push("Secure".to_owned());
        }
    }
    if let Some(m) = o.max_age {
        parts.push(format!("Max-Age={m}"));
    }
    parts.join("; ")
}

pub const SECURITY: [(&str, &str); 3] =
    [("x-content-type-options", "nosniff"), ("referrer-policy", "same-origin"), ("x-frame-options", "DENY")];

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

fn set(h: &mut HeaderMap, k: &'static str, v: &str) {
    if let Ok(v) = HeaderValue::from_str(v) {
        h.insert(k, v);
    }
}

/// A response with headers given as pairs (later ones win; a value of "" drops a default).
pub fn respond(code: u16, ct: &str, body: Body, extra: &[(&'static str, String)]) -> Resp {
    let mut r = Response::new(body);
    *r.status_mut() = status(code);
    let h = r.headers_mut();
    if !ct.is_empty() {
        set(h, "content-type", ct);
    }
    set(h, "cache-control", "no-store");
    for (k, v) in extra {
        if v.is_empty() {
            h.remove(*k);
        } else {
            set(h, k, v);
        }
    }
    r
}

/// An HTML page, with SECURITY's headers (an `extra` value of "" drops one: a shared task may be framed).
pub fn html(code: u16, body: impl Into<Bytes>, extra: &[(&'static str, String)]) -> Resp {
    let mut all: Vec<(&'static str, String)> = SECURITY.iter().map(|(k, v)| (*k, (*v).to_owned())).collect();
    all.extend_from_slice(extra);
    respond(code, "text/html; charset=utf-8", full(body), &all)
}

pub fn json(code: u16, body: &Value) -> Resp {
    json_with(code, body, &[])
}

pub fn json_with(code: u16, body: &Value, extra: &[(&'static str, String)]) -> Resp {
    respond(code, "application/json", full(body.to_string()), extra)
}

pub fn redirect(to: &str, extra: &[(&'static str, String)]) -> Resp {
    let mut all = vec![("location", to.to_owned())];
    all.extend_from_slice(extra);
    respond(302, "", empty(), &all)
}

/// Append a Set-Cookie (several may be set at once).
pub fn add_cookie(r: &mut Resp, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        r.headers_mut().append(header::SET_COOKIE, v);
    }
}

/// Only paths on the same site: never an absolute URL or //host. Browsers drop tabs and newlines from
/// a Location before reading it, so "/\t/evil.example" would be //evil.example: no control characters.
pub fn safe_path<'a>(p: &'a str, default: &'a str) -> &'a str {
    let ok = p.starts_with('/') && !matches!(p.as_bytes().get(1), Some(b'/' | b'\\')) && !p.bytes().any(|b| b < 0x20 || b == 0x7f);
    if ok { p } else { default }
}

/// A page a browser opened (not a fetch).
pub fn wants_html(method: &http::Method, h: &HeaderMap) -> bool {
    method == http::Method::GET && header_str(h, "accept").contains("text/html") && header_str(h, "sec-fetch-dest") != "empty"
}

pub fn is_loopback(ip: &str) -> bool {
    let ip = ip.strip_prefix("::ffff:").unwrap_or(ip);
    ip == "127.0.0.1" || ip == "::1"
}

/// Behind Caddy (deploy/Caddyfile) every request comes from loopback: who's asking is the address Caddy
/// put last in X-Forwarded-For. Without this, everyone shares one rate limit, and anyone can use up the
/// tunnels' (or sign-ins') for all.
pub fn client_ip(peer: Option<IpAddr>, h: &HeaderMap) -> String {
    let at = peer.map(|p| p.to_string()).unwrap_or_default();
    if !is_loopback(&at) {
        return at;
    }
    header_str(h, "x-forwarded-for").rsplit(',').next().map(str::trim).filter(|s| !s.is_empty()).map_or(at, str::to_owned)
}

/// A sliding window per key: n requests in any minute. Refused ones aren't kept, so a key holds n at most.
pub const LIMIT_WINDOW: i64 = 60_000;

#[derive(Debug, Default)]
pub struct Limiter {
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl Limiter {
    /// One more hit on `key` at `now` (ms): a 429 past `n` in the last minute.
    pub fn hit(&self, key: &str, n: usize, now: i64) -> Result<()> {
        let mut hits = self.hits.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Sweep keys whose last hit left the window, now and then, so the map stays small.
        if hits.len() > 4096 {
            hits.retain(|_, at| at.last().is_some_and(|t| now - t < LIMIT_WINDOW));
        }
        let at = hits.entry(key.to_owned()).or_default();
        at.retain(|t| now - t < LIMIT_WINDOW);
        if at.len() >= n {
            return Err(bad("Too many requests. Wait a minute.", 429));
        }
        at.push(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_paths() {
        assert_eq!(safe_path("/a/b", "/"), "/a/b");
        assert_eq!(safe_path("//evil", "/"), "/");
        assert_eq!(safe_path("/\\evil", "/"), "/");
        assert_eq!(safe_path("/\t/evil.example", "/"), "/");
        assert_eq!(safe_path("https://x", "/"), "/");
    }

    #[test]
    fn cookies_round_trip() {
        let c = cookie("grid", "a b;c", CookieOptions { secure: true, max_age: Some(60), ..Default::default() });
        assert_eq!(c, "grid=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60");
        let f = cookie("p", "v", CookieOptions { framed: true, ..Default::default() });
        assert!(f.contains("SameSite=None; Secure; Partitioned"));
        let mut h = HeaderMap::new();
        h.insert("cookie", HeaderValue::from_static("grid=a%20b%3Bc; bad=%zz; x=1"));
        let got = cookies(&h);
        assert_eq!(got["grid"], "a b;c");
        assert!(!got.contains_key("bad"));
        assert_eq!(got["x"], "1");
    }

    #[test]
    fn client_ip_behind_caddy() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("1.1.1.1, 9.9.9.9"));
        assert_eq!(client_ip("127.0.0.1".parse().ok(), &h), "9.9.9.9");
        assert_eq!(client_ip("8.8.8.8".parse().ok(), &h), "8.8.8.8");
    }

    #[test]
    fn limiter_window() {
        let l = Limiter::default();
        for _ in 0..3 {
            l.hit("k", 3, 0).unwrap();
        }
        assert_eq!(l.hit("k", 3, 10).unwrap_err().status(), 429);
        l.hit("k", 3, LIMIT_WINDOW).unwrap();
    }

    #[test]
    fn bodies() {
        let mut h = HeaderMap::new();
        h.insert("content-type", HeaderValue::from_static("application/x-www-form-urlencoded"));
        let b = parse_body(&h, b"a=1&b=x+y").unwrap();
        assert_eq!(str_of(b.get("b")), "x y");
        h.insert("content-type", HeaderValue::from_static("application/json"));
        assert_eq!(parse_body(&h, b"[1]").unwrap().len(), 0);
        assert_eq!(parse_body(&h, b"{").unwrap_err().status(), 400);
    }
}
