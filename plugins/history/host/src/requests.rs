//! Resume requests (ADR-0033): an agent (in Claude Code, through `wisp_resume`) or a teammate asks to
//! resume an earlier task; nothing starts until the user says yes. Kept in the plugin's table, so a
//! restart keeps them.

use serde_json::{Value, json};
use wisp_history_api::{AnswerArgs, Requests, ResumeAnswer, ResumeRequest, ResumeRequestArgs, ResumeRequestCmd};
use wisp_kernel::{Call, Ctx, Result, Setup, WireError};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

const KIND: &str = "history_request";
const SQL: &str = "CREATE TABLE history_request (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;";

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.history:requests".into()]
}

const DEF: EntityDef = EntityDef { kind: KIND, table: KIND, key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

static READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();

fn store(ctx: &Ctx) -> Result<std::sync::Arc<Store>> {
    let s = ctx.service::<Store>()?;
    if READY.get().is_none() {
        s.migrate("history.request", &[Migration::sql(1, SQL)]).map_err(|e| WireError::internal(e.to_string()))?;
        s.define_entity(DEF).map_err(|e| WireError::internal(e.to_string()))?;
        let _ = READY.set(());
    }
    Ok(s)
}

async fn put(ctx: &Ctx, r: &ResumeRequest) -> Result<()> {
    let s = store(ctx)?;
    let (id, body) = (r.id.clone(), serde_json::to_value(r).unwrap_or_default());
    s.write(move |w| {
        let mut row = Row::new();
        row.insert("id".into(), json!(id));
        row.insert("body".into(), body);
        w.upsert(KIND, row).map(|_| ())
    })
    .await
    .map_err(|e| WireError::internal(e.to_string()))
}

async fn all(ctx: &Ctx) -> Result<Vec<ResumeRequest>> {
    let s = store(ctx)?;
    let rows = s.read_async(|r| r.query(KIND, &Query::new())).await.map_err(|e| WireError::internal(e.to_string()))?;
    let mut out: Vec<ResumeRequest> = rows.into_iter().filter_map(|r| serde_json::from_value(r.get("body")?.clone()).ok()).collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.at));
    Ok(out)
}

/// The task a request names, from the repo's history or the runtime: (title, what was asked, report, repo).
async fn source(ctx: &Ctx, call: &Call, id: &str, repo: Option<&str>) -> Result<(String, String, String, String, String)> {
    if let Some(r) = repo {
        let root = std::path::PathBuf::from(r);
        let docs = super::docs(&root).await;
        if let Some(d) = wisp_history_core::find(&docs, id) {
            let report = tokio::fs::read_to_string(root.join(d.path.replace(".task.yml", ".report.md"))).await.unwrap_or_default();
            let asked = d.doc.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default().to_owned();
            return Ok((d.id().to_owned(), d.title().to_owned(), asked, report, r.to_owned()));
        }
    }
    let t = ctx.run_json(call, "runtime.get", json!({ "id": id })).await.map_err(|_| WireError::not_found(format!("no task {id} here or in the repo's history")))?;
    let spec = ctx.run_json(call, "runtime.spec", json!({ "id": id })).await.unwrap_or_default();
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    Ok((s(&t, "id"), s(&t, "title"), s(&spec, "prompt"), String::new(), repo.map_or_else(|| s(&t, "cwd"), str::to_owned)))
}

async fn request(ctx: &Ctx, call: &Call, a: ResumeRequestArgs) -> Result<ResumeRequest> {
    let (task, title, _, _, repo) = source(ctx, call, &a.id, a.repo.as_deref()).await?;
    // the same ask, still pending, isn't made twice
    if let Some(r) = all(ctx).await?.into_iter().find(|r| r.task == task && r.state == "pending") {
        return Ok(r);
    }
    let by = if a.by.is_empty() { call.caller().session.clone().map_or_else(|| call.caller().set.clone(), |s| format!("task {s}")) } else { a.by };
    let r = ResumeRequest { id: wisp_kernel::ids::uuid7(), task, title, by, why: a.why, repo, at: ctx.clock().map_or(0, |c| c.now_ms()), state: "pending".into(), started: None };
    put(ctx, &r).await?;
    if let Ok(n) = wisp_kernel::services::notify(ctx) {
        n.notice("history.resume", json!({ "request": r.id, "task": r.task, "title": r.title, "by": r.by, "why": r.why }), None);
    }
    Ok(r)
}

async fn answer(ctx: &Ctx, call: &Call, a: AnswerArgs) -> Result<ResumeRequest> {
    let mut r = all(ctx).await?.into_iter().find(|r| r.id == a.request).ok_or_else(|| WireError::not_found("no such request"))?;
    if r.state != "pending" {
        return Err(WireError::conflict(format!("that request is {} already", r.state)));
    }
    if a.approve {
        let (_, title, asked, report, repo) = source(ctx, call, &r.task, Some(&r.repo)).await?;
        let prompt = wisp_history_core::resume_prompt(&title, &asked, &report);
        let made = ctx.run_json(call, "runtime.create", json!({ "prompt": prompt, "title": format!("{title} (resumed)"), "cwd": repo, "lineage": { "forkOf": r.task } })).await?;
        r.started = made.get("id").and_then(Value::as_str).map(str::to_owned);
        "approved".clone_into(&mut r.state);
    } else {
        "denied".clone_into(&mut r.state);
    }
    put(ctx, &r).await?;
    Ok(r)
}

pub fn register(s: &mut Setup) {
    s.command::<ResumeRequestCmd, _, _>(|ctx, call, a| async move { request(&ctx, &call, a).await });
    s.command::<ResumeAnswer, _, _>(|ctx, call, a| async move { answer(&ctx, &call, a).await });
    s.command::<Requests, _, _>(|ctx, _call, _a| async move { all(&ctx).await });
}
