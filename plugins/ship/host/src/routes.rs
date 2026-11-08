//! v1's Ship it routes, same paths and JSON, as thin adapters over `Ship` (so v1 clients and the v1
//! route tests keep working).

use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};
use wisp_kernel::http::{Handler, Request, Response, Route};
use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_ship_api::Draft;
use wisp_ship_core::follow::why_not_fixing;

use crate::flow::STILL_WORKING;
use crate::ship::Ship;

pub type Slot = Arc<OnceLock<Arc<Ship>>>;

fn ship_of(slot: &Slot) -> Result<Arc<Ship>> {
    slot.get()
        .cloned()
        .ok_or_else(|| WireError::unavailable("wisp.ship is starting"))
}

fn id(req: &Request) -> Result<String> {
    req.param("id")
        .map(str::to_owned)
        .ok_or_else(|| WireError::invalid("no session id"))
}

type Run = fn(Arc<Ship>, Call, Request) -> wisp_kernel::BoxFuture<'static, Result<Value>>;

fn route(
    slot: &Slot,
    method: &'static str,
    pattern: &'static str,
    permission: &'static str,
    summary: &'static str,
    run: Run,
) -> Route {
    let slot = slot.clone();
    let handler: Handler = Arc::new(move |_ctx: Ctx, call: Call, req: Request| {
        let slot = slot.clone();
        Box::pin(async move { Response::ok(run(ship_of(&slot)?, call, req).await?) })
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

fn body(req: &Request) -> Value {
    if req.body.is_empty() {
        json!({})
    } else {
        req.json::<Value>().unwrap_or_else(|_| json!({}))
    }
}

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

#[allow(clippy::too_many_lines)] // one adapter per v1 route, a table
pub fn routes(slot: &Slot) -> Vec<Route> {
    vec![
        route(
            slot,
            "GET",
            "/sessions/:id/ship",
            "ship:view",
            "What would ship: branch, changes, draft message",
            |ship, call, req| {
                Box::pin(async move { Ok(ship.view(&call, &id(&req)?, &Draft::default()).await?) })
            },
        ),
        route(
            slot,
            "POST",
            "/sessions/:id/ship",
            "ship:ship",
            "Commit, push, open or update the PR",
            |ship, call, req| {
                Box::pin(async move {
                    let b = body(&req);
                    let draft = Draft::default();
                    let title = text(&b, "title").unwrap_or(draft.title);
                    let text_body = text(&b, "body").unwrap_or(draft.body);
                    let out = ship
                        .ship_all(
                            &call,
                            &id(&req)?,
                            &title,
                            &text_body,
                            b.get("draft").and_then(Value::as_bool).unwrap_or(false),
                        )
                        .await?;
                    serde_json::to_value(out).map_err(|e| WireError::internal(e.to_string()))
                })
            },
        ),
        route(
            slot,
            "POST",
            "/sessions/:id/pr",
            "ship:refresh",
            "Refresh the task's pull requests",
            |ship, call, req| {
                Box::pin(async move {
                    let s = id(&req)?;
                    let pr = ship
                        .refresh(&call, &s)
                        .await?
                        .ok_or_else(|| WireError::not_found("No pull request yet."))?;
                    serde_json::to_value(pr).map_err(|e| WireError::internal(e.to_string()))
                })
            },
        ),
        route(
            slot,
            "POST",
            "/sessions/:id/fix-conflicts",
            "ship:fix_conflicts",
            "Ask the task to merge its base in",
            |ship, call, req| Box::pin(fix_conflicts(ship, call, req)),
        ),
        route(
            slot,
            "POST",
            "/sessions/:id/merge",
            "ship:merge",
            "Squash-merge the reviewed head, sync the base, clean up",
            |ship, call, req| {
                Box::pin(async move {
                    serde_json::to_value(ship.merge_all(&call, &id(&req)?).await?)
                        .map_err(|e| WireError::internal(e.to_string()))
                })
            },
        ),
        route(
            slot,
            "GET",
            "/sessions/:id/prs",
            "ship:details",
            "Every PR of the task in full",
            |ship, _call, req| {
                Box::pin(async move { Ok(json!({ "prs": ship.details(&id(&req)?).await? })) })
            },
        ),
        route(
            slot,
            "GET",
            "/sessions/:id/check-log",
            "ship:check_log",
            "A failing GitHub Actions job's log, its last lines",
            |ship, _call, req| {
                Box::pin(async move {
                    Ok(
                        json!({ "log": ship.check_log(&id(&req)?, req.query("url").unwrap_or_default()).await? }),
                    )
                })
            },
        ),
        route(
            slot,
            "POST",
            "/internal/prs",
            "ship:attach",
            "wisp_pr: attach or detach a PR",
            |ship, call, req| {
                Box::pin(async move {
                    let b = body(&req);
                    let session =
                        text(&b, "session").ok_or_else(|| WireError::invalid("no session"))?;
                    let pr_ref = b
                        .get("pr")
                        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                        .unwrap_or_default();
                    let out = ship
                        .attach(
                            &call,
                            &session,
                            &pr_ref,
                            b.get("remove").and_then(Value::as_bool).unwrap_or(false),
                        )
                        .await?;
                    Ok(json!({ "text": out.text }))
                })
            },
        ),
    ]
}

/// Fix conflicts on the PR row: trusts the conflict wisp last saw, so it starts at once; asks GitHub
/// only if it saw none.
async fn fix_conflicts(ship: Arc<Ship>, call: Call, req: Request) -> Result<Value> {
    let s = id(&req)?;
    let task = ship.task(&s)?;
    if !task.pr().is_some_and(wisp_ship_api::PrSummary::is_open) {
        return Err(WireError::invalid("No open pull request."));
    }
    if ship.tasks.is_live(&s) {
        return Err(WireError::conflict(STILL_WORKING));
    }
    if !task.pr().is_some_and(|p| p.conflict) {
        ship.refresh(&call, &s).await?;
    }
    let fixing = |ship: &Ship| {
        ship.tasks
            .get(&s)
            .and_then(|t| t.conflict_fix)
            .filter(|f| f.step == "fixing")
    };
    if fixing(&ship).is_none() {
        ship.fix_conflicts(&call, &s, true).await?;
    }
    if let Some(fix) = fixing(&ship) {
        Ok(json!({ "conflictFix": fix }))
    } else {
        let task = ship.task(&s)?;
        Err(WireError::conflict(why_not_fixing(
            &task,
            ship.tasks.busy(&task, false),
        )))
    }
}
