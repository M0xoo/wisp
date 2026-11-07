//! v1's My Stuff routes (server/routes/stuff.js), same paths and JSON, as thin adapters over the shelf.
use std::future::Future;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Call, Ctx};
use wisp_stuff_api::commands::{AppLaunched, PublishService, Saved, TaskFilesService};
use wisp_stuff_api::pane::{grant_of, not_while};
use wisp_stuff_api::{StuffFrom, StuffItem};
use wisp_stuff_core::record::{Fields, current_grant, from_task};

use crate::error::{Result, bad};
use crate::save::SaveOpts;
use crate::shelf::gone;
use crate::starters;
use crate::state::{self, Cell, Stuff, ok_json};

pub type Handler<Fut> = fn(Arc<Stuff>, Ctx, Call, Request) -> Fut;

/// A route whose handler gets the plugin's state, answering v1's `{ error }` on a refusal.
pub fn route<Fut>(cell: &Cell, method: &'static str, pattern: &'static str, permission: &'static str, summary: &'static str, f: Handler<Fut>) -> Route
where
    Fut: Future<Output = Result<Response>> + Send + 'static,
{
    let cell = cell.clone();
    Route {
        method,
        pattern,
        permission,
        doc: true,
        summary,
        raw: false,
        max_body: None,
        handler: Arc::new(move |ctx, call, req| {
            let cell = cell.clone();
            Box::pin(async move {
                let s = state::get(&cell)?;
                state::answer(f(s, ctx, call, req).await)
            })
        }),
    }
}

fn item(s: &Stuff, req: &Request) -> Result<StuffItem> {
    s.shelf.get(req.param("id").unwrap_or_default()).ok_or_else(gone)
}

fn body(req: &Request) -> Value {
    serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}))
}

fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub fn saved(ctx: &Ctx, call: &Call, it: &StuffItem, update: bool) {
    let session = it.from.as_ref().and_then(|f| f.session.clone());
    ctx.emit(call, &Saved { id: it.id.clone(), session, by: it.by.clone().unwrap_or_else(|| "you".into()), kind: it.kind, update });
}

pub async fn list(s: Arc<Stuff>, ctx: Ctx, call: Call, _r: Request) -> Result<Response> {
    let publish_to = ctx.use_service::<PublishService>().ok().and_then(|p| p.targets(&call).ok()).unwrap_or_default();
    ok_json(json!({ "items": s.views().await, "publishTo": publish_to }), 200)
}

/// One of: `{ url }` a link, `{ text }` a doc or snippet, `{ session, path }` a file from a task.
pub async fn save(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let b = body(&req);
    let session = text(&b, "session");
    let t = match session {
        Some(id) => state::task(&ctx, &call, id).await,
        None => None,
    };
    let from = from_task(t.as_ref().map(|t| (t.id.as_str(), t.title.as_str())), text(&b, "turn"), text(&b, "key"));
    if let Some(same) = s.shelf.find_key(from.as_ref().and_then(|f| f.key.as_deref())) {
        return ok_json(s.view(&same).await, 200);
    }
    let fields = Fields::of(text(&b, "title"), b.get("note").and_then(Value::as_str), b.get("tags").unwrap_or(&Value::Null), None);
    let o = SaveOpts { fields, from, by: Some("you".into()), name: text(&b, "name").map(str::to_owned), lang: text(&b, "lang").map(str::to_owned), ..SaveOpts::default() };
    let it = if let Some(url) = text(&b, "url") {
        s.shelf.save_link(url, o).await?
    } else if let Some(t) = b.get("text").and_then(Value::as_str) {
        s.shelf.save_text(t, o).await?
    } else {
        let Some(task) = t else {
            return Err(if session.is_some() { bad(404, "That task isn’t on this computer.") } else { bad(400, "Say what to save: a url, some text, or a task’s file.") });
        };
        let files = ctx.use_service::<TaskFilesService>()?;
        let asked = text(&b, "path").unwrap_or_default();
        let file = files.file(&call, &task.id, asked).await?.ok_or_else(|| bad(404, "That file is gone, so there’s nothing to save."))?;
        s.shelf.save_file(std::path::Path::new(&file), o).await?
    };
    saved(&ctx, &call, &it, false);
    ok_json(s.view(&it).await, 201)
}

