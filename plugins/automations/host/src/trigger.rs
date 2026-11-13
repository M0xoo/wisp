//! wisp.automations' `trigger` kind (ADR-0028, ADR-0043): the only declaration of a trigger. Kept as declared
//! (`StoredKind`); sensitive (it acts without you). Its spec is `wisp_automations_api::TriggerSpec`, checked at plan
//! (`spec::check`), and every change reloads the engine. The rest of the wiring is here too: the webhook route,
//! the durable subscription, the commands and the tick.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_automations_api::commands as c;
use wisp_automations_api::{Target, TriggerEvent, TriggerSpec};
use wisp_kernel::{BoxFuture, Call, Ctx, Result, Setup};
use wisp_resources_api::{KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, StoredKind, schema_of};

use crate::engine::{Engine, Shared, from_envelope, outcome_of};

/// A webhook's body is capped at 1 MB (413 above it, ADR-0043 edge case 11).
pub const WEBHOOK_MAX: usize = 1024 * 1024;

struct TriggerKind {
    inner: Arc<StoredKind>,
    engine: Shared,
}

async fn refresh(inner: &StoredKind, engine: &Engine) {
    let list = inner
        .specs()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(n, v)| Some((n, serde_json::from_value::<TriggerSpec>(v).ok()?)))
        .collect();
    *engine.declared.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
}

impl ResourceKind for TriggerKind {
    fn info(&self) -> KindInfo {
        self.inner.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.inner.read(call)
    }
    fn check(&self, r: &Resource) -> Vec<String> {
        match serde_json::from_value::<TriggerSpec>(r.spec.clone()) {
            Ok(s) => wisp_automations_api::spec::check(&s),
            Err(e) => vec![format!("not a trigger: {e}")],
        }
    }
    fn describe(&self, op: &Op) -> Option<String> {
        let s: TriggerSpec = serde_json::from_value(op.spec.clone()).unwrap_or_default();
        let what = match s.target() {
            Target::Task(t) => format!("starts the task {t}"),
            Target::Prompt(_) => "starts a task".to_owned(),
            Target::Crew(m) => format!("wakes {m}"),
            Target::Workflow(w) => format!("runs the workflow {w}"),
            Target::FollowUp => "follows up the event's task".to_owned(),
        };
        Some(format!("{what} by itself on {} ({})", s.on, op.name))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.inner.apply(call, op).await?;
            refresh(&self.inner, &self.engine).await;
            Ok(())
        })
    }
}

/// `${secret:NAME}` read from secrets; a literal stays as it is.
async fn secret_of(ctx: &Ctx, v: &str) -> Option<String> {
    let name = v.strip_prefix("${secret:").and_then(|r| r.strip_suffix('}'));
    match name {
        Some(n) => wisp_kernel::services::secrets(ctx).ok()?.get(n).await.ok().flatten(),
        None => Some(v.to_owned()).filter(|v| !v.is_empty()),
    }
}

/// Equal in constant time: how long it takes says nothing about how much of the secret was right.
pub fn same(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq as _;
    // ct_eq on unequal lengths answers 0 without comparing; compare against itself so the time doesn't depend on it
    let eq_len = a.len() == b.len();
    let other = if eq_len { b.as_bytes() } else { a.as_bytes() };
    bool::from(a.as_bytes().ct_eq(other)) && eq_len
}

/// v1 hooks.js:152: inbound webhooks are off until switched on at this computer (Settings → Automations); off,
/// every webhook answers the same 404 as one that isn't there.
pub const WEBHOOKS: &str = "automations.webhookTriggers";

/// What a webhook call gets, before it reaches the engine: 413 over the cap; the same 404 for a wrong or
/// missing secret, an unknown or off trigger, and one with no secret (an open route: the secret is the only key).
pub fn webhook_verdict(body_len: usize, want: Option<&str>, given: &str) -> Option<u16> {
    if body_len > WEBHOOK_MAX {
        return Some(413);
    }
    match want {
        Some(w) if same(given, w) => None,
        _ => Some(404),
    }
}

fn answer(status: u16, body: Value) -> wisp_kernel::http::Response {
    wisp_kernel::http::Response::Json { status, body }
}

