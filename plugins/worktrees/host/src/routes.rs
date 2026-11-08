//! v1's HTTP API, as thin adapters over the commands' work (same paths, same JSON):
//!
//!   GET  /worktrees                 Settings → Worktrees: what's on disk (routes/worktrees.js)
//!   POST /worktrees/clean           { ids?, leftovers?, force? } remove them by hand
//!   GET  /sessions/:id/folders      Done's folder dialog (?sizes=0 skips du) (routes/sessions.js)
//!   POST /sessions/:id/folders      { remove, force, keep }

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::http::{Handler, Request, Response, Route};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup, WireError};
use wisp_worktrees_api as api;

use crate::{State, done};

type Run = fn(Arc<State>, Ctx, Call, Request) -> BoxFuture<'static, Result<Value>>;

fn route(
    st: &Arc<State>,
    method: &'static str,
    pattern: &'static str,
    permission: &'static str,
    summary: &'static str,
    run: Run,
) -> Route {
    let st = st.clone();
    let handler: Handler = Arc::new(move |ctx: Ctx, call: Call, req: Request| {
        let st = st.clone();
        Box::pin(async move { Response::ok(run(st, ctx, call, req).await?) })
    });
    Route {
        method,
        pattern,
        permission,
        doc: true,
        summary,
        raw: false,
        max_body: None,
        handler,
    }
}

fn json<T: serde::Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| WireError::internal(e.to_string()))
}

fn body<T: serde::de::DeserializeOwned + Default>(req: &Request) -> Result<T> {
    if req.body.is_empty() {
        Ok(T::default())
    } else {
        req.json()
    }
}

fn id(req: &Request) -> Result<String> {
    req.param("id")
        .map(str::to_owned)
        .ok_or_else(|| WireError::invalid("no session id"))
}

pub fn routes(st: &Arc<State>) -> Vec<Route> {
    vec![
        route(
            st,
            "GET",
            "/worktrees",
            "worktrees:view",
            "Worktrees on disk: each task's folder, its size, and leftovers",
            |st, ctx, _call, _req| {
                Box::pin(async move {
                    let (_, c, _) = st.parts(&ctx).await?;
                    json(c.view(true).await)
                })
            },
        ),
        route(
            st,
            "POST",
            "/worktrees/clean",
            "worktrees:clean",
            "Remove worktrees by hand",
            |st, ctx, _call, req| {
                Box::pin(async move {
                    let args: api::CleanArgs = body(&req)?;
                    let (_, c, _) = st.parts(&ctx).await?;
                    json(c.clean(args).await?)
                })
            },
        ),
        route(
            st,
            "GET",
            "/sessions/:id/folders",
            "worktrees:done.list",
            "Done's folders: the task's worktree and what ran under it",
            |st, ctx, call, req| {
                Box::pin(async move {
                    let (e, _, p) = st.parts(&ctx).await?;
                    let sizes = req.query("sizes") != Some("0");
                    json(done::list(&e, p.as_ref(), &call, &id(&req)?, sizes).await)
                })
            },
        ),
        route(
            st,
            "POST",
            "/sessions/:id/folders",
            "worktrees:done.apply",
            "Remove, force-remove or keep Done's folders",
            |st, ctx, call, req| {
                Box::pin(async move {
                    let mut args: api::DoneApplyArgs = body(&req)?;
                    args.session_id = id(&req)?;
                    let (e, _, p) = st.parts(&ctx).await?;
                    json(done::apply(&e, p.as_ref(), &call, &args).await?)
                })
            },
        ),
    ]
}

pub fn register(s: &mut Setup, st: &Arc<State>) {
    for r in routes(st) {
        s.route(r);
    }
}