/// A file dropped on the page, or a picture from a task on another computer: the raw body.
pub async fn upload(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let q = |k: &str| req.query(k).filter(|v| !v.is_empty());
    let t = match q("session") {
        Some(id) => state::task(&ctx, &call, id).await,
        None => None,
    };
    let from = match &t {
        Some(t) => from_task(Some((t.id.as_str(), t.title.as_str())), q("turn"), q("key")),
        None => q("key").map(|k| StuffFrom { key: Some(k.chars().take(300).collect()), session: q("session").map(str::to_owned), title: q("from").map(str::to_owned), turn: None }),
    };
    if let Some(same) = s.shelf.find_key(from.as_ref().and_then(|f| f.key.as_deref())) {
        return ok_json(s.view(&same).await, 200);
    }
    let fields = Fields { title: q("title").map(|t| wisp_stuff_core::kind::clip(t, 140)), ..Fields::default() };
    let o = SaveOpts { fields, from, by: Some("you".into()), name: q("name").map(str::to_owned), mime: q("type").map(str::to_owned), ..SaveOpts::default() };
    let it = s.shelf.save_bytes(req.body, o).await?;
    saved(&ctx, &call, &it, false);
    ok_json(s.view(&it).await, 201)
}

pub async fn starters_list(s: Arc<Stuff>, _c: Ctx, _call: Call, _r: Request) -> Result<Response> {
    ok_json(json!({ "starters": starters::list(&s.shelf) }), 200)
}

pub async fn starter_add(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    match starters::add(&s.shelf, req.param("starter").unwrap_or_default()).await? {
        None => Err(bad(404, "wisp has no starter by that name.")),
        Some((it, added)) => ok_json(s.view(&it).await, if added { 201 } else { 200 }),
    }
}

pub async fn launch(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let port = s.apps.launch(&it.id).await?;
    ctx.emit(&call, &AppLaunched { id: it.id });
    ok_json(json!({ "port": port, "url": format!("http://localhost:{port}/") }), 200)
}

pub async fn stop(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    ok_json(json!({ "ok": s.apps.stop(&it.id) }), 200)
}

pub async fn publish(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let p = ctx.use_service::<PublishService>().map_err(|_| bad(409, "Publishing needs a wisp Grid: sign in to one first."))?;
    let out = if req.method == "DELETE" { p.unpublish(&call, &it.id).await? } else { p.publish(&call, &it.id, body(&req)).await? };
    ok_json(s.view(&out).await, 200)
}

pub async fn reset_data(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let it = s.reset_data(&it.id).await?;
    ok_json(s.view(&it).await, 200)
}

/// Allow a pane what its wisp-app.json `uses`: you, once, when you pin it. Never a new scope while
/// the task it's for, or the task that made it, runs in Full auto: nobody is reading cards there.
pub async fn allow_for(s: &Stuff, ctx: &Ctx, call: &Call, id: &str, uses: &[String], task: Option<&str>) -> Result<StuffItem> {
    let it = s.shelf.get(id).ok_or_else(gone)?;
    let now = current_grant(&it).allowed;
    if grant_of(it.uses.as_deref().unwrap_or_default(), uses).iter().any(|x| !now.contains(x)) {
        let ids = [task.map(str::to_owned), it.from.as_ref().and_then(|f| f.session.clone())];
        for id in ids.into_iter().flatten() {
            if let Some(t) = state::task(ctx, call, &id).await.filter(|t| t.full_auto) {
                return Err(bad(409, not_while(&t.title)));
            }
        }
    }
    s.shelf.allow(&it.id, uses).await
}

pub async fn allow(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let b = body(&req);
    let uses: Vec<String> = if req.method == "DELETE" { Vec::new() } else { b.get("uses").and_then(|u| serde_json::from_value(u.clone()).ok()).unwrap_or_default() };
    let it = allow_for(&s, &ctx, &call, &it.id, &uses, text(&b, "task")).await?;
    ok_json(s.view(&it).await, 200)
}

