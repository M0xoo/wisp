//! Writing answers (v1 http/respond.js, edge case 5). The API speaks JSON; a few routes stream. A JSON
//! answer of 8 KB or more goes with a weak ETag (`private, no-cache`: the browser always asks, nothing in
//! between keeps it) so an unchanged re-read over the phone's tunnel costs a 304, and compressed: brotli
//! q4 when the client takes it (every browser does), else gzip 1, both off the runtime threads. A
//! prepared answer (the task list) keeps its text, ETag and compressed copies for as long as it lives.
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, Weak};

use base64::Engine;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use http_body_util::{BodyExt, Full, StreamBody, combinators::BoxBody};
use hyper::body::Frame;
use serde_json::Value;

use crate::trust::header;

pub type Body = BoxBody<Bytes, std::io::Error>;
pub type Answer = http::Response<Body>;

/// Below this a JSON answer goes as is: compressing costs more than it saves.
pub const COMPRESS_MIN: usize = 8 * 1024;

pub fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|never| match never {}).boxed()
}

pub fn empty() -> Body {
    full(Bytes::new())
}

/// A body fed by a channel (SSE, terminal output): ends when the sender is dropped.
pub fn channel(rx: tokio::sync::mpsc::Receiver<Bytes>) -> Body {
    let s = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (Ok(Frame::data(b)), rx)) });
    StreamBody::new(s).boxed()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Encoding {
    Br,
    Gzip,
}

impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Self::Br => "br",
            Self::Gzip => "gzip",
        }
    }
}

fn word(list: &str, w: &str) -> bool {
    list.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).any(|t| t.eq_ignore_ascii_case(w))
}

/// From Accept-Encoding: br (every browser), gzip, or none.
pub fn encoding_for(h: &HeaderMap) -> Option<Encoding> {
    let ae = header(h, "accept-encoding").unwrap_or("");
    if word(ae, "br") {
        Some(Encoding::Br)
    } else if word(ae, "gzip") {
        Some(Encoding::Gzip)
    } else {
        None
    }
}

pub fn weak_etag(body: &[u8]) -> String {
    let h = blake3::hash(body);
    format!("W/\"{}\"", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&h.as_bytes()[..18]))
}

pub fn compress(enc: Encoding, body: &[u8], quality: u32) -> std::io::Result<Vec<u8>> {
    match enc {
        Encoding::Br => {
            let mut out = Vec::with_capacity(body.len() / 4);
            {
                let mut w = brotli::CompressorWriter::new(&mut out, 64 * 1024, quality, 22);
                w.write_all(body)?;
            }
            Ok(out)
        }
        Encoding::Gzip => {
            let mut e = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 3), flate2::Compression::new(quality));
            e.write_all(body)?;
            e.finish()
        }
    }
}

/// Compressed on the blocking pool: a full session can be megabytes.
pub async fn compress_off_thread(enc: Encoding, body: Bytes, quality: u32) -> Option<Bytes> {
    tokio::task::spawn_blocking(move || compress(enc, &body, quality).ok().map(Bytes::from)).await.ok().flatten()
}

/// What a JSON answer needs to know about the request.
#[derive(Debug, Clone, Default)]
pub struct Asked {
    pub get: bool,
    pub if_none_match: Option<String>,
    pub enc: Option<Encoding>,
}

impl Asked {
    pub fn of(method: &Method, h: &HeaderMap) -> Self {
        Self { get: method == Method::GET || method == Method::HEAD, if_none_match: header(h, "if-none-match").map(str::to_owned), enc: encoding_for(h) }
    }
}

/// A prepared answer's text, ETag and compressed copies.
#[derive(Debug, Default)]
struct Kept {
    json: Bytes,
    etag: String,
    out: HashMap<Encoding, Bytes>,
}

/// Prepared answers by identity: the Arc a plugin hands back again while its list is unchanged.
#[derive(Debug, Default)]
pub struct PreparedCache {
    map: Mutex<HashMap<usize, (Weak<Value>, Arc<Mutex<Kept>>)>>,
}

