//! My Stuff's byte routes (files, covers, uploads, a raw dropped file) and the two with no command yet
//! (starters, reveal). Everything else is a `stuff.*` command (ADR-0031).
use std::future::Future;
use std::sync::Arc;

use serde_json::json;
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Call, Ctx};
use wisp_stuff_api::commands::Saved;
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
pub fn route<Fut>(
    cell: &Cell,
    method: &'static str,
    pattern: &'static str,
    permission: &'static str,
    summary: &'static str,
    f: Handler<Fut>,
) -> Route
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
                let (c2, s2) = (ctx.clone(), s.clone());
                let out = state::answer(f(s, ctx, call, req).await);
                // a write (an upload, a starter): My Stuff's rows follow
                if method != "GET" {
                    crate::view::publish(&c2, &s2);
                }
                out
            })
        }),
    }
}

fn item(s: &Stuff, req: &Request) -> Result<StuffItem> {
    s.shelf.get(req.param("id").unwrap_or_default()).ok_or_else(gone)
}

pub fn saved(ctx: &Ctx, call: &Call, it: &StuffItem, update: bool) {
    let session = it.from.as_ref().and_then(|f| f.session.clone());
    let by = it.by.clone().unwrap_or_else(|| "you".into());
    ctx.emit(call, &Saved { id: it.id.clone(), session, by: by.clone(), kind: it.kind, update });
    // v1's stuff_save: what kind, by whom (never what it is)
    let props = serde_json::json!({ "kind": it.kind, "by": if by == "you" { "you" } else { "agent" }, "update": update });
    track(ctx, "stuff_save", props);
}

/// A usage event (wisp.telemetry decides whether it goes), off the caller's way.
pub fn track(ctx: &Ctx, event: &'static str, props: serde_json::Value) {
    let c = ctx.clone();
    ctx.spawn(async move {
        let _ = c.run_json(&c.root_call(), "telemetry.track", serde_json::json!({ "event": event, "props": props })).await;
    });
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
        None => q("key").map(|k| StuffFrom {
            key: Some(k.chars().take(300).collect()),
            session: q("session").map(str::to_owned),
            title: q("from").map(str::to_owned),
            turn: None,
        }),
    };
    if let Some(same) = s.shelf.find_key(from.as_ref().and_then(|f| f.key.as_deref())) {
        return ok_json(s.view(&same).await, 200);
    }
    let fields = Fields { title: q("title").map(|t| wisp_stuff_core::kind::clip(t, 140)), ..Fields::default() };
    let o = SaveOpts {
        fields,
        from,
        by: Some("you".into()),
        name: q("name").map(str::to_owned),
        mime: q("type").map(str::to_owned),
        ..SaveOpts::default()
    };
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
        Route {
            max_body: Some(500 * 1024 * 1024),
            ..route(cell, "POST", "/stuff/upload", "stuff:save", "Save a raw body (a dropped file)", upload)
        },
        route(cell, "GET", "/stuff/starters", "stuff:read", "The panes wisp ships", starters_list),
        route(cell, "POST", "/stuff/starters/:starter", "stuff:save", "Add a starter pane", starter_add),
        route(cell, "GET", "/stuff/:id/file", "stuff:read", "An item's file", crate::files::file),
        route(cell, "GET", "/stuff/:id/cover", "stuff:read", "An app's picture", crate::files::cover),
        route(cell, "POST", "/stuff/:id/reveal", "stuff:read", "Show an item in its folder", reveal),
        Route {
            max_body: Some(500 * 1024 * 1024),
            ..route(cell, "POST", "/uploads", "stuff:save", "Attach a file", crate::files::upload_post)
        },
        route(cell, "GET", "/uploads/:id", "stuff:read", "An attachment's bytes", crate::files::upload_get),
        Route { doc: false, ..route(cell, "DELETE", "/uploads/:id", "stuff:save", "Remove an attachment", crate::files::upload_delete) },
    ]
}
