//! wisp.automations host (triggers, watchers, recipes, cron schedules, inbound webhooks).
//!
//! Ported so far: **declared tasks** (ADR-0027), the `tasks:` of a formula. A declared task is a task
//! spec kept as a template in `automations_task`; `automations.task.run` makes a task from it (its
//! `{params}` filled, the spec's fields under the run's), and its schedule fires it once per matching
//! minute (`automations_task_run` keeps the minute it last fired, so a restart in that minute doesn't
//! fire it twice). Recipes are declared tasks with params. Triggers, watchers and webhooks come next.

mod trigger;

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use wisp_automations_api::tasks::{NamedTask, RunTask, TaskDecl, TaskRemove, TaskRun, TaskSet, Tasks, fill};
use wisp_automations_api::{Utc, matches, parse_cron, read_schedule};
use wisp_kernel::{BoxFuture, Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_resources_api::{CrudKind, KindInfo, Op, RESOURCE_KIND, Resource, ResourceKind, schema_of};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};

pub const OWNER: &str = "automations";

const MIGRATIONS: &[Migration] = &[Migration::sql(
    1,
    "CREATE TABLE automations_task (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
     CREATE TABLE automations_task_run (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
)];

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.automations:tasks".into()]
}

const TASK: EntityDef = EntityDef { kind: "automations_task", table: "automations_task", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };
const RUN: EntityDef = EntityDef { kind: "automations_task_run", table: "automations_task_run", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

#[allow(clippy::needless_pass_by_value)] // for map_err
fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::internal(format!("store: {e}"))
}

async fn list(store: &Store) -> Result<Vec<NamedTask>> {
    let rows = store.read_async(|r| r.query(TASK.kind, &Query::new())).await.map_err(store_err)?;
    let mut out: Vec<NamedTask> = rows.into_iter().filter_map(|r| serde_json::from_value(r.get("body")?.clone()).ok()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn checked(mut t: NamedTask) -> Result<NamedTask> {
    if t.name.trim().is_empty() || !t.name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)) {
        return Err(WireError::invalid(format!("a task's name is letters, digits, - _ . (not {:?})", t.name)));
    }
    if t.spec.prompt.trim().is_empty() {
        return Err(WireError::invalid(format!("{} needs a prompt", t.name)));
    }
    t.spec.schedule = read_schedule(&t.spec.schedule).map_err(|e| WireError::invalid(e.0))?;
    Ok(t)
}

async fn put(store: &Store, t: NamedTask) -> Result<NamedTask> {
    let t = checked(t)?;
    let body = serde_json::to_value(&t).map_err(|e| WireError::internal(e.to_string()))?;
    let id = t.name.clone();
    store
        .write(move |w| {
            let mut r = Row::new();
            r.insert("id".into(), json!(id));
            r.insert("body".into(), body);
            w.upsert(TASK.kind, r).map(|_| ())
        })
        .await
        .map_err(store_err)?;
    Ok(t)
}