impl PreparedCache {
    fn kept(&self, v: &Arc<Value>) -> Arc<Mutex<Kept>> {
        let key = Arc::as_ptr(v) as usize;
        let Ok(mut map) = self.map.lock() else { return Arc::default() };
        if let Some((w, k)) = map.get(&key) {
            if w.upgrade().is_some_and(|alive| Arc::ptr_eq(&alive, v)) {
                return k.clone();
            }
        }
        if map.len() >= 64 {
            map.retain(|_, (w, _)| w.strong_count() > 0);
        }
        let json = Bytes::from(serde_json::to_vec(&**v).unwrap_or_default());
        let k = Arc::new(Mutex::new(Kept { etag: weak_etag(&json), json, out: HashMap::new() }));
        map.insert(key, (Arc::downgrade(v), k.clone()));
        k
    }
}

fn base(status: u16) -> http::response::Builder {
    http::Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)).header("content-type", "application/json")
}

pub fn not_modified(etag: &str) -> Answer {
    let mut r = http::Response::new(empty());
    *r.status_mut() = StatusCode::NOT_MODIFIED;
    if let Ok(v) = HeaderValue::from_str(etag) {
        r.headers_mut().insert("etag", v);
    }
    r.headers_mut().insert("cache-control", HeaderValue::from_static("private, no-cache"));
    r
}

/// A JSON answer from its serialized text. `kept`: a prepared answer's cache of compressed copies.
async fn json_bytes(status: u16, json: Bytes, etag: Option<String>, asked: &Asked, extra: &[(String, String)], kept: Option<&Arc<Mutex<Kept>>>) -> Answer {
    let big = json.len() >= COMPRESS_MIN;
    let mut b = base(status);
    for (k, v) in extra {
        b = b.header(k.as_str(), v.as_str());
    }
    if status == 200 && big && asked.get {
        let etag = etag.unwrap_or_else(|| weak_etag(&json));
        if asked.if_none_match.as_deref() == Some(etag.as_str()) {
            return not_modified(&etag);
        }
        b = b.header("etag", etag).header("cache-control", "private, no-cache");
    }
    let enc = if big { asked.enc } else { None };
    let Some(enc) = enc else { return b.body(full(json)).unwrap_or_else(|_| http::Response::new(empty())) };
    let cached = kept.and_then(|k| k.lock().ok().and_then(|k| k.out.get(&enc).cloned()));
    let quality = if enc == Encoding::Br { 4 } else { 1 };
    let out = match cached {
        Some(c) => Some(c),
        None => compress_off_thread(enc, json.clone(), quality).await,
    };
    match out {
        Some(out) => {
            if let Some(k) = kept {
                if let Ok(mut k) = k.lock() {
                    k.out.insert(enc, out.clone());
                }
            }
            b.header("content-encoding", enc.name()).header("vary", "accept-encoding").body(full(out))
        }
        None => b.body(full(json)),
    }
    .unwrap_or_else(|_| http::Response::new(empty()))
}

pub async fn json(status: u16, body: &Value, asked: &Asked, extra: &[(String, String)]) -> Answer {
    let bytes = Bytes::from(serde_json::to_vec(body).unwrap_or_else(|_| b"null".to_vec()));
    json_bytes(status, bytes, None, asked, extra, None).await
}

pub async fn prepared(cache: &PreparedCache, status: u16, body: &Arc<Value>, asked: &Asked) -> Answer {
    let kept = cache.kept(body);
    let (json, etag) = match kept.lock() {
        Ok(k) => (k.json.clone(), k.etag.clone()),
        Err(_) => (Bytes::from(serde_json::to_vec(&**body).unwrap_or_default()), String::new()),
    };
    json_bytes(status, json, Some(etag).filter(|e| !e.is_empty()), asked, &[], Some(&kept)).await
}

/// A small JSON answer that never compresses (errors, refusals).
pub fn plain_json(status: u16, body: &Value) -> Answer {
    base(status).body(full(serde_json::to_vec(body).unwrap_or_default())).unwrap_or_else(|_| http::Response::new(empty()))
}

pub fn text(status: u16, content_type: &str, body: impl Into<Bytes>, extra: &[(String, String)]) -> Answer {
    let mut b = http::Response::builder().status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK)).header("content-type", content_type);
    for (k, v) in extra {
        b = b.header(k.as_str(), v.as_str());
    }
    b.body(full(body)).unwrap_or_else(|_| http::Response::new(empty()))
}

pub fn redirect(status: u16, location: &str) -> Answer {
    http::Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::FOUND))
        .header("location", location)
        .header("cache-control", "no-store")
        .body(empty())
        .unwrap_or_else(|_| http::Response::new(empty()))
}
