//! Compression off the runtime threads, `/_pack`, and big files streamed with byte ranges.
//! Brotli q11 is fed in 64 KB slices, each its own blocking job checked against `stop`: one big job
//! held v1's exit for 10 s (edge case 7), many short ones let a wisp stopped right after start go.
use std::io::{SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use http::{HeaderMap, Method};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{Entry, SLICE, StaticFiles, hash};
use crate::respond::{self, Answer, Encoding, compress_off_thread, encoding_for};
use crate::trust::header;

/// Brotli in slices; None when stopped or failed.
pub(crate) async fn brotli_slices(body: Bytes, quality: u32, lgwin: u32, stop: &CancellationToken) -> Option<Bytes> {
    let mut w = brotli::CompressorWriter::new(Vec::with_capacity(body.len() / 4), 4096, quality, lgwin);
    let mut at = 0;
    while at < body.len() {
        if stop.is_cancelled() {
            return None;
        }
        let slice = body.slice(at..(at + SLICE).min(body.len()));
        at += slice.len();
        w = tokio::task::spawn_blocking(move || w.write_all(&slice).map(|()| w)).await.ok()?.ok()?;
    }
    tokio::task::spawn_blocking(move || Bytes::from(w.into_inner())).await.ok()
}

/// One file at a time: gzip 9, then brotli. The plain body serves until each copy lands.
pub(crate) async fn compressor(mut rx: mpsc::UnboundedReceiver<(Arc<Entry>, u32)>, stop: CancellationToken) {
    loop {
        let next = tokio::select! {
            () = stop.cancelled() => return,
            n = rx.recv() => n,
        };
        let Some((e, lgwin)) = next else { return };
        compress_entry(&e, lgwin, &stop).await;
    }
}

async fn compress_entry(e: &Entry, lgwin: u32, stop: &CancellationToken) {
    if e.gz.get().is_none()
        && let Some(gz) = compress_off_thread(Encoding::Gzip, e.body.clone(), 9).await
    {
        let _ = e.gz.set(gz);
    }
    if e.br.get().is_none()
        && let Some(br) = brotli_slices(e.body.clone(), 11, lgwin, stop).await
    {
        let _ = e.br.set(br);
    }
}

/// Every module as one JSON answer `{url: text}`, minus those the worker has (`have`: urls or hashes).
pub(crate) async fn pack_for(s: &StaticFiles, have: &[String]) -> Option<(String, Arc<Entry>)> {
    let build = s.index_page().await.map(|p| p.build.clone()).unwrap_or_default();
    let all = have.is_empty();
    if all
        && let Some((b, e)) = s.pack.lock().ok()?.as_ref()
        && *b == build
    {
        return Some((build, e.clone()));
    }
    let mut out = serde_json::Map::new();
    for f in s.all().await {
        if !matches!(f.extension().and_then(|e| e.to_str()), Some("js" | "mjs")) {
            continue;
        }
        let url = s.url(&f);
        let Some(e) = s.read(&f).await else { continue };
        if have.iter().any(|h| *h == url || *h == e.etag.trim_matches('"')) {
            continue;
        }
        out.insert(url, String::from_utf8_lossy(&e.body).into_owned().into());
    }
    let body = Bytes::from(serde_json::to_vec(&out).unwrap_or_default());
    let entry = Arc::new(Entry::new(body.clone(), format!("\"{}\"", hash(&body)), true));
    if all {
        *s.pack.lock().ok()? = Some((build.clone(), entry.clone()));
        let (e, stop) = (entry.clone(), s.stop.clone());
        tokio::spawn(async move { compress_entry(&e, 24, &stop).await });
    }
    Some((build, entry))
}

fn have_of(query: Option<&str>) -> Vec<String> {
    let raw = query.unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("have=")).unwrap_or("");
    raw.split(',').filter(|s| !s.is_empty()).map(|s| crate::router::percent_decode(s).unwrap_or_else(|| s.to_owned())).collect()
}