/// The task a run makes: `runtime.create`'s args from the spec, the run's values and fields over it.
pub fn start_args(t: &NamedTask, run: &RunTask, by: &str) -> Result<Value> {
    let mut values: BTreeMap<String, String> = run.params.clone();
    let names = wisp_automations_api::tasks::params_of(&format!("{} {}", t.spec.prompt, t.spec.steps.join(" ")));
    let mut words = run.words.iter();
    let open: Vec<&String> = names.iter().filter(|p| !values.contains_key(*p)).collect();
    for p in open {
        if let Some(w) = words.next() {
            values.insert(p.clone(), w.clone());
        }
    }
    let prompt = fill(&t.spec.prompt, &values).map_err(WireError::invalid)?;
    let steps: Vec<String> = t.spec.steps.iter().map(|s| fill(s, &values)).collect::<std::result::Result<_, _>>().map_err(WireError::invalid)?;
    let d = &t.spec;
    let opt = |s: &str| (!s.is_empty()).then(|| json!(s));
    let mut a = Map::new();
    a.insert("prompt".into(), json!(prompt));
    a.insert("title".into(), json!(t.name));
    for (k, v) in [("agent", opt(&d.agent)), ("model", opt(&d.model)), ("effort", opt(&d.effort)), ("mode", opt(&d.mode)), ("cwd", opt(&d.project)), ("crew", opt(&d.crew)), ("schedule", opt(&d.schedule))] {
        if let Some(v) = v {
            a.insert(k.into(), v);
        }
    }
    if !steps.is_empty() {
        a.insert("steps".into(), json!(steps));
    }
    if !d.connectors.is_empty() {
        a.insert("connectors".into(), json!(d.connectors));
    }
    if let Some(w) = d.worktree {
        a.insert("worktree".into(), json!(w));
    }
    if let Some(g) = &d.goal {
        a.insert("goal".into(), g.clone());
    }
    a.insert("lineage".into(), json!({ "triggeredBy": by }));
    a.insert("ext".into(), json!({ "wisp.automations": { "task": t.name } }));
    for (k, v) in &run.over {
        let k = if k == "project" { "cwd" } else { k.as_str() };
        a.insert(k.to_owned(), v.clone());
    }
    Ok(Value::Object(a))
}

async fn run(ctx: &Ctx, call: &Call, store: &Store, r: RunTask, by: &str) -> Result<Value> {
    let tasks = list(store).await?;
    let Some(t) = tasks.iter().find(|t| t.name == r.name) else {
        return Err(WireError::not_found(format!("no task named {} (wisp export tasks lists them)", r.name)));
    };
    ctx.run_json(call, "runtime.create", start_args(t, &r, by)?).await
}

/// Runs declared task `name` in `cwd` for `by` (a trigger).
pub async fn run_by(ctx: &Ctx, call: &Call, store: &Store, name: &str, cwd: &str, by: &str) -> Result<Value> {
    let mut over = serde_json::Map::new();
    if !cwd.is_empty() {
        over.insert("project".into(), json!(cwd));
    }
    run(ctx, call, store, RunTask { name: name.to_owned(), over, ..RunTask::default() }, by).await
}

/// Once a minute: every declared task whose schedule matches this minute, once.
async fn tick(ctx: &Ctx, store: &Store, now: i64) {
    let minute = now / 60_000;
    let Ok(tasks) = list(store).await else { return };
    for t in tasks.into_iter().filter(|t| !t.spec.paused && !t.spec.schedule.is_empty()) {
        let Ok(c) = parse_cron(&t.spec.schedule) else { continue };
        if !matches(&c, now, &Utc) {
            continue;
        }
        let id = t.name.clone();
        let fresh = store
            .write(move |w| {
                let last = w.get(RUN.kind, id.as_str())?.and_then(|r| r.get("body").and_then(|b| b.get("minute")).and_then(Value::as_i64));
                if last == Some(minute) {
                    return Ok(false);
                }
                let mut r = Row::new();
                r.insert("id".into(), json!(id));
                r.insert("body".into(), json!({ "minute": minute }));
                w.upsert(RUN.kind, r)?;
                Ok(true)
            })
            .await
            .unwrap_or(false);
        if fresh {
            let call = ctx.root_call();
            let name = t.name.clone();
            if let Err(e) = run(ctx, &call, store, RunTask { name: name.clone(), ..RunTask::default() }, &format!("schedule:{name}")).await {
                tracing::warn!(task = %name, "scheduled run failed: {}", e.message);
            }
        }
    }
}

/// The `task` resource kind: schedules in words are read as the store keeps them (`0 2 * * *`).
struct TaskKind(CrudKind);

