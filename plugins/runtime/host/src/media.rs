//! An answer's pictures and videos on the page (v1 routes/sessions.js `/sessions/:id/file` and `/reveal`): the
//! file a block named, served from the task's computer (videos answer Range, so the player can seek; Safari won't
//! play one without), and Show in folder there. Which file may go is `wisp_runtime_core::media` (sans-IO).
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Result as WireResult, WireError};
use wisp_runtime_core::media::{MediaFile, SNIFF_LEN, content_fits, doc_file, keep_plan, kept, media_file, mime, resolve};

use crate::error::{Result, RuntimeError};
use crate::plugin::{Slot, rt};
use crate::runtime::Runtime;

/// A picture goes out unable to run anything (an SVG's scripts), and never sniffed into a page.
const MEDIA_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/// The file manager on `path` (v1 `revealInFolder`): Finder selects it, Explorer too, elsewhere its folder opens.
#[must_use]
pub fn reveal_argv(os: &str, path: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec!["-R".into(), path.into()]),
        "windows" => ("explorer", vec![format!("/select,{path}")]),
        _ => ("xdg-open", vec![Path::new(path).parent().map_or_else(|| path.to_owned(), |d| d.display().to_string())]),
    }
}

/// What a `Range` header asks of a file of `size` bytes (one range, as players ask).
#[derive(Debug, PartialEq, Eq)]
enum Span {
    Whole,
    Part(u64, u64),
    Unsatisfiable,
}

fn range(h: Option<&str>, size: u64) -> Span {
    let parse = || -> Option<Span> {
        let spec = h?.trim().strip_prefix("bytes=")?;
        if spec.contains(',') || size == 0 {
            return None;
        }
        let (a, b) = spec.split_once('-')?;
        let (a, b) = match (a.trim(), b.trim()) {
            ("", n) => (size.saturating_sub(n.parse().ok()?), size - 1),
            (a, "") => (a.parse().ok()?, size - 1),
            (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(size - 1)),
        };
        Some(if a <= b && a < size { Span::Part(a, b) } else { Span::Unsatisfiable })
    };
    parse().unwrap_or(Span::Whole)
}

/// Whether `p`'s first bytes are the picture or video its extension says (`content_fits`).
async fn fits(p: &Path) -> bool {
    use tokio::io::AsyncReadExt as _;
    let Ok(file) = tokio::fs::File::open(p).await else { return false };
    let mut head = Vec::with_capacity(SNIFF_LEN);
    file.take(SNIFF_LEN as u64).read_to_end(&mut head).await.is_ok() && content_fits(p, &head)
}

/// `from` copied to `to` when it's a file of at most `max` bytes whose bytes are what its name says: checked and
/// copied through one open handle, so a file swapped for a link to a secret in between is never copied.
async fn copy_fitting(from: &Path, to: &Path, max: u64) -> bool {
    use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
    let Ok(mut file) = tokio::fs::File::open(from).await else { return false };
    if !file.metadata().await.is_ok_and(|m| m.is_file() && m.len() <= max) {
        return false;
    }
    let mut head = Vec::with_capacity(SNIFF_LEN);
    if (&mut file).take(SNIFF_LEN as u64).read_to_end(&mut head).await.is_err() || !content_fits(from, &head) || file.rewind().await.is_err() {
        return false;
    }
    let Ok(mut out) = tokio::fs::File::create(to).await else { return false };
    let copied = tokio::io::copy(&mut file.take(max), &mut out).await.is_ok();
    if !copied {
        let _ = tokio::fs::remove_file(to).await;
    }
    copied
}

impl Runtime {
    /// v1 `keepImages`: every local picture or video the answer shows is copied into `~/.wisp/shots/<task>/` and its
    /// block names the copy (`source` keeps the original), so it still shows once /tmp is cleared. One that's gone,
    /// too large or unreadable stays as it was.
    pub(crate) async fn keep_media(&self, s: &wisp_runtime_api::model::Session, turn: &str, blocks: &mut [Value]) {
        let Some(root) = self.host.shots() else { return };
        let shots = root.join(s.id.as_str());
        for k in keep_plan(Path::new(&s.cwd), blocks, turn, &shots) {
            // a copy only of what is the picture or video it says (never a secret behind a `.png` link)
            if tokio::fs::create_dir_all(&shots).await.is_err() || !copy_fitting(&k.from, &k.to, k.max).await {
                continue;
            }
            if let Some(b) = blocks.get_mut(k.index) {
                kept(b, &k);
            }
        }
    }

    /// The file `asked` names for task `id`, if a page may load it.
    ///
    /// # Errors
    /// No such task, or the store failed.
    pub async fn media(&self, id: &str, asked: &str) -> Result<Option<MediaFile>> {
        let s = self.repo.session(id).await?;
        let turns = self.repo.turns(id, None, None).await?;
        let blocks: Vec<Value> = turns.into_iter().filter_map(|t| t.presentation).flat_map(|p| p.blocks).collect();
        let dir = PathBuf::from(&s.cwd);
        // what's on disk is read first: the core decides without touching it
        let mut named = vec![resolve(&dir, asked)];
        for b in &blocks {
            for k in ["path", "src", "source"] {
                if let Some(v) = b.get(k).and_then(Value::as_str) {
                    named.push(resolve(&dir, v));
                }
            }
        }
        let mut seen = std::collections::HashMap::new();
        for p in named {
            if let std::collections::hash_map::Entry::Vacant(e) = seen.entry(p) {
                let is = tokio::fs::metadata(e.key()).await.is_ok_and(|m| m.is_file());
                e.insert(is);
            }
        }
        let Some(mut f) = media_file(&dir, asked, &blocks, &|p| seen.get(p).copied().unwrap_or(false)) else { return Ok(None) };
        // a link in the folder that points out of it is outside too
        if !f.outside {
            let (real, root) = (tokio::fs::canonicalize(&f.path).await, tokio::fs::canonicalize(&dir).await);
            f.outside = !matches!((real, root), (Ok(real), Ok(root)) if real.starts_with(&root));
        }
        if f.outside && !fits(&f.path).await {
            tracing::warn!(task = id, path = %f.path.display(), "not served: its bytes aren't the picture or video its name says");
            return Ok(None);
        }
        Ok(Some(f))
    }

