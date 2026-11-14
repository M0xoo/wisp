//! wisp.events (ADR-0044): the durable event log, seen from outside the process.
//!
//! - **Commands:** `events.tail` (type glob, subject, since; a capped agent's call sees its own task's
//!   events only), `events.why` (the chain of causes, root first), `events.retry` / `events.parked`
//!   (what a subscription gave up on), `events.ls` (the catalogue from every manifest's
//!   `contributes.events`), `events.sinksStatus` / `events.resume`.
//! - **The topic:** a durable subscription (`feed`) keeps the last 5 000 events as `events_view` rows, each
//!   on `events:*`, `events:<area>.*` and `events:<type>`, so a client subscribes and resumes from its
//!   cursor like any topic (no second protocol). The row and the cursor are one write.
//! - **MCP:** `wisp_events` (read).
//! - **Sinks** (`sinks.rs`): `events.sink@1`, and a signed webhook.
//!
//! resources: data-only (the view is a copy of the log for the topic; a sink's row is how it's doing. The
//! sinks themselves are the `events.sinks` setting, wisp.settings' `setting` kind).

mod sinks;

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_events_api as api;
use wisp_kernel::durable::{EventLog, StoredEvent};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_store::{Col, EntityDef, Migration, Row, Store};

pub const OWNER: &str = "events";
/// How many events the topic keeps.
pub const VIEW_KEEP: u64 = 5_000;

pub const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE events_view (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL, plugin TEXT NOT NULL, subject TEXT, at INTEGER NOT NULL, data TEXT) STRICT;
     CREATE TABLE events_sink (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

/// The topics an event's row is on: every event, its area, its type.
pub fn topics_of(ty: &str) -> Vec<String> {
    let mut out = vec!["events:*".to_owned()];
    if let Some((area, _)) = ty.split_once('.') {
        out.push(format!("events:{area}.*"));
    }
    out.push(format!("events:{ty}"));
    out.retain(|t| wisp_store::is_topic(t));
    out
}

fn view_topics(r: &Row) -> Vec<String> {
    topics_of(r.get("type").and_then(Value::as_str).unwrap_or_default())
}

fn sink_topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.events:sinks".into()]
}

pub const VIEW: EntityDef = EntityDef {
    kind: "events_view",
    table: "events_view",
    key: "id",
    columns: &[
        ("id", Col::Text),
        ("seq", Col::Int),
        ("type", Col::Text),
        ("plugin", Col::Text),
        ("subject", Col::Text),
        ("at", Col::Int),
        ("data", Col::Text),
    ],
    json_columns: &["data"],
    parent: None,
    seq: None,
    topics: view_topics,
};

pub const SINK_STATE: EntityDef = EntityDef {
    kind: "events_sink",
    table: "events_sink",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: sink_topics,
};

/// An event as `wisp events tail --json` shows it.
pub fn view(e: &StoredEvent) -> Value {
    json!({ "seq": e.seq, "type": e.event.ty, "plugin": e.event.plugin, "subject": e.event.subject, "key": e.event.key, "cause": e.event.cause, "root": e.event.root, "at": e.event.at, "data": e.event.data })
}

fn log(ctx: &Ctx) -> Result<Arc<dyn EventLog>> {
    ctx.event_log().ok_or_else(|| WireError::unavailable("this wisp keeps no event log"))
}

fn store(ctx: &Ctx) -> Result<Store> {
    Ok(ctx.service::<Store>()?.as_ref().clone())
}

/// The subject a caller may see: a task's agent sees its own task's events only.
fn scoped_subject(call: &Call, asked: Option<String>) -> Result<Option<String>> {
    let c = call.caller();
    match c.session.as_deref() {
        Some(mine) if c.set.starts_with("agent") => match asked {
            Some(s) if s != mine => Err(WireError::forbidden("a task's agent sees its own task's events only")),
            _ => Ok(Some(mine.to_owned())),
        },
        _ => Ok(asked),
    }
}