/// `POST /api/triggers/:name`: the body is the event's payload (JSON, or `{text}`); `x-wisp-delivery` or
/// `x-github-delivery` is its dedupe key.
async fn webhook(ctx: Ctx, engine: Shared, req: wisp_kernel::http::Request) -> Result<wisp_kernel::http::Response> {
    if ctx.setting(WEBHOOKS).and_then(|v| v.as_bool()) != Some(true) {
        return Ok(answer(404, json!({ "error": "no such trigger" })));
    }
    let name = req.param("name").unwrap_or_default().to_owned();
    let t = engine.all(&ctx).into_iter().find(|t| t.name == name && t.spec.on == "webhook" && t.spec.on());
    let want = match &t {
        Some(t) => secret_of(&ctx, &t.spec.secret).await,
        None => None,
    };
    let given = req
        .header("x-wisp-secret")
        .map(str::to_owned)
        .or_else(|| req.header("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(str::to_owned))
        .or_else(|| req.query("secret").map(str::to_owned))
        .unwrap_or_default();
    if let Some(status) = webhook_verdict(req.body.len(), want.as_deref(), &given) {
        let msg = if status == 413 { "the body is over 1 MB" } else { "no such trigger" };
        return Ok(answer(status, json!({ "error": msg })));
    }
    let now = ctx.clock()?.now_ms();
    let payload = serde_json::from_slice::<Value>(&req.body)
        .unwrap_or_else(|_| json!({ "text": String::from_utf8_lossy(&req.body).chars().take(4000).collect::<String>() }));
    let key =
        req.header("x-wisp-delivery").or_else(|| req.header("x-github-delivery")).map_or_else(|| format!("webhook:{now}"), str::to_owned);
    let summary = payload
        .get("summary")
        .or_else(|| payload.get("text"))
        .and_then(Value::as_str)
        .map_or_else(|| format!("{name} was called"), |s| s.chars().take(160).collect());
    let ev = TriggerEvent { on: "webhook".into(), key, at: now, payload, summary, ..TriggerEvent::default() };
    let call = ctx.root_call();
    let out = engine.dispatch(&ctx, &call, &ev, Some(&name), now).await;
    let o = out
        .into_iter()
        .next()
        .map_or_else(|| c::FireOut { result: "nothing".into(), why: "seen before".into(), session: None }, |(_, o)| o);
    Ok(answer(202, json!({ "result": o.result, "why": o.why, "id": o.session })))
}

/// A durable event: every trigger on its type decides; a run a trigger started that ended counts.
async fn on_event(ctx: Ctx, engine: Shared, env: Arc<wisp_kernel::EventEnvelope>) -> Result<()> {
    if env.ty == "event.gap" {
        return Ok(());
    }
    let now = ctx.clock()?.now_ms();
    let data = env.data();
    match env.ty.as_str() {
        "task.finished" | "task.failed" => {
            if let Some(id) = &env.subject {
                engine.ended(&ctx, id, outcome_of(&env.ty, &data), false, now).await;
            }
        }
        "crew.reported" => {
            if let Some(id) = data.get("sessionId").and_then(Value::as_str) {
                engine.ended(&ctx, id, outcome_of(&env.ty, &data), true, now).await;
            }
        }
        _ => {}
    }
    let all = engine.all(&ctx);
    if !all.iter().any(|t| core_glob(&t.spec.on, &env.ty)) {
        return Ok(());
    }
    let call = ctx.root_call();
    // a trigger never fires on its own: what started the task the event is about, and how deep that chain is
    let (by, depth) = lineage(&ctx, &call, &engine, &env, &data).await;
    let ev = from_envelope(&env, by, depth);
    engine.dispatch(&ctx, &call, &ev, None, now).await;
    Ok(())
}

fn core_glob(on: &str, ty: &str) -> bool {
    wisp_automations_core::engine::glob(on, ty)
}

async fn lineage(ctx: &Ctx, call: &Call, engine: &Engine, env: &wisp_kernel::EventEnvelope, data: &Value) -> (Option<String>, u32) {
    if env.ty == "trigger.fired" {
        return (data.get("trigger").and_then(Value::as_str).map(|t| format!("trigger:{t}")), 0);
    }
    if let Some(b) = data.get("by").and_then(Value::as_str) {
        return (Some(b.to_owned()), 0);
    }
    let Some(subject) = &env.subject else { return (None, 0) };
    let spec =
        ctx.run::<wisp_runtime_api::commands::SpecOf>(call, wisp_runtime_api::commands::IdArgs { id: subject.as_str().into() }).await;
    let by = spec.ok().and_then(|s| s.lineage.triggered_by);
    let depth = engine.states().await.iter().filter_map(|(_, st)| st.depths.get(subject).copied()).max().unwrap_or(0);
    (by, depth)
}

fn now_of(ctx: &Ctx) -> Result<i64> {
    Ok(ctx.clock()?.now_ms())
}

fn commands(s: &mut Setup, engine: &Shared) {
    let e = engine.clone();
    s.command::<c::TriggerLs, _, _>(move |ctx, _, _| {
        let e = e.clone();
        async move { Ok(e.rows(&ctx).await) }
    });
    let e = engine.clone();
    s.command::<c::TriggerFire, _, _>(move |ctx, call, a| {
        let e = e.clone();
        async move { e.fire(&ctx, &call, &a.name, a.payload, a.summary, now_of(&ctx)?).await }
    });
    let e = engine.clone();
    s.command::<c::TriggerTest, _, _>(move |ctx, call, a| {
        let e = e.clone();
        async move { e.test(&ctx, &call, &a.name, a.event, a.last.unwrap_or(5), now_of(&ctx)?).await }
    });
    let e = engine.clone();
    s.command::<c::TriggerLog, _, _>(move |ctx, _, a| {
        let e = e.clone();
        async move {
            e.find(&ctx, &a.name)?;
            Ok(e.log(&a.name).await)
        }
    });
    let e = engine.clone();
    s.command::<c::TriggerPush, _, _>(move |ctx, call, ev| {
        let e = e.clone();
        async move {
            let now = now_of(&ctx)?;
            let out = e.dispatch(&ctx, &call, &ev, None, now).await;
            mentions(&ctx, &call, &ev).await;
            Ok(c::Count { n: u32::try_from(out.iter().filter(|(_, o)| o.result == "started").count()).unwrap_or(u32::MAX) })
        }
    });
    let e = engine.clone();
    s.command::<c::TriggerApprove, _, _>(move |ctx, call, a| {
        let e = e.clone();
        async move { e.approve(&ctx, &call, &a.name, &a.job, a.yes, now_of(&ctx)?).await }
    });
    let e = engine.clone();
    s.command::<c::TriggerResume, _, _>(move |ctx, _, a| {
        let e = e.clone();
        async move {
            e.resume(&ctx, &a.name, now_of(&ctx)?).await?;
            Ok(c::Done { ok: true })
        }
    });
    s.command::<c::Sources, _, _>(|ctx, _, _| async move { Ok(crate::engine::sources(&ctx)) });
}

/// `@member` in a pushed message wakes that member (ADR-0043 §5). A chat message only from someone the channel
/// knows (`trusted`): an open channel can't wake your crew.
async fn mentions(ctx: &Ctx, call: &Call, ev: &TriggerEvent) {
    let Some(text) = ev.payload.get("text").and_then(Value::as_str).filter(|t| t.contains('@')) else { return };
    if ev.on == "chat.message" && ev.payload.get("trusted").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if let Err(e) = ctx.run_json(call, "crew.wakeMentions", json!({ "text": text, "source": ev.on })).await {
        tracing::debug!("mentions not sent: {}", e.message);
    }
}

pub fn register(s: &mut Setup, engine: &Shared) {
    let inner = Arc::new(StoredKind::new(
        KindInfo::new("trigger", "triggers", "wisp.automations", schema_of::<TriggerSpec>()).order(85).sensitive(),
        s.ctx(),
    ));
    let k: Arc<dyn ResourceKind> = Arc::new(TriggerKind { inner: inner.clone(), engine: engine.clone() });
    s.contribute(&RESOURCE_KIND, k);
    let e = engine.clone();
    s.on_durable_any("engine", "*", move |ctx, _call, env| on_event(ctx, e.clone(), env));
    let hooks = engine.clone();
    s.route(wisp_kernel::http::Route {
        method: "POST",
        pattern: "/api/triggers/:name",
        permission: wisp_kernel::http::OPEN,
        doc: true,
        summary: "Send a webhook trigger an event (its secret as x-wisp-secret; at most 1 MB)",
        raw: true,
        max_body: Some(WEBHOOK_MAX),
        handler: Arc::new(move |ctx, _call, req| {
            let e = hooks.clone();
            Box::pin(async move { webhook(ctx, e, req).await })
        }),
    });
    commands(s, engine);
    let e = engine.clone();
    s.on_start(move |ctx| async move {
        refresh(&inner, &e).await;
        let clock = ctx.clock()?;
        let c2 = ctx.clone();
        ctx.spawn(async move {
            loop {
                // every 15 s: a schedule's minute is never missed, a debounce closes within 15 s of its window
                clock.sleep(15_000).await;
                e.tick(&c2, clock.now_ms()).await;
            }
        });
        Ok(())
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn webhook_secret_compared_constant_time_and_body_capped() {
        assert_eq!(webhook_verdict(10, Some("s3cret"), "s3cret"), None);
        assert_eq!(webhook_verdict(10, Some("s3cret"), "s3creT"), Some(404));
        assert_eq!(webhook_verdict(10, Some("s3cret"), "s3cre"), Some(404), "a prefix isn't the secret");
        assert_eq!(webhook_verdict(10, Some("s3cret"), ""), Some(404));
        assert_eq!(webhook_verdict(10, None, ""), Some(404), "no secret: the same 404 as a wrong one");
        assert_eq!(webhook_verdict(WEBHOOK_MAX, Some("s"), "s"), None, "1 MB exactly is taken");
        assert_eq!(webhook_verdict(WEBHOOK_MAX + 1, Some("s"), "s"), Some(413));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "abcd") && !same("", "a"));
        // the route says the same cap, so the edge refuses a bigger body (413) before reading it all
        assert_eq!(WEBHOOK_MAX, 1_048_576);
    }
}
