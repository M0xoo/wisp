//! The web UI (v1 http/static.js, edge cases 6–7): apps/web's built files, with index.html for every other
//! path (the app routes itself). The phone loads it through an SSH tunnel where each round trip is slow:
//! - every file up to 4 MB is read once into memory, hashed, and compressed once (gzip 9, brotli 11 in
//!   64 KB slices on the blocking pool, one file at a time; the plain body serves until it's ready);
//! - content-named files (`assets/x-<hash>.js`) are cached for a year; anything else is no-cache and
//!   revalidates by `ETag`; bigger files (videos) are streamed from disk with byte ranges;
//! - index.html names the build (meta wisp-build and `x-wisp-build`), and the phone's first open gets
//!   the boot page whose modules wait for the service worker, which fetches them all at once: `/_pack`.
mod html;
mod pack;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use http::{HeaderMap, Method};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::respond::{self, Answer, Encoding, encoding_for};
use crate::trust::header;

pub use html::{hashed, mime, pages, wants_boot};

/// Bigger files are streamed with ranges, not held.
pub const MAX_CACHED: u64 = 4_000_000;
pub const SLICE: usize = 64 * 1024;
const PAGE_RECHECK: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) body: Bytes,
    pub(crate) etag: String,
    mtime: Option<SystemTime>,
    size: u64,
    text: bool,
    pub(crate) gz: OnceLock<Bytes>,
    pub(crate) br: OnceLock<Bytes>,
}

impl Entry {
    pub(crate) fn new(body: Bytes, etag: String, text: bool) -> Self {
        Self { size: body.len() as u64, body, etag, mtime: None, text, gz: OnceLock::new(), br: OnceLock::new() }
    }
}

#[derive(Debug)]
struct Page {
    build: String,
    normal: Arc<Entry>,
    boot: Arc<Entry>,
}

pub(crate) fn hash(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&blake3::hash(b).as_bytes()[..15])
}

#[derive(Debug)]
pub struct StaticFiles {
    dir: PathBuf,
    files: Mutex<HashMap<PathBuf, Arc<Entry>>>,
    page: tokio::sync::Mutex<Option<(Instant, Arc<Page>)>>,
    pack: Mutex<Option<(String, Arc<Entry>)>>,
    queue: mpsc::UnboundedSender<(Arc<Entry>, u32)>,
    stop: CancellationToken,
}

impl StaticFiles {
    /// `stop`: cancelled on shutdown, so a compression in flight ends at its next slice.
    pub fn new(dir: impl Into<PathBuf>, stop: CancellationToken) -> Arc<Self> {
        let (queue, rx) = mpsc::unbounded_channel();
        tokio::spawn(pack::compressor(rx, stop.clone()));
        Arc::new(Self {
            dir: dir.into(),
            files: Mutex::default(),
            page: tokio::sync::Mutex::default(),
            pack: Mutex::default(),
            queue,
            stop,
        })
    }

    fn index(&self) -> PathBuf {
        self.dir.join("index.html")
    }

    /// Read (or the cached copy while its mtime and size hold: a rebuild shows at once).
    async fn read(&self, file: &Path) -> Option<Arc<Entry>> {
        let st = tokio::fs::metadata(file).await.ok().filter(std::fs::Metadata::is_file)?;
        let mtime = st.modified().ok();
        if let Some(had) = self.files.lock().ok()?.get(file).cloned()
            && had.mtime == mtime
            && had.size == st.len()
        {
            return Some(had);
        }
        if st.len() > MAX_CACHED {
            return Some(Arc::new(Entry { mtime, size: st.len(), ..Entry::new(Bytes::new(), String::new(), false) }));
        }
        let body = Bytes::from(tokio::fs::read(file).await.ok()?);
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
        let text = html::is_text(ext) && body.len() > 1024;
        let e = Arc::new(Entry { mtime, size: st.len(), ..Entry::new(body.clone(), format!("\"{}\"", hash(&body)), text) });
        if text {
            let _ = self.queue.send((e.clone(), 22));
        }
        self.files.lock().ok()?.insert(file.to_owned(), e.clone());
        Some(e)
    }

    /// Every file under the bundle, sorted (the build hash and the pack depend on the order).
    async fn all(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut dirs = vec![self.dir.clone()];
        while let Some(d) = dirs.pop() {
            let Ok(mut rd) = tokio::fs::read_dir(&d).await else {
                continue;
            };
            while let Ok(Some(ent)) = rd.next_entry().await {
                match ent.file_type().await {
                    Ok(t) if t.is_dir() => dirs.push(ent.path()),
                    Ok(t) if t.is_file() => out.push(ent.path()),
                    _ => {}
                }
            }
        }
        out.sort();
        out
    }

    fn url(&self, file: &Path) -> String {
        let rel = file.strip_prefix(&self.dir).unwrap_or(file);
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        format!("/{}", parts.join("/"))
    }