async fn tail(ctx: &Ctx, call: &Call, a: api::TailArgs) -> Result<Value> {
    let l = log(ctx)?;
    let subject = scoped_subject(call, a.subject)?;
    let limit = usize::try_from(a.limit.unwrap_or(100).clamp(1, 1000)).unwrap_or(100);
    let pattern = a.ty.unwrap_or_else(|| "*".into());
    let (_, last) = l.bounds().await?;
    // without `since`: the newest, read back far enough to find `limit` of them
    let mut after = a.since.unwrap_or_else(|| last.saturating_sub(20_000));
    let mut out: Vec<Value> = Vec::new();
    loop {
        let rows = l.read(after, 1000).await?;
        let Some(end) = rows.last().map(|r| r.seq) else { break };
        for r in &rows {
            let ok_type = wisp_kernel::perm::glob(&pattern, &r.event.ty);
            let ok_subject = subject.as_deref().is_none_or(|s| r.event.subject.as_deref() == Some(s));
            if ok_type && ok_subject {
                out.push(view(r));
            }
        }
        after = end;
        if a.since.is_some() && out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    if a.since.is_none() && out.len() > limit {
        out.drain(..out.len() - limit);
    }
    Ok(Value::Array(out))
}

/// The chain of causes of `seq`, root first.
async fn why(ctx: &Ctx, call: &Call, seq: u64) -> Result<Value> {
    let l = log(ctx)?;
    let subject = scoped_subject(call, None)?;
    let mut chain = Vec::new();
    let mut at = Some(seq);
    while let Some(s) = at {
        if chain.len() >= 16 {
            break;
        }
        let Some(e) = l.get(s).await? else {
            if chain.is_empty() {
                return Err(WireError::not_found(format!("event {seq} isn't kept (or never was)")));
            }
            break;
        };
        if subject.as_deref().is_some_and(|m| e.event.subject.as_deref() != Some(m)) {
            return Err(WireError::forbidden("a task's agent sees its own task's events only"));
        }
        at = e.event.cause;
        chain.push(view(&e));
    }
    chain.reverse();
    Ok(Value::Array(chain))
}

/// Every plugin's declared events.
fn catalogue(ctx: &Ctx) -> Value {
    let mut out = Vec::new();
    for m in ctx.manifests() {
        for e in m.contributes.get("events").and_then(Value::as_array).into_iter().flatten() {
            let entry = match e {
                Value::String(t) => json!({ "type": t, "durable": false }),
                Value::Object(o) => {
                    let mut o = o.clone();
                    o.entry("durable").or_insert(json!(false));
                    Value::Object(o)
                }
                _ => continue,
            };
            let mut entry = entry;
            entry["plugin"] = json!(m.id);
            out.push(entry);
        }
    }
    out.sort_by(|a, b| a["type"].as_str().cmp(&b["type"].as_str()));
    Value::Array(out)
}

/// The view row for an event (and, every 500, the old rows trimmed), in the handler's write.
async fn feed(ctx: &Ctx, e: &wisp_kernel::EventEnvelope) -> Result<()> {
    if e.ty == wisp_kernel::durable::GAP {
        return Ok(());
    }
    let seq = e.durable_seq.unwrap_or(0);
    let mut row = Row::new();
    row.insert("id".into(), json!(format!("{seq:012}")));
    row.insert("seq".into(), json!(seq));
    row.insert("type".into(), json!(e.ty));
    row.insert("plugin".into(), json!(e.plugin));
    row.insert("subject".into(), json!(e.subject));
    row.insert("at".into(), json!(e.at));
    row.insert("data".into(), e.data());
    store(ctx)?
        .write(move |w| {
            w.upsert(VIEW.kind, row)?;
            if seq.is_multiple_of(500) && seq > VIEW_KEEP {
                let old = w.query(VIEW.kind, &wisp_store::Query::new().select(&["id", "seq"]))?;
                for r in old {
                    if r.get("seq").and_then(Value::as_u64).is_some_and(|s| s + VIEW_KEEP <= seq)
                        && let Some(id) = r.get("id").and_then(Value::as_str)
                    {
                        w.del(VIEW.kind, id)?;
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| WireError::internal(e.to_string()))
}

fn mcp_tool() -> wisp_mcp_api::ToolContribution {
    wisp_mcp_api::ToolContribution {
        tool: json!({
            "name": "wisp_events",
            "description": "What happened in wisp, from its durable event log: tasks finished, failed or asking, PRs opened and merged, reviews, triggers. Filter by type (a glob like pr.*), subject (a task id) or since (a seq). A task's agent sees its own task's events.",
            "inputSchema": { "type": "object", "properties": {
                "type": { "type": "string", "description": "a type or glob: turn.finished, pr.*" },
                "subject": { "type": "string" },
                "since": { "type": "number" },
                "limit": { "type": "number" }
            } },
            "annotations": { "readOnlyHint": true }
        }),
        audience: wisp_mcp_api::Audience::Both,
        read_only: true,
        capped_off: false,
        run: Arc::new(|ctx, call, tc| {
            Box::pin(async move {
                Ok(match ctx.run_json(&call, "events.tail", tc.args).await {
                    Ok(v) => wisp_mcp_api::ToolText { text: Some(v.to_string()), error: None },
                    Err(e) => wisp_mcp_api::ToolText { text: None, error: Some(e.message) },
                })
            })
        }),
    }
}

#[derive(Debug, Default)]
pub struct EventsPlugin;

impl Plugin for EventsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<api::Tail, _, _>(|ctx, call, a| async move { tail(&ctx, &call, a).await });
        s.command::<api::Why, _, _>(|ctx, call, a| async move { why(&ctx, &call, a.seq).await });
        s.command::<api::Retry, _, _>(|ctx, _call, a| async move { Ok(json!({ "delivered": ctx.retry_event(a.seq).await? })) });
        s.command::<api::ParkedCmd, _, _>(|ctx, _call, _a| async move {
            Ok(serde_json::to_value(log(&ctx)?.parked().await?).unwrap_or_default())
        });
        s.command::<api::Ls, _, _>(|ctx, _call, _a| async move { Ok(catalogue(&ctx)) });
        sinks::register(s);
        s.contribute(&wisp_mcp_api::TOOL_POINT, Arc::new(mcp_tool()));
        s.on_durable_any("feed", "*", |ctx, _call, e| async move { feed(&ctx, &e).await });
        s.on_start(|ctx| async move {
            let st = store(&ctx)?;
            st.migrate(OWNER, MIGRATIONS).map_err(|e| WireError::internal(e.to_string()))?;
            st.define_entity(VIEW).map_err(|e| WireError::internal(e.to_string()))?;
            st.define_entity(SINK_STATE).map_err(|e| WireError::internal(e.to_string()))?;
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_on_every_events_topic_they_match() {
        assert_eq!(topics_of("pr.opened"), ["events:*", "events:pr.*", "events:pr.opened"]);
        assert_eq!(topics_of("x"), ["events:*", "events:x"]);
        assert_eq!(EventsPlugin.manifest().id, api::PLUGIN);
    }
}
