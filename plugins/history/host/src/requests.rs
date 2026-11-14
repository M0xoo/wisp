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

const DEF: EntityDef = EntityDef {
    kind: KIND,
    table: KIND,
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

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
        let root = super::named_repo(r)?;
        let docs = super::docs(&root).await;
        if let Some(d) = wisp_history_core::find(&docs, id) {
            let report = tokio::fs::read_to_string(root.join(d.path.replace(".task.yml", ".report.md"))).await.unwrap_or_default();
            let asked = d.doc.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default().to_owned();
            return Ok((d.id().to_owned(), d.title().to_owned(), asked, report, r.to_owned()));
        }
    }
    let t =
        super::calls::task(ctx, call, id).await.map_err(|_| WireError::not_found(format!("no task {id} here or in the repo's history")))?;
    let asked = super::calls::spec(ctx, call, id).await.map_or_else(
        |e| {
            tracing::warn!(task = id, "history: runtime.spec: {}", e.message);
            String::new()
        },
        |s| s.prompt,
    );
    let repo = repo.map_or(t.cwd, str::to_owned);
    // a resumed task runs in the repo: a task with no folder would run in the server's own
    if let Err(e) = wisp_runtime_api::paths::Folder::of(&repo) {
        return Err(WireError::invalid(format!("task {id} has {e}: name its repo")));
    }
    Ok((t.id.as_str().to_owned(), t.title, asked, String::new(), repo))
}

async fn request(ctx: &Ctx, call: &Call, a: ResumeRequestArgs) -> Result<ResumeRequest> {
    let (task, title, _, _, repo) = source(ctx, call, &a.id, a.repo.as_deref()).await?;
    // the same ask, still pending, isn't made twice
    if let Some(r) = all(ctx).await?.into_iter().find(|r| r.task == task && r.state == "pending") {
        return Ok(r);
    }
    let by = if a.by.is_empty() {
        call.caller().session.clone().map_or_else(|| call.caller().set.clone(), |s| format!("task {s}"))
    } else {
        a.by
    };
    let r = ResumeRequest {
        id: wisp_kernel::ids::uuid7(),
        task,
        title,
        by,
        why: a.why,
        repo,
        at: ctx.clock().map_or(0, |c| c.now_ms()),
        state: "pending".into(),
        started: None,
    };
    put(ctx, &r).await?;
    if let Ok(n) = wisp_kernel::services::notify(ctx) {
        // it reaches chat channels: masked as the row is
        let mut note = json!({ "request": r.id, "task": r.task, "title": r.title, "by": r.by, "why": r.why });
        mask_body(ctx.use_service::<wisp_runtime_api::env::EnvMaskService>().ok().as_deref(), &mut note);
        n.notice("history.resume", note, None);
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
        r.started = Some(super::calls::create_fork(ctx, call, prompt, format!("{title} (resumed)"), repo, r.task.clone()).await?);
        "approved".clone_into(&mut r.state);
    } else {
        "denied".clone_into(&mut r.state);
    }
    put(ctx, &r).await?;
    Ok(r)
}

/// wisp.history's view of its resume requests as they leave (ADR-0054, the `kernel.egress` point), on
/// `plugin:wisp.history:requests`: the `why` an agent wrote (and the task's title) go through wisp.runtime's
/// `runtime.envmask@1`, masked against the .env values of the task that asked (`by: "task <id>"`) or, when an agent
/// outside wisp asked, of the task it asks to resume; hidden when those can't be told or wisp.runtime is off (fail
/// closed). The store keeps them as they are; `history.requests` answers them the same way.
pub(crate) struct View(pub(crate) Ctx);

/// The task whose values a request's text is masked against.
fn asker(body: &Value) -> Option<String> {
    let by = body.get("by").and_then(Value::as_str).and_then(|b| b.strip_prefix("task ")).filter(|t| !t.is_empty());
    by.or_else(|| body.get("task").and_then(Value::as_str)).map(str::to_owned)
}

/// A request (its body) masked as it leaves (`m` `None`: hidden).
pub(crate) fn mask_body(m: Option<&dyn wisp_runtime_api::env::EnvMask>, body: &mut Value) -> bool {
    let task = asker(body);
    ["why", "title"].iter().fold(false, |c, k| {
        body.get_mut(*k).filter(|x| x.is_string()).is_some_and(|x| wisp_runtime_api::env::mask_or_hide(m, task.as_deref(), x, None)) | c
    })
}