    /// index.html with the build named, and its boot twin (re-checked at most every 2 s).
    async fn index_page(&self) -> Option<Arc<Page>> {
        let mut slot = self.page.lock().await;
        if let Some((at, p)) = slot.as_ref()
            && at.elapsed() < PAGE_RECHECK
        {
            return Some(p.clone());
        }
        let mut tags = String::new();
        for f in self.all().await {
            if let Some(e) = self.read(&f).await {
                tags.push_str(&e.etag);
                tags.push(',');
            }
        }
        let build = hash(tags.as_bytes())[..16].to_owned();
        if let Some((_, p)) = slot.as_ref().filter(|(_, p)| p.build == build) {
            let p = p.clone();
            *slot = Some((Instant::now(), p.clone()));
            return Some(p);
        }
        let src = self.read(&self.index()).await?;
        let (normal, boot) = pages(&String::from_utf8_lossy(&src.body), &build);
        let make = |text: String, etag: String| {
            let e = Arc::new(Entry::new(Bytes::from(text), etag, true));
            let _ = self.queue.send((e.clone(), 11));
            e
        };
        let page = Arc::new(Page { normal: make(normal, format!("\"{build}\"")), boot: make(boot, format!("\"{build}-boot\"")), build });
        *slot = Some((Instant::now(), page.clone()));
        Some(page)
    }

    /// The page and every module it names, read, hashed and compressed before the window asks.
    pub async fn warm(&self) {
        if self.index_page().await.is_some() {
            let _ = self.pack_for(&[]).await;
        }
    }

    /// A path inside the bundle: decoded, no `..`, never the raw index.html (the page serves that).
    fn resolve(&self, pathname: &str) -> Option<PathBuf> {
        let rel = crate::router::percent_decode(pathname).unwrap_or_else(|| pathname.to_owned());
        let rel = rel.trim_start_matches('/');
        let p = Path::new(if rel.is_empty() { "index.html" } else { rel });
        if p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        let full = self.dir.join(p);
        (full != self.index()).then_some(full)
    }

    pub async fn serve(&self, method: &Method, pathname: &str, query: Option<&str>, h: &HeaderMap) -> Answer {
        if pathname == "/_pack" {
            return pack::serve(self, method, query, h).await;
        }
        let file = self.resolve(pathname);
        let entry = match &file {
            Some(f) => self.read(f).await,
            None => None,
        };
        if let (Some(f), Some(e)) = (&file, &entry) {
            let ext = f.extension().and_then(|x| x.to_str()).unwrap_or("");
            if e.size > MAX_CACHED {
                return pack::stream_file(f, mime(ext), e.size, method, h).await;
            }
            let for_good = f.file_name().and_then(|n| n.to_str()).is_some_and(hashed) && f.components().any(|c| c.as_os_str() == "assets");
            return answer(method, h, e, mime(ext), for_good, None);
        }
        // a path with an extension that isn't here is a 404, not the app (a stale chunk must fail loudly);
        // the app's own routes are always the app, dots and all: a plugin view is `/view/stuff.page`
        let last = pathname.rsplit('/').next().unwrap_or("");
        if !app_route(pathname)
            && last
                .rsplit_once('.')
                .is_some_and(|(_, ext)| !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()) && ext != "html")
        {
            return respond::text(404, "text/plain; charset=utf-8", "not found", &[("cache-control".into(), "no-cache".into())]);
        }
        let Some(page) = self.index_page().await else {
            return respond::text(
                503,
                "text/plain; charset=utf-8",
                "The web app is not built: run npm run build",
                &[("cache-control".into(), "no-store".into())],
            );
        };
        let boot = wants_boot(header(h, "user-agent"), h.contains_key("x-wisp-sw"));
        answer(method, h, if boot { &page.boot } else { &page.normal }, mime("html"), false, Some(&page.build))
    }

    pub(crate) async fn pack_for(&self, have: &[String]) -> Option<(String, Arc<Entry>)> {
        pack::pack_for(self, have).await
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }
}

/// The app's own routes (`@wisp/client` nav-url.ts): their ids may hold dots.
fn app_route(pathname: &str) -> bool {
    ["/view/", "/crew/", "/s/"].iter().any(|p| pathname.starts_with(p))
}

fn answer(method: &Method, h: &HeaderMap, f: &Entry, content_type: &str, for_good: bool, build: Option<&str>) -> Answer {
    let mut b = http::Response::builder()
        .header("content-type", content_type)
        .header("cache-control", if for_good { "public, max-age=31536000, immutable" } else { "no-cache" })
        .header("etag", f.etag.as_str());
    if let Some(build) = build {
        b = b.header("x-wisp-build", build);
    }
    if f.text {
        b = b.header("vary", if build.is_some() { "accept-encoding, x-wisp-sw" } else { "accept-encoding" });
    }
    if header(h, "if-none-match") == Some(f.etag.as_str()) {
        return b.status(304).body(respond::empty()).unwrap_or_else(|_| http::Response::new(respond::empty()));
    }
    let (enc, body) = match encoding_for(h) {
        Some(Encoding::Br) if f.br.get().is_some() => (Some("br"), f.br.get().cloned()),
        Some(Encoding::Br | Encoding::Gzip) if f.gz.get().is_some() && header(h, "accept-encoding").is_some_and(|a| a.contains("gzip")) => {
            (Some("gzip"), f.gz.get().cloned())
        }
        _ => (None, None),
    };
    let body = body.unwrap_or_else(|| f.body.clone());
    if let Some(enc) = enc {
        b = b.header("content-encoding", enc);
    }
    b = b.header("content-length", body.len());
    let body = if method == Method::HEAD { respond::empty() } else { respond::full(body) };
    b.status(200).body(body).unwrap_or_else(|_| http::Response::new(respond::empty()))
}
