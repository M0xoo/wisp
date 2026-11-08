//! v1's HTTP API for tasks (server/routes/sessions.js) as thin adapters over the runtime, same paths and
//! JSON shapes, so v1 clients (older phones, the SDK, other machines) keep working. Each route's
//! permission is the command's it runs.

use std::future::Future;
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Result as WireResult, Setup, WireError};
use wisp_runtime_api::commands::{FollowUpArgs, ListArgs, QueueEditArgs, RunPick, StartArgs};
use wisp_runtime_api::model::{Mode, SessionState};
use wisp_runtime_core::import::{Imported, ImportedTurn, to_v1};
use wisp_runtime_core::upcast;

use crate::plugin::{Slot, rt};
use crate::runtime::Runtime;

fn add<F, Fut>(
    s: &mut Setup,
    slot: &Slot,
    method: &'static str,
    pattern: &'static str,
    permission: &'static str,
    summary: &'static str,
    f: F,
) where
    F: Fn(Arc<Runtime>, Request) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = crate::error::Result<(u16, Value)>> + Send + 'static,
{
    let slot = slot.clone();
    let f = Arc::new(f);
    s.route(Route {
        method,
        pattern,
        permission,
        doc: true,
        summary,
        raw: false,
        max_body: None,
        handler: Arc::new(move |_ctx, _call, req| {
            let (slot, f) = (slot.clone(), f.clone());
            Box::pin(async move {
                let r = rt(&slot)?;
                let (status, body) = f(r, req).await.map_err(WireError::from)?;
                Ok(Response::Json { status, body })
            })
        }),
    });
}

fn id(req: &Request) -> WireResult<String> {
    req.param("id")
        .map(str::to_owned)
        .ok_or_else(|| WireError::invalid("no task id"))
}

fn ok() -> (u16, Value) {
    (200, json!({ "ok": true }))
}

fn mode_of(v: &Value) -> Option<Mode> {
    v.get("mode")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
}

fn text_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// A task as v1's GET /sessions/:id answered it: the whole session file's shape.
async fn v1_session(r: &Runtime, id: &str) -> crate::error::Result<Value> {
    let session = r.get(id).await?;
    let mut turns = Vec::new();
    for t in r.turns(id, None, None).await? {
        let steps = r
            .activity(t.id.as_str(), None)
            .await?
            .items
            .into_iter()
            .map(|s| {
                let mut v = upcast::to_v0(&s.activity);
                v["t"] = s.t.into();
                (s.t, v)
            });
        let changes = t
            .ext
            .get("wisp.runtime")
            .and_then(|v| v.get("changes"))
            .and_then(|c| serde_json::from_value(c.clone()).ok())
            .unwrap_or_default();
        turns.push(ImportedTurn {
            turn: t,
            steps: steps.collect(),
            changes,
        });
    }
    Ok(to_v1(&Imported { session, turns }))
}

fn start_args(b: &Value) -> crate::error::Result<StartArgs> {
    let mut a: StartArgs = serde_json::from_value(b.clone())?;
    a.mode = mode_of(b);
    Ok(a)
}

fn follow_args(id: String, b: &Value) -> FollowUpArgs {
    let run = RunPick {
        agent: text_of(b, "agent"),
        model: text_of(b, "model"),
        effort: text_of(b, "effort"),
    };
    let has_run = run.agent.is_some() || run.model.is_some() || run.effort.is_some();
    FollowUpArgs {
        id: id.into(),
        text: text_of(b, "text").unwrap_or_default(),
        attachments: b
            .get("attachments")
            .and_then(|a| serde_json::from_value(a.clone()).ok())
            .unwrap_or_default(),
        queue: b.get("queue").and_then(Value::as_bool),
        mode: mode_of(b),
        run: has_run.then_some(run),
        by: None,
    }
}

pub fn register(s: &mut Setup, slot: &Slot) {
    reads(s, slot);
    tasks(s, slot);
    runs(s, slot);
    queue(s, slot);
}

fn reads(s: &mut Setup, slot: &Slot) {
    add(
        s,
        slot,
        "GET",
        "/sessions",
        "runtime:list",
        "List tasks",
        |r, req| async move {
            let archived = req.query("archived").map(|a| a == "true" || a == "1");
            let limit = req
                .query("limit")
                .and_then(|l| l.parse().ok())
                .filter(|l| *l > 0);
            let children = req.query("children").is_some();
            let rows: Vec<Value> = r
                .list(&ListArgs {
                    archived,
                    limit: None,
                })
                .iter()
                .filter(|x| children || x.parent_id.is_none())
                .filter(|x| {
                    req.query("state").is_none_or(|st| {
                        st.split(',').any(|s| {
                            serde_json::to_value(x.state)
                                .ok()
                                .and_then(|v| v.as_str().map(|v| v == s))
                                .unwrap_or(false)
                        })
                    })
                })
                .filter(|x| req.query("agent").is_none_or(|a| x.agent == a))
                .map(|x| serde_json::to_value(&**x).unwrap_or(Value::Null))
                .collect();
            let rows = match limit {
                Some(n) => rows.into_iter().take(n).collect(),
                None => rows,
            };
            Ok((200, Value::Array(rows)))
        },
    );
    add(
        s,
        slot,
        "GET",
        "/search",
        "runtime:search",
        "Search past tasks",
        |r, req| async move {
            let limit = req
                .query("limit")
                .and_then(|l| l.parse().ok())
                .unwrap_or(30u32)
                .clamp(1, 100);
            Ok((
                200,
                json!({ "hits": r.search(req.query("q").unwrap_or(""), limit).await? }),
            ))
        },
    );
    add(
        s,
        slot,
        "GET",
        "/sessions/:id",
        "runtime:get",
        "One task, whole",
        |r, req| async move { Ok((200, v1_session(&r, &id(&req)?).await?)) },
    );
}

