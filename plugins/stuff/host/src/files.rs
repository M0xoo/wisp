//! Bytes on wisp's own origin: an item's file (with Range), an app's picture, and attachments
//! (v1 routes/stuff.js, routes/uploads.js). Nothing served here may run as a page there.
use std::sync::Arc;

use serde_json::json;
use wisp_kernel::http::{Request, Response};
use wisp_kernel::{Call, Ctx};
use wisp_stuff_api::StuffKind;
use wisp_stuff_core::serve::{COVER_CSP, Range, UPLOAD_CSP, parse_range, stuff_file_headers};

use crate::error::{Result, bad};
use crate::shelf::gone;
use crate::state::{Stuff, ok_json};

fn bytes(status: u16, content_type: String, body: Vec<u8>, headers: Vec<(String, String)>) -> Response {
    Response::Bytes { status, content_type, body, headers }
}

pub async fn file(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = s.shelf.get(req.param("id").unwrap_or_default()).ok_or_else(gone)?;
    if it.kind == StuffKind::App {
        return Err(bad(404, "An app has no one file: launch it."));
    }
    let Some(data) = s.shelf.bytes(&it).await? else { return Err(bad(404, "The file is gone.")) };
    let download = req.query("download").is_some_and(|d| !d.is_empty());
    let (ty, mut headers) = stuff_file_headers(it.mime.as_deref().unwrap_or("application/octet-stream"), &it.name, download);
    headers.push(("accept-ranges".into(), "bytes".into()));
    let size = data.len() as u64;
    match parse_range(req.header("range"), size) {
        Range::Full => Ok(bytes(200, ty, data.as_ref().clone(), headers)),
        Range::Unsatisfiable => Ok(bytes(416, "text/plain".into(), Vec::new(), vec![("content-range".into(), format!("bytes */{size}"))])),
        Range::Part(a, b) => {
            headers.push(("content-range".into(), format!("bytes {a}-{b}/{size}")));
            let (a, b) = (usize::try_from(a).unwrap_or(0), usize::try_from(b).unwrap_or(0));
            Ok(bytes(206, ty, data.get(a..=b).unwrap_or_default().to_vec(), headers))
        }
    }
}

pub async fn cover(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = s.shelf.get(req.param("id").unwrap_or_default()).ok_or_else(gone)?;
    let no = || bad(404, "No picture.");
    let hash = it.cover.as_deref().ok_or_else(no)?;
    let data = s.shelf.blobs.get(hash).await?.ok_or_else(no)?;
    let ty = it.cover_mime.clone().unwrap_or_else(|| "application/octet-stream".into());
    Ok(bytes(
        200,
        ty,
        data.as_ref().clone(),
        vec![("content-security-policy".into(), COVER_CSP.into()), ("x-content-type-options".into(), "nosniff".into())],
    ))
}

pub async fn upload_post(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let name = req.query("name").map(str::to_owned);
    let ty = req.query("type").map(str::to_owned);
    let u = s.shelf.receive_upload(req.body, name.as_deref(), ty.as_deref()).await?;
    ok_json(u, 201)
}

/// `<id>@<machine>` comes from that machine (wisp.machines streams it); this answers local ids.
pub async fn upload_get(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let id = req.param("id").unwrap_or_default();
    let not_found = || Ok(Response::Json { status: 404, body: json!({ "error": "not found" }) });
    let Some(u) = s.shelf.upload(id).await? else { return not_found() };
    let Some(data) = s.shelf.upload_bytes(&u).await? else { return not_found() };
    Ok(bytes(
        200,
        u.mime,
        data.as_ref().clone(),
        vec![("x-content-type-options".into(), "nosniff".into()), ("content-security-policy".into(), UPLOAD_CSP.into())],
    ))
}

pub async fn upload_delete(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    ok_json(json!({ "ok": s.shelf.remove_upload(req.param("id").unwrap_or_default()).await? }), 200)
}
