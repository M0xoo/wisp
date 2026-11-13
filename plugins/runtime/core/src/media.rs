//! An answer's pictures and videos (v1 routes/sessions.js `mediaFile`): which file on disk a page may load for a
//! task. A file inside the task's folder, or one the agent named in an `image`/`video` block by that exact path
//! (screenshots often land in /tmp), with a picture's or video's extension. Nothing else on the disk is served.
//! Sans-IO: the caller says whether a path exists.
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

pub const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
pub const VIDEO_EXT: [&str; 4] = ["mp4", "webm", "mov", "m4v"];

/// `path.resolve(dir, p)`: `p` against `dir`, `.` and `..` folded without touching the disk.
#[must_use]
pub fn resolve(dir: &Path, p: &str) -> PathBuf {
    let joined = dir.join(p);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

/// The content type a served file goes out with (v1 http/static.js MIME).
#[must_use]
pub fn mime(p: &Path) -> &'static str {
    match ext_of(p).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// What a file is, as its extension or its first bytes say: an SVG is text, so only `.svg` takes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Raster,
    Svg,
    Video,
}

/// What the extension claims.
#[must_use]
pub fn kind_of(p: &Path) -> Option<Kind> {
    let ext = ext_of(p);
    if ext == "svg" {
        Some(Kind::Svg)
    } else if IMAGE_EXT.contains(&ext.as_str()) {
        Some(Kind::Raster)
    } else if VIDEO_EXT.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else {
        None
    }
}

/// How many bytes `sniff` reads: enough for an SVG's prolog and comments before `<svg`.
pub const SNIFF_LEN: usize = 4096;

/// What a file's first bytes are: PNG, JPEG, GIF, `WebP`; an ISO box (MP4/MOV: `ftyp`, or a `QuickTime` `moov`/`mdat`/
/// `wide`/`free`/`skip` box whose size fits) or `WebM`; SVG markup.
#[must_use]
pub fn sniff(head: &[u8]) -> Option<Kind> {
    let at = |i: usize, m: &[u8]| head.get(i..i + m.len()) == Some(m);
    if at(0, b"\x89PNG\r\n\x1a\n") || at(0, b"\xff\xd8\xff") || at(0, b"GIF87a") || at(0, b"GIF89a") || (at(0, b"RIFF") && at(8, b"WEBP")) {
        return Some(Kind::Raster);
    }
    // a box's size: 1 (a 64-bit size follows) or 8 up to 512 MB (a first byte under 0x20, which no text starts
    // with); "key=free-tier" reads "free" at 4 too
    let size = head.get(..4).map_or(0, |b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let quicktime =
        (size == 1 || (8..0x2000_0000).contains(&size)) && [b"moov", b"mdat", b"wide", b"free", b"skip"].iter().any(|b| at(4, *b));
    if at(0, b"\x1a\x45\xdf\xa3") || at(4, b"ftyp") || quicktime {
        return Some(Kind::Video);
    }
    // an SVG is text: markup from its first character (a BOM and blank lines aside) and an `<svg` element early on
    let text = String::from_utf8_lossy(head.get(..SNIFF_LEN.min(head.len())).unwrap_or_default()).to_ascii_lowercase();
    let text = text.trim_start_matches('\u{feff}').trim_start();
    (text.starts_with('<') && text.contains("<svg")).then_some(Kind::Svg)
}

/// A file goes out only when its bytes are what its extension says: a block naming `/tmp/s.png` that's a link to
/// `~/.ssh/id_rsa`, a key renamed `.png`, or an HTML page with an inline `<svg>` named `.png` is not served.
#[must_use]
pub fn content_fits(p: &Path, head: &[u8]) -> bool {
    kind_of(p).is_some_and(|k| sniff(head) == Some(k))
}

/// The file to serve for `asked`, and where the agent saved it when that's a copy (`source`, v1 keepImages).
/// `outside`: it isn't under the task's folder, so its content must fit its extension (`content_fits`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFile {
    pub path: PathBuf,
    pub source: Option<PathBuf>,
    pub outside: bool,
}