impl ResourceKind for TaskKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn normalize(&self, spec: &mut Value) {
        if let Some(c) = spec.get("schedule").and_then(Value::as_str).and_then(|s| read_schedule(s).ok()) {
            spec["schedule"] = Value::String(c);
        }
    }
    fn check(&self, r: &Resource) -> Vec<String> {
        r.spec.get("schedule").and_then(Value::as_str).and_then(|s| read_schedule(s).err()).map(|e| vec![e.0]).unwrap_or_default()
    }
    fn describe(&self, op: &Op) -> Option<String> {
        let when = op.spec.get("schedule").and_then(Value::as_str).filter(|s| !s.is_empty()).map_or_else(|| "when it's run".to_owned(), |s| format!("by itself on schedule {s}"));
        let verb = match op.op {
            wisp_resources_api::OpKind::Create => "adds",
            wisp_resources_api::OpKind::Update => "changes",
            wisp_resources_api::OpKind::Delete => "removes",
        };
        Some(format!("{verb} the task {} that runs an agent {when}", op.name))
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        self.0.apply(call, op)
    }
}

#[derive(Debug, Default)]
pub struct AutomationsPlugin;

impl Plugin for AutomationsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::trigger::register(s);
        // a scheduled task acts without you: a foreign formula's needs --trust (ADR-0028)
        let info = KindInfo::new("task", "tasks", wisp_automations_api::PLUGIN_ID, schema_of::<TaskDecl>()).order(80).sensitive().alias("recipes");
        let kind: Arc<dyn ResourceKind> = Arc::new(TaskKind(CrudKind::new::<TaskDecl>(info, s.ctx(), "automations.tasks", "automations.task.set", "automations.task.set", "automations.task.remove").keyed("name", "name", "name")));
        s.contribute(&RESOURCE_KIND, kind);
        s.command::<Tasks, _, _>(|ctx, _, _| async move { list(&*ctx.service::<Store>()?).await });
        s.command::<TaskSet, _, _>(|ctx, _, t| async move { put(&*ctx.service::<Store>()?, t).await });
        s.command::<TaskRemove, _, _>(|ctx, _, a| async move {
            let store = ctx.service::<Store>()?;
            store.write(move |w| w.del(TASK.kind, a.name.as_str()).map(|_| ())).await.map_err(store_err)?;
            Ok(json!({ "ok": true }))
        });
        s.command::<TaskRun, _, _>(|ctx, call, r| async move {
            let store = ctx.service::<Store>()?;
            run(&ctx, &call, &store, r, "hand").await
        });
        s.on_start(|ctx| async move {
            let store = ctx.service::<Store>()?;
            store.migrate(OWNER, MIGRATIONS).map_err(store_err)?;
            for d in [TASK, RUN] {
                store.define_entity(d).map_err(store_err)?;
            }
            let clock = ctx.clock()?;
            let c2 = ctx.clone();
            ctx.spawn(async move {
                loop {
                    let now = clock.now_ms();
                    // the start of the next minute
                    clock.sleep(u64::try_from(60_000 - now.rem_euclid(60_000)).unwrap_or(60_000)).await;
                    tick(&c2, &store, clock.now_ms()).await;
                }
            });
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(AutomationsPlugin.manifest().id, "wisp.automations");
    }

    #[test]
    fn a_run_fills_params_and_takes_the_runs_fields_over_the_spec() {
        let t = NamedTask { name: "fix-issue".into(), spec: TaskDecl { prompt: "fix issue {n}".into(), steps: vec!["test {n}".into()], project: "/w".into(), agent: "reviewer".into(), ..TaskDecl::default() } };
        let r = RunTask { name: "fix-issue".into(), words: vec!["42".into()], over: [("agent".to_owned(), json!("codex"))].into_iter().collect(), ..RunTask::default() };
        let a = start_args(&t, &r, "hand").unwrap();
        assert_eq!((a["prompt"].as_str(), a["steps"][0].as_str(), a["cwd"].as_str(), a["agent"].as_str()), (Some("fix issue 42"), Some("test 42"), Some("/w"), Some("codex")));
        assert_eq!(a["lineage"]["triggeredBy"], "hand");
        assert!(start_args(&t, &RunTask::default(), "hand").is_err(), "a missing param says which");
    }
}