pub async fn grant(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    ok_json(current_grant(&it), 200)
}

pub async fn restore(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let it = s.shelf.restore(&it.id).await?;
    ok_json(s.view(&it).await, 200)
}

pub async fn patch(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let b = body(&req);
    let f = Fields::of(text(&b, "title"), b.get("note").and_then(Value::as_str), b.get("tags").unwrap_or(&Value::Null), b.get("starred").map(|v| v.as_bool().unwrap_or(!v.is_null())));
    let it = s.shelf.update(&it.id, &f).await?;
    ok_json(s.view(&it).await, 200)
}

pub async fn remove(s: Arc<Stuff>, ctx: Ctx, call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    let ok = s.remove(&ctx, &call, &it.id).await?;
    if ok {
        ctx.emit(&call, &wisp_stuff_api::commands::Removed { id: it.id });
    }
    ok_json(json!({ "ok": ok }), 200)
}

/// Show in folder: opening a file manager is the computer's, through the proc service; until that
/// is wired the page gets the path to copy, as v1 answered through a proxy.
pub async fn reveal(s: Arc<Stuff>, _c: Ctx, _call: Call, req: Request) -> Result<Response> {
    let it = item(&s, &req)?;
    if it.url.is_some() {
        return Err(bad(404, "A link has no file."));
    }
    let path = s.shelf.local_path(&it).await?;
    ok_json(json!({ "error": "The file is on the computer running wisp.", "path": path }), 409)
}

pub fn all(cell: &Cell) -> Vec<Route> {
    vec![
        route(cell, "GET", "/stuff", "stuff:read", "My Stuff: every item, newest first", list),
        route(cell, "POST", "/stuff", "stuff:save", "Save a link, text or a task's file", save),
        Route { max_body: Some(500 * 1024 * 1024), ..route(cell, "POST", "/stuff/upload", "stuff:save", "Save a raw body (a dropped file)", upload) },
        route(cell, "GET", "/stuff/starters", "stuff:read", "The panes wisp ships", starters_list),
        route(cell, "POST", "/stuff/starters/:starter", "stuff:save", "Add a starter pane", starter_add),
        route(cell, "GET", "/stuff/:id/file", "stuff:read", "An item's file", crate::files::file),
        route(cell, "GET", "/stuff/:id/cover", "stuff:read", "An app's picture", crate::files::cover),
        route(cell, "POST", "/stuff/:id/launch", "stuff:launch", "Launch an app on a port of its own", launch),
        route(cell, "DELETE", "/stuff/:id/launch", "stuff:launch", "Stop an app", stop),
        route(cell, "POST", "/stuff/:id/publish", "stuff:publish", "Publish an app to your wisp Grid", publish),
        route(cell, "DELETE", "/stuff/:id/publish", "stuff:publish", "Take an app's public link down", publish),
        route(cell, "DELETE", "/stuff/:id/data", "stuff:save", "Reset an app's data", reset_data),
        route(cell, "POST", "/stuff/:id/allow", "stuff:allow", "Allow a pane what it asks for", allow),
        route(cell, "DELETE", "/stuff/:id/allow", "stuff:allow", "Take back what a pane was allowed", allow),
        route(cell, "GET", "/stuff/:id/grant", "stuff:read", "What a pane may use now", grant),
        route(cell, "POST", "/stuff/:id/restore", "stuff:save", "Back to the version before", restore),
        route(cell, "PATCH", "/stuff/:id", "stuff:save", "Edit an item's title, note, tags or star", patch),
        route(cell, "DELETE", "/stuff/:id", "stuff:save", "Remove an item", remove),
        route(cell, "POST", "/stuff/:id/reveal", "stuff:read", "Show an item in its folder", reveal),
        Route { max_body: Some(500 * 1024 * 1024), ..route(cell, "POST", "/uploads", "stuff:save", "Attach a file", crate::files::upload_post) },
        route(cell, "GET", "/uploads/:id", "stuff:read", "An attachment's bytes", crate::files::upload_get),
        Route { doc: false, ..route(cell, "DELETE", "/uploads/:id", "stuff:save", "Remove an attachment", crate::files::upload_delete) },
    ]
}