/// v1 `mediaFile(s, asked)`: `blocks` are every turn's answer blocks.
pub fn media_file<'a>(
    dir: &Path,
    asked: &str,
    blocks: impl IntoIterator<Item = &'a Value>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<MediaFile> {
    let mut p = resolve(dir, asked);
    let media: Vec<&Value> =
        blocks.into_iter().filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("image" | "video"))).collect();
    let field = |b: &Value, k: &str| b.get(k).and_then(Value::as_str).map(str::to_owned);
    let at = |v: Option<String>, p: &Path| v.is_some_and(|v| resolve(dir, &v) == p);
    let mut block = media.iter().find(|b| at(field(b, "path").or_else(|| field(b, "src")), &p)).copied();
    // a page rendered before the block was rewritten to wisp's copy still asks for the original path
    if block.is_none()
        && let Some(kept) = media.iter().find(|b| at(field(b, "source"), &p) && field(b, "path").is_some())
    {
        p = resolve(dir, &field(kept, "path").unwrap_or_default());
        block = Some(kept);
    }
    let inside = p.starts_with(dir) && p != dir;
    let ext = ext_of(&p);
    if !(inside || block.is_some()) || !(IMAGE_EXT.contains(&ext.as_str()) || VIDEO_EXT.contains(&ext.as_str())) || !exists(&p) {
        return None;
    }
    let source = block.and_then(|b| field(b, "source")).map(|s| resolve(dir, &s)).filter(|s| exists(s));
    Some(MediaFile { path: p, source, outside: !inside })
}

/// The largest picture and video wisp keeps a copy of (v1 `MAX_KEPT_IMAGE`, `MAX_KEPT_VIDEO`).
pub const MAX_KEPT_IMAGE: u64 = 25 * 1024 * 1024;
pub const MAX_KEPT_VIDEO: u64 = 200 * 1024 * 1024;

/// One copy to make (v1 `keepImages`): block `index`'s file `from` goes to `to`, the block then names `to`, with
/// `source` the path the agent wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keep {
    pub index: usize,
    pub from: PathBuf,
    pub to: PathBuf,
    pub source: String,
    pub max: u64,
}

/// Agents save screenshots and recordings to /tmp, which the computer clears: every local picture or video a turn
/// shows is copied into `shots/<turn>-<i>.<ext>` (`shots` is `~/.wisp/shots/<task>`). A link, a file already
/// there, or another extension stays as it is.
#[must_use]
pub fn keep_plan(dir: &Path, blocks: &[Value], turn: &str, shots: &Path) -> Vec<Keep> {
    let mut out = Vec::new();
    for (index, b) in blocks.iter().enumerate() {
        let video = b.get("type").and_then(Value::as_str) == Some("video");
        if !video && b.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let Some(rel) = b
            .get("path")
            .or_else(|| b.get("src"))
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty() && !r.starts_with("http:") && !r.starts_with("https:") && !r.starts_with("data:"))
        else {
            continue;
        };
        let from = resolve(dir, rel);
        let ext = ext_of(&from);
        let known = if video { VIDEO_EXT.contains(&ext.as_str()) } else { IMAGE_EXT.contains(&ext.as_str()) };
        if !known || from.starts_with(shots.parent().unwrap_or(shots)) {
            continue;
        }
        out.push(Keep {
            index,
            to: shots.join(format!("{turn}-{index}.{ext}")),
            from,
            source: rel.to_owned(),
            max: if video { MAX_KEPT_VIDEO } else { MAX_KEPT_IMAGE },
        });
    }
    out
}

/// The block once its copy is made: it names the copy, `source` keeps where the agent saved it.
pub fn kept(block: &mut Value, k: &Keep) {
    if let Some(o) = block.as_object_mut() {
        o.insert("path".into(), Value::String(k.to.display().to_string()));
        o.insert("source".into(), Value::String(k.source.clone()));
        o.remove("src");
    }
}