fn tasks(s: &mut Setup, slot: &Slot) {
    add(
        s,
        slot,
        "POST",
        "/sessions",
        "runtime:create",
        "Start a task",
        |r, req| async move {
            let body: Value = req.json()?;
            let out = r.create(start_args(&body)?).await?;
            let row = r
                .list(&ListArgs::default())
                .into_iter()
                .find(|x| x.id == out.id);
            Ok((
                201,
                row.map_or_else(
                    || json!({ "id": out.id }),
                    |x| serde_json::to_value(&*x).unwrap_or(Value::Null),
                ),
            ))
        },
    );
    add(
        s,
        slot,
        "PATCH",
        "/sessions/:id",
        "runtime:rename",
        "Rename, archive, mark read, mark done",
        |r, req| async move {
            let (id, b): (String, Value) = (id(&req)?, req.json()?);
            if let Some(t) = text_of(&b, "title").filter(|t| !t.trim().is_empty()) {
                r.rename(&id, &t).await?;
            }
            if let Some(a) = b.get("archived").and_then(Value::as_bool) {
                r.archive(&id, a).await?;
            }
            if let Some(u) = b.get("unread").and_then(Value::as_bool) {
                r.mark_read(&id, u).await?;
            }
            if let Some(st) = b
                .get("state")
                .and_then(|v| serde_json::from_value::<SessionState>(v.clone()).ok())
            {
                r.set_state(&id, st).await?;
            }
            Ok((200, v1_session(&r, &id).await?))
        },
    );
    add(
        s,
        slot,
        "DELETE",
        "/sessions/:id",
        "runtime:delete",
        "Delete a task",
        |r, req| async move {
            r.delete(&id(&req)?).await?;
            Ok(ok())
        },
    );
}

fn runs(s: &mut Setup, slot: &Slot) {
    add(
        s,
        slot,
        "POST",
        "/sessions/:id/reply",
        "runtime:followUp",
        "Follow up",
        |r, req| async move {
            let (id, b): (String, Value) = (id(&req)?, req.json()?);
            if text_of(&b, "text").is_none_or(|t| t.trim().is_empty()) {
                return Ok((400, json!({ "error": "text required" })));
            }
            let out = r.follow_up(follow_args(id, &b)).await?;
            Ok((
                200,
                json!({ "queued": out.queued.is_some(), "turnId": out.turn_id }),
            ))
        },
    );
    add(
        s,
        slot,
        "POST",
        "/sessions/:id/stop",
        "runtime:stop",
        "Stop the run (queued follow-ups are held)",
        |r, req| async move {
            r.stop(&id(&req)?, false).await?;
            Ok(ok())
        },
    );
    add(
        s,
        slot,
        "GET",
        "/sessions/:id/presentation",
        "runtime:presentation",
        "A turn's answer",
        |r, req| async move {
            let turn = req.query("turn").and_then(|t| t.parse().ok());
            Ok((
                200,
                json!({ "presentation": r.presentation(&id(&req)?, turn).await? }),
            ))
        },
    );
}

fn queue(s: &mut Setup, slot: &Slot) {
    add(
        s,
        slot,
        "DELETE",
        "/sessions/:id/queue",
        "runtime:queue.edit",
        "Take a queued follow-up back",
        |r, req| async move {
            let item = req.query("item").unwrap_or_default().to_owned();
            let a = QueueEditArgs {
                id: id(&req)?.into(),
                items: Vec::new(),
                remove: vec![item],
                held: None,
            };
            r.queue_edit(a).await?;
            Ok(ok())
        },
    );
    add(
        s,
        slot,
        "PATCH",
        "/sessions/:id/queue",
        "runtime:queue.edit",
        "Edit, reorder, merge or send a queued follow-up",
        |r, req| async move {
            let (id, b): (String, Value) = (id(&req)?, req.json()?);
            let strs = |k: &str| {
                b.get(k).and_then(Value::as_array).map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
            };
            let item = text_of(&b, "item").unwrap_or_default();
            if let Some(order) = strs("order") {
                let items = order
                    .into_iter()
                    .map(|i| wisp_runtime_api::model::QueueItem {
                        id: i,
                        ..Default::default()
                    })
                    .collect();
                let q = r.get(&id).await?.queue;
                let items = keep_texts(items, &q);
                r.queue_edit(QueueEditArgs {
                    id: id.into(),
                    items,
                    remove: Vec::new(),
                    held: None,
                })
                .await?;
            } else if let Some(m) = strs("merge") {
                r.queue_merge(&id, &m).await?;
            } else if b.get("now").and_then(Value::as_bool) == Some(true) {
                r.queue_send_now(&id, &item).await?;
            } else {
                let Some(t) = text_of(&b, "text").filter(|t| !t.trim().is_empty()) else {
                    return Ok((
                        400,
                        json!({ "error": "text required: what the follow-up says." }),
                    ));
                };
                r.queue_text(&id, &item, t.trim()).await?;
            }
            Ok(ok())
        },
    );
}

/// A reorder carries ids only: each item keeps the text it has.
fn keep_texts(
    items: Vec<wisp_runtime_api::model::QueueItem>,
    q: &[wisp_runtime_api::model::QueueItem],
) -> Vec<wisp_runtime_api::model::QueueItem> {
    items
        .into_iter()
        .map(|i| q.iter().find(|x| x.id == i.id).cloned().unwrap_or(i))
        .collect()
}