pub(crate) async fn serve(s: &StaticFiles, method: &Method, query: Option<&str>, h: &HeaderMap) -> Answer {
    let have = have_of(query);
    let Some((build, p)) = s.pack_for(&have).await else {
        return respond::text(503, "text/plain; charset=utf-8", "The web app is not built", &[]);
    };
    let gzip_ok = header(h, "accept-encoding").is_some_and(|a| a.contains("gzip"));
    let (name, body) = match encoding_for(h) {
        Some(Encoding::Br) if p.br.get().is_some() => (Some("br"), p.br.get().cloned()),
        _ if gzip_ok && p.gz.get().is_some() => (Some("gzip"), p.gz.get().cloned()),
        // not compressed yet (asked right after a start, or a partial pack): quickly, off the threads
        Some(Encoding::Br) => (Some("br"), compress_off_thread(Encoding::Br, p.body.clone(), 5).await),
        Some(Encoding::Gzip) => (Some("gzip"), compress_off_thread(Encoding::Gzip, p.body.clone(), 6).await),
        None => (None, None),
    };
    let (name, body) = match body {
        Some(b) => (name, b),
        None => (None, p.body.clone()),
    };
    let mut b = http::Response::builder()
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .header("x-wisp-build", build)
        .header("vary", "accept-encoding")
        .header("content-length", body.len());
    if let Some(n) = name {
        b = b.header("content-encoding", n);
    }
    let body = if method == Method::HEAD { respond::empty() } else { respond::full(body) };
    b.status(200).body(body).unwrap_or_else(|_| http::Response::new(respond::empty()))
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`: Some(Ok(range)), Some(Err) for a 416, None for none.
pub fn parse_range(v: Option<&str>, size: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = v?.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() && b.is_empty() {
        return None;
    }
    let num = |s: &str| s.parse::<u64>().ok();
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (false, false) => (num(a)?, num(b)?.min(size.saturating_sub(1))),
        (false, true) => (num(a)?, size.saturating_sub(1)),
        _ => (size.saturating_sub(num(b)?), size.saturating_sub(1)),
    };
    Some(if start >= size || start > end { Err(()) } else { Ok((start, end)) })
}

/// A file too big to hold, streamed from disk in 64 KB reads, with byte ranges (a video seeks).
pub(crate) async fn stream_file(file: &Path, content_type: &str, size: u64, method: &Method, h: &HeaderMap) -> Answer {
    let b =
        http::Response::builder().header("content-type", content_type).header("cache-control", "no-cache").header("accept-ranges", "bytes");
    let (status, start, len, b) = match parse_range(header(h, "range"), size) {
        Some(Err(())) => {
            return b
                .status(416)
                .header("content-range", format!("bytes */{size}"))
                .body(respond::empty())
                .unwrap_or_else(|_| http::Response::new(respond::empty()));
        }
        Some(Ok((s, e))) => (206, s, e - s + 1, b.header("content-range", format!("bytes {s}-{e}/{size}"))),
        None => (200, 0, size, b),
    };
    let b = b.status(status).header("content-length", len);
    if method == Method::HEAD {
        return b.body(respond::empty()).unwrap_or_else(|_| http::Response::new(respond::empty()));
    }
    let Ok(mut f) = tokio::fs::File::open(file).await else {
        return respond::text(404, "text/plain; charset=utf-8", "not found", &[]);
    };
    if f.seek(SeekFrom::Start(start)).await.is_err() {
        return respond::text(500, "text/plain; charset=utf-8", "seek failed", &[]);
    }
    let s = futures::stream::unfold((f.take(len), vec![0u8; SLICE]), |(mut r, mut buf)| async move {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => None,
            Ok(n) => Some((Ok(Frame::data(Bytes::copy_from_slice(&buf[..n]))), (r, buf))),
        }
    });
    b.body(StreamBody::new(s).boxed()).unwrap_or_else(|_| http::Response::new(respond::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Some(Ok((0, 99))));
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range(Some("bytes=-100"), 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range(Some("bytes=990-2000"), 1000), Some(Ok((990, 999))));
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), Some(Err(())));
        assert_eq!(parse_range(Some("bytes=50-10"), 1000), Some(Err(())));
        assert_eq!(parse_range(Some("bytes=-"), 1000), None);
        assert_eq!(parse_range(Some("items=0-1"), 1000), None);
        assert_eq!(parse_range(None, 1000), None);
    }

    #[tokio::test]
    async fn brotli_in_slices_round_trips_and_stops() {
        let body = Bytes::from("wisp ".repeat(60_000));
        let br = brotli_slices(body.clone(), 11, 22, &CancellationToken::new()).await.unwrap();
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut brotli::Decompressor::new(&br[..], 4096), &mut out).unwrap();
        assert_eq!(out, body);
        let stop = CancellationToken::new();
        stop.cancel();
        assert!(brotli_slices(body, 11, 22, &stop).await.is_none());
    }
}