/// v1 `docFile(s, asked)`: a markdown file a `doc` block showed, inside the folder or the path it named.
pub fn doc_file<'a>(
    dir: &Path,
    asked: &str,
    blocks: impl IntoIterator<Item = &'a Value>,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if asked.is_empty() {
        return None;
    }
    let p = resolve(dir, asked);
    let named = blocks
        .into_iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("doc"))
        .any(|b| ["abs", "path"].iter().any(|k| b.get(*k).and_then(Value::as_str).is_some_and(|v| resolve(dir, v) == p)));
    ((p.starts_with(dir) && p != dir) || named).then_some(p).filter(|p| is_file(p))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_picture_inside_the_folder_or_named_by_a_block_is_served_nothing_else_v1_media_file() {
        let dir = Path::new("/w/app");
        let on_disk =
            ["/w/app/shot.png", "/tmp/s.png", "/w/app/notes.txt", "/etc/x.png", "/w/app/.wisp/k.png", "/home/me/.wisp/shots/a.png"];
        let exists = |p: &Path| on_disk.iter().any(|d| Path::new(d) == p);
        let blocks = [
            json!({ "type": "image", "path": "/tmp/s.png" }),
            json!({ "type": "text", "path": "/etc/x.png" }),
            json!({ "type": "image", "path": "/home/me/.wisp/shots/a.png", "source": "/tmp/gone.png" }),
        ];
        let get = |asked: &str| media_file(dir, asked, &blocks, &exists).map(|m| m.path.display().to_string());
        // inside the folder, relative or absolute
        assert_eq!(get("shot.png").as_deref(), Some("/w/app/shot.png"));
        assert_eq!(get("/w/app/shot.png").as_deref(), Some("/w/app/shot.png"));
        // outside: only the exact path an image block named
        assert_eq!(get("/tmp/s.png").as_deref(), Some("/tmp/s.png"));
        assert_eq!(get("/etc/x.png"), None, "a text block naming it doesn't count");
        assert_eq!(get("../../etc/x.png"), None, "no climbing out");
        // not a picture or a video; not on disk
        assert_eq!(get("notes.txt"), None);
        assert_eq!(get("missing.png"), None);
        // the original path of a block wisp rewrote to its copy: the copy
        assert_eq!(get("/tmp/gone.png").as_deref(), Some("/home/me/.wisp/shots/a.png"));
        assert_eq!(mime(Path::new("a.MOV")), "video/quicktime");
        // a doc block's file: inside, or the path it named
        let docs = [json!({ "type": "doc", "path": "/home/me/plan.md" })];
        let all = |_: &Path| true;
        assert_eq!(doc_file(dir, "docs/a.md", &docs, &all), Some(PathBuf::from("/w/app/docs/a.md")));
        assert_eq!(doc_file(dir, "/home/me/plan.md", &docs, &all), Some(PathBuf::from("/home/me/plan.md")));
        assert_eq!(doc_file(dir, "/home/me/other.md", &docs, &all), None);
    }

    #[test]
    fn a_file_outside_the_folder_goes_only_when_its_bytes_are_the_picture_or_video_its_extension_says() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        let mp4 = b"\0\0\0\x18ftypmp42\0\0\0\0";
        assert_eq!(sniff(png), Some(Kind::Raster));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0\0\x10JFIF"), Some(Kind::Raster));
        assert_eq!(sniff(b"GIF89a\x01\0"), Some(Kind::Raster));
        assert_eq!(sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some(Kind::Raster));
        assert_eq!(
            sniff(b"\xef\xbb\xbf\n<?xml version=\"1.0\"?>\n<!-- by hand -->\n<SVG xmlns=\"http://www.w3.org/2000/svg\"/>"),
            Some(Kind::Svg)
        );
        assert_eq!(sniff(mp4), Some(Kind::Video));
        assert_eq!(sniff(b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81"), Some(Kind::Video));
        // what a secret looks like: never a picture
        assert_eq!(sniff(b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk"), None);
        assert_eq!(sniff(b"[default]\naws_access_key_id = AKIA"), None);
        assert_eq!(sniff(b"<html><body>not an svg</body></html>"), None);
        assert_eq!(sniff(b"see <svg> in the docs"), None, "text that mentions svg isn't one");
        assert_eq!(sniff(b""), None);
        // the extension and the bytes must agree on the kind
        assert!(content_fits(Path::new("/tmp/s.png"), png));
        assert!(content_fits(Path::new("/tmp/s.JPG"), png), "a PNG named .jpg is still a picture");
        assert!(!content_fits(Path::new("/tmp/s.png"), mp4), "a video named .png");
        assert!(!content_fits(Path::new("/tmp/s.mp4"), png));
        assert!(!content_fits(Path::new("/tmp/id_rsa.png"), b"-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(!content_fits(Path::new("/tmp/s.txt"), png), "no extension of ours");
        // an SVG is text: only .svg takes it, so a page with an inline icon named .png doesn't pass
        let page = b"<html><body><svg viewBox=\"0 0 1 1\"/> token=abc</body></html>";
        assert!(!content_fits(Path::new("/tmp/s.png"), page));
        assert!(content_fits(Path::new("/tmp/s.svg"), b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
        assert!(!content_fits(Path::new("/tmp/s.svg"), png));
        // QuickTime's other first boxes count only with a box's size: text that reads "free" at 4 isn't a video
        assert_eq!(sniff(b"\0\0\0\x08wide\0\0\0\0mdat"), Some(Kind::Video));
        assert_eq!(sniff(b"key=free-tier"), None);
        // media_file says which ones need the check
        let dir = Path::new("/w/app");
        let blocks = [json!({ "type": "image", "path": "/tmp/s.png" })];
        let all = |_: &Path| true;
        assert!(media_file(dir, "/tmp/s.png", &blocks, &all).unwrap().outside);
        assert!(!media_file(dir, "shot.png", &blocks, &all).unwrap().outside);
    }

    #[test]
    fn a_turns_local_pictures_and_videos_are_copied_into_shots_links_and_copies_are_not_v1_keep_images() {
        let dir = Path::new("/w/app");
        let shots = Path::new("/h/.wisp/shots/s1");
        let blocks = [
            json!({ "type": "image", "path": "/tmp/shot.png" }),
            json!({ "type": "image", "src": "https://x.dev/a.png" }),
            json!({ "type": "video", "path": "rec/run.MP4" }),
            json!({ "type": "image", "path": "/h/.wisp/shots/s0/t0-0.png" }),
            json!({ "type": "video", "path": "notes.png" }),
            json!({ "type": "text", "path": "/tmp/x.png" }),
        ];
        let plan = keep_plan(dir, &blocks, "t9", shots);
        assert_eq!(
            plan.iter().map(|k| (k.index, k.from.display().to_string(), k.to.display().to_string())).collect::<Vec<_>>(),
            vec![
                (0, "/tmp/shot.png".to_owned(), "/h/.wisp/shots/s1/t9-0.png".to_owned()),
                (2, "/w/app/rec/run.MP4".to_owned(), "/h/.wisp/shots/s1/t9-2.mp4".to_owned()),
            ]
        );
        assert_eq!(plan[1].max, MAX_KEPT_VIDEO);
        let mut b = blocks[0].clone();
        kept(&mut b, &plan[0]);
        assert_eq!(b, json!({ "type": "image", "path": "/h/.wisp/shots/s1/t9-0.png", "source": "/tmp/shot.png" }));
        // the page asks for the original path: it gets the copy (media_file's `source` match)
        let exists = |p: &Path| p == Path::new("/h/.wisp/shots/s1/t9-0.png");
        assert_eq!(media_file(dir, "/tmp/shot.png", &[b], &exists).map(|m| m.path), Some(PathBuf::from("/h/.wisp/shots/s1/t9-0.png")));
        assert_eq!(resolve(dir, "./a/../b.png"), Path::new("/w/app/b.png"));
    }
}