    /// Show in folder (v1 POST /sessions/:id/reveal): a picture's or video's (where the agent saved it, else the
    /// file shown), or a doc block's file.
    ///
    /// # Errors
    /// The file is gone, or the task isn't here.
    pub async fn reveal(&self, id: &str, asked: &str) -> Result<Value> {
        let file = if let Some(f) = self.media(id, asked).await? {
            f.source.unwrap_or(f.path)
        } else {
            let s = self.repo.session(id).await?;
            let blocks: Vec<Value> = self.repo.turns(id, None, None).await?.into_iter().filter_map(|t| t.presentation).flat_map(|p| p.blocks).collect();
            let dir = PathBuf::from(&s.cwd);
            let is = tokio::fs::metadata(resolve(&dir, asked)).await.is_ok_and(|m| m.is_file());
            doc_file(&dir, asked, &blocks, &|_| is).ok_or_else(|| RuntimeError::Invalid("That file is gone.".into()))?
        };
        let file = file.display().to_string();
        let (bin, args) = reveal_argv(std::env::consts::OS, &file);
        let opened = self.proc.exec(bin, &args, wisp_proc::ExecOpts::default()).await.is_ok_and(|r| r.exit.success());
        Ok(json!({ "ok": opened, "path": file }))
    }
}

async fn serve(slot: Slot, req: Request) -> WireResult<Response> {
    let r = rt(&slot)?;
    let id = req.param("id").unwrap_or_default().to_owned();
    let asked = req.query("path").unwrap_or_default().to_owned();
    let not_found = || Response::Json { status: 404, body: json!({ "error": "not found" }) };
    let Some(f) = r.media(&id, &asked).await.map_err(WireError::from)? else { return Ok(not_found()) };
    let Ok(data) = tokio::fs::read(&f.path).await else { return Ok(not_found()) };
    // the bytes that go out are checked themselves: the file may have been swapped since `media` looked
    if !content_fits(&f.path, data.get(..SNIFF_LEN.min(data.len())).unwrap_or_default()) {
        return Ok(not_found());
    }
    let ty = mime(&f.path).to_owned();
    let size = data.len() as u64;
    let mut headers = vec![("accept-ranges".into(), "bytes".into()), ("x-content-type-options".into(), "nosniff".into()), ("content-security-policy".into(), MEDIA_CSP.into())];
    Ok(match range(req.header("range"), size) {
        Span::Whole => Response::Bytes { status: 200, content_type: ty, body: data, headers },
        Span::Unsatisfiable => Response::Bytes { status: 416, content_type: "text/plain".into(), body: Vec::new(), headers: vec![("content-range".into(), format!("bytes */{size}"))] },
        Span::Part(a, b) => {
            headers.push(("content-range".into(), format!("bytes {a}-{b}/{size}")));
            let (a, b) = (usize::try_from(a).unwrap_or(0), usize::try_from(b).unwrap_or(0));
            Response::Bytes { status: 206, content_type: ty, body: data.get(a..=b).unwrap_or_default().to_vec(), headers }
        }
    })
}

/// GET /api/sessions/:id/file?path=… (an `image`/`video` block's file).
pub fn route(slot: &Slot) -> Route {
    let slot = slot.clone();
    Route {
        method: "GET",
        pattern: "/sessions/:id/file",
        permission: "runtime:read",
        doc: false,
        summary: "A picture or video an answer showed",
        raw: false,
        max_body: None,
        handler: Arc::new(move |_ctx, _call, req| Box::pin(serve(slot.clone(), req))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_video_answers_one_range_and_reveal_opens_the_file_manager_v1_media_route() {
        assert_eq!(range(None, 10), Span::Whole);
        assert_eq!(range(Some("bytes=0-"), 10), Span::Part(0, 9));
        assert_eq!(range(Some("bytes=2-4"), 10), Span::Part(2, 4));
        assert_eq!(range(Some("bytes=-3"), 10), Span::Part(7, 9));
        assert_eq!(range(Some("bytes=5-99"), 10), Span::Part(5, 9));
        assert_eq!(range(Some("bytes=12-"), 10), Span::Unsatisfiable);
        assert_eq!(range(Some("bytes=0-1,4-5"), 10), Span::Whole);
        assert_eq!(reveal_argv("macos", "/s/a.png"), ("open", vec!["-R".to_owned(), "/s/a.png".to_owned()]));
        assert_eq!(reveal_argv("linux", "/s/a.png"), ("xdg-open", vec!["/s".to_owned()]));
        assert_eq!(reveal_argv("windows", "C:\\s\\a.png").1, vec!["/select,C:\\s\\a.png".to_owned()]);
    }
}