fn masked(ctx: &Ctx, rs: Vec<ResumeRequest>) -> Result<Vec<ResumeRequest>> {
    let m = ctx.use_service::<wisp_runtime_api::env::EnvMaskService>().ok();
    let closed = |e: serde_json::Error| WireError::internal(format!("couldn't hide .env values: {e}"));
    let mut v = serde_json::to_value(rs).map_err(closed)?;
    for b in v.as_array_mut().into_iter().flatten() {
        mask_body(m.as_deref(), b);
    }
    serde_json::from_value(v).map_err(closed)
}

/// One request as a command answers it: masked as its row is.
fn one(ctx: &Ctx, r: ResumeRequest) -> Result<ResumeRequest> {
    masked(ctx, vec![r])?.pop().ok_or_else(|| WireError::internal("couldn't hide .env values"))
}

impl wisp_kernel::egress::RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &[KIND]
    }
    fn row(&self, _kind: &str, v: &mut Value) {
        let m = self.0.use_service::<wisp_runtime_api::env::EnvMaskService>().ok();
        if let Some(b) = v.get_mut("body") {
            mask_body(m.as_deref(), b);
        }
    }
    fn patch(&self, kind: &str, path: &str, v: &mut Value) {
        // requests are upserted whole, so none is sent; one that can't say whose it is: hidden
        if path.is_empty() {
            return self.row(kind, v);
        }
        let m = self.0.use_service::<wisp_runtime_api::env::EnvMaskService>().ok();
        wisp_runtime_api::env::mask_or_hide(m.as_deref(), None, v, None);
    }
}

pub fn register(s: &mut Setup) {
    s.contribute(&wisp_kernel::egress::VIEWS, std::sync::Arc::new(View(s.ctx())) as std::sync::Arc<dyn wisp_kernel::egress::RowView>);
    s.command::<ResumeRequestCmd, _, _>(|ctx, call, a| async move { one(&ctx, request(&ctx, &call, a).await?) });
    s.command::<ResumeAnswer, _, _>(|ctx, call, a| async move { one(&ctx, answer(&ctx, &call, a).await?) });
    s.command::<Requests, _, _>(|ctx, _call, _a| async move { masked(&ctx, all(&ctx).await?) });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod egress_tests {
    use super::*;
    use wisp_runtime_api::env::EnvMask;

    /// What wisp.runtime's service does: task "s1" read `sk-live-one`; any other isn't in memory.
    struct Fake;
    impl EnvMask for Fake {
        fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
            match (task, v) {
                (Some("s1"), Value::String(s)) => {
                    let m = s.replace("sk-live-one", "••••");
                    let c = m != *s;
                    *s = m;
                    c
                }
                (_, v) => wisp_runtime_api::env::hide(v, &[]),
            }
        }
    }

    fn req(by: &str, task: &str) -> Value {
        serde_json::to_value(ResumeRequest {
            id: "q1".into(),
            task: task.into(),
            title: "Rotate the key".into(),
            by: by.into(),
            why: "it left sk-live-one in the config".into(),
            repo: "/w".into(),
            at: 1,
            state: "pending".into(),
            started: None,
        })
        .unwrap()
    }

    #[test]
    fn a_resume_requests_why_quoting_a_value_leaves_masked_against_the_task_that_asked_or_the_one_it_names() {
        // stored as asked: the value is in the row (before this view, it left so)
        let mut b = req("task s1", "old");
        assert!(b.to_string().contains("sk-live-one"));
        assert!(mask_body(Some(&Fake), &mut b));
        assert_eq!(b["why"], "it left •••• in the config", "the asking task's values");
        assert_eq!(b["title"], "Rotate the key");
        assert_eq!(b["state"], "pending");
        // an agent outside wisp asked: the task it names
        let mut b = req("claude-code", "s1");
        assert!(mask_body(Some(&Fake), &mut b));
        assert_eq!(b["why"], "it left •••• in the config");
        // not in memory, or wisp.runtime off: hidden
        let mut b = req("task s9", "s1");
        assert!(mask_body(Some(&Fake), &mut b));
        assert_eq!(b["why"], "••••");
        let mut b = req("task s1", "s1");
        assert!(mask_body(None, &mut b));
        assert_eq!(b["why"], "••••");
    }
}
