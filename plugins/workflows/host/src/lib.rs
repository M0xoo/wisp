//! wisp.workflows host (ADR-0028): the `workflow` resource kind (`workflows:` in a formula, kept in
//! `workflows_def`) and the runner.
//!
//! A run is a parent task (made held: it never runs an agent itself) whose children are its steps. The
//! runner asks wisp-workflows-core what starts next, makes each child with `runtime.create` (its spec,
//! `parentId` and `lineage.workflowRun` set), and wakes on `turn.ended` to read how each ended: done
//! with its output (from its answer), or failed (tried again while it has retries). Each step's state is
//! kept on the parent (`ext["wisp.workflows"]`), and the parent ends in review, or error when a step
//! that had to succeed didn't.
//!
//! Not yet: `on:` another machine (steps run here, and the run says so), and picking up a run wisp was
//! stopped in the middle of.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::broadcast;
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_resources_api::{CrudKind, KindInfo, RESOURCE_KIND, Resource, ResourceKind, schema_of};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::spec::Lineage;
use wisp_runtime_api::{Mode, SessionId, SessionState, Turn, TurnStatus};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};
use wisp_workflows_api::{EXT, List, NamedWorkflow, Remove, Run as RunCmd, RunArgs, Set, Started, WorkflowSpec};
use wisp_workflows_core::{Action, Run, check, output_of};

pub use wisp_workflows_api::PLUGIN_ID;

const OWNER: &str = "workflows";
const MIGRATIONS: &[Migration] = &[Migration::sql(1, "CREATE TABLE workflows_def (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")];

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.workflows:workflows".into()]
}

const DEF: EntityDef = EntityDef {
    kind: "workflows_def",
    table: "workflows_def",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics,
};

/// How often a run looks at its steps when nothing woke it (timeouts).
const LOOK_MS: u64 = 2_000;

#[allow(clippy::needless_pass_by_value)] // for map_err
fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::internal(format!("store: {e}"))
}

async fn list(store: &Store) -> Result<Vec<NamedWorkflow>> {
    let rows = store.read_async(|r| r.query(DEF.kind, &Query::new())).await.map_err(store_err)?;
    let mut out: Vec<NamedWorkflow> = rows.into_iter().filter_map(|r| serde_json::from_value(r.get("body")?.clone()).ok()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

async fn put(store: &Store, w: NamedWorkflow) -> Result<NamedWorkflow> {
    if w.name.trim().is_empty() || !w.name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)) {
        return Err(WireError::invalid(format!("a workflow's name is letters, digits, - _ . (not {:?})", w.name)));
    }
    let problems = check(&w.spec);
    if !problems.is_empty() {
        return Err(WireError::invalid(format!("{}: {}", w.name, problems.join("; "))));
    }
    let body = serde_json::to_value(&w).map_err(|e| WireError::internal(e.to_string()))?;
    let id = w.name.clone();
    store
        .write(move |wr| {
            let mut r = Row::new();
            r.insert("id".into(), json!(id));
            r.insert("body".into(), body);
            wr.upsert(DEF.kind, r).map(|_| ())
        })
        .await
        .map_err(store_err)?;
    Ok(w)
}

/// `(task, cost)` of every turn that ended, for the runs to wake on.
type Ended = broadcast::Sender<(String, f64)>;

struct State {
    ended: Ended,
}

/// A node's `mode:` as runtime names it (`plan`, `edits`, `auto`); a wrong one fails the step, as runtime's own
/// check of the args did.
fn mode_of(m: &str) -> std::result::Result<Option<Mode>, String> {
    if m.is_empty() {
        return Ok(None);
    }
    serde_json::from_value(json!(m)).map(Some).map_err(|_| format!("{m:?} isn't a mode (plan, edits or auto)"))
}

fn some(v: &str) -> Option<String> {
    (!v.is_empty()).then(|| v.to_owned())
}

/// The child task's args for a node (Err: why it can't start).
fn child_args(
    run: &Run,
    name: &str,
    parent: &str,
    project: &str,
    node: &str,
    prompt: String,
    steps: Vec<String>,
) -> std::result::Result<r::StartArgs, String> {
    let n = run.nodes.iter().find(|n| n.id == node).map(|n| n.spec.clone()).unwrap_or_default();
    let cwd = if n.project.is_empty() { project } else { n.project.as_str() };
    Ok(r::StartArgs {
        prompt,
        title: Some(format!("{name} · {node}")),
        parent_id: Some(SessionId(parent.to_owned())),
        lineage: Lineage { workflow_run: Some(parent.to_owned()), ..Lineage::default() },
        ext: [(EXT.to_owned(), json!({ "run": parent, "node": node }))].into(),
        agent: some(&n.agent),
        model: some(&n.model),
        effort: some(&n.effort),
        mode: mode_of(&n.mode)?,
        cwd: some(cwd),
        steps,
        goal: n.goal.clone(),
        worktree: n.worktree,
        ..r::StartArgs::default()
    })
}

/// A wire name (`running`, `done`, …) of a runtime enum.
fn wire_name<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

async fn report(ctx: &Ctx, call: &Call, parent: &str, name: &str, run: &Run, state: &str, notes: &[String]) {
    let value = json!({ "workflow": name, "state": state, "cost": run.cost(), "steps": run.report(), "notes": notes });
    // set-ext: whole one writer: the run's task is made by `start` and only its own `drive` loop writes this slot
    let a = r::SetExtArgs { id: SessionId(parent.to_owned()), plugin: EXT.into(), value, expect: None };
    if let Err(err) = ctx.run::<r::SetExt>(call, a).await {
        tracing::warn!(error = %err.message, task = parent, "workflows: runtime.setExt");
    }
}

async fn set_state(ctx: &Ctx, call: &Call, id: &str, state: SessionState) {
    if let Err(err) = ctx.run::<r::SetState>(call, r::SetStateArgs { id: SessionId(id.to_owned()), state }).await {
        tracing::warn!(error = %err.message, task = id, "workflows: runtime.setState");
    }
}

/// How the node's task stands: None while it runs (or waits on you), or when it can't be read; else (ok, its
/// output, why).
async fn ended(ctx: &Ctx, call: &Call, task: &str) -> Option<(bool, Value, String)> {
    let id = SessionId(task.to_owned());
    let t = ctx.run::<r::Get>(call, r::IdArgs { id: id.clone() }).await.ok()?;
    let busy = matches!(t.state, SessionState::Running | SessionState::Waiting) || !t.queue.is_empty() && !t.queue_held;
    if busy {
        return None;
    }
    let turns = ctx.run::<r::Turns>(call, r::TurnsArgs { id, before: None, limit: None, masked: None }).await.ok()?;
    Some(outcome(t.state, turns.last()))
}

/// How a step ended, from its task's state and its last turn: done with no error is ok.
fn outcome(state: SessionState, last: Option<&Turn>) -> (bool, Value, String) {
    let ok = last.is_some_and(|l| l.status == TurnStatus::Done && !l.is_error);
    let why = if ok { String::new() } else { format!("it ended {}", last.map_or_else(|| wire_name(state), |l| wire_name(l.status))) };
    let output = last.and_then(|l| serde_json::to_value(l).ok()).map_or(Value::Null, |l| output_of(&l));
    (ok, output, why)
}

/// Runs `w` under the parent task until every step has ended.
#[allow(clippy::too_many_arguments)]
async fn drive(
    ctx: Ctx,
    mut wake: broadcast::Receiver<(String, f64)>,
    parent: String,
    name: String,
    project: String,
    spec: WorkflowSpec,
    inputs: BTreeMap<String, Value>,
) {
    let call = ctx.root_call();
    let Ok(clock) = ctx.clock() else { return };
    let mut run = Run::new(spec, &inputs);
    let mut notes: Vec<String> = Vec::new();
    for n in &run.nodes {
        if !n.spec.on.is_empty() && !notes.iter().any(|x| x.contains(&n.step)) {
            notes.push(format!("{} runs on this computer: steps on another machine ({}) aren't wired yet", n.step, n.spec.on));
        }
    }
    let mut costs: BTreeMap<String, f64> = BTreeMap::new();
    loop {
        for a in run.next(clock.now_ms()) {
            match a {
                Action::Start { node, prompt, steps } => match child_args(&run, &name, &parent, &project, &node, prompt, steps) {
                    Ok(args) => match ctx.run::<r::Create>(&call, args).await {
                        Ok(made) => run.started(&node, &made.id.0),
                        Err(e) => run.finished(&node, false, Value::Null, &e.message, 0.0),
                    },
                    Err(why) => run.finished(&node, false, Value::Null, &why, 0.0),
                },
                Action::Stop { node, task } => {
                    if let Err(err) = ctx.run::<r::Stop>(&call, r::StopArgs { id: SessionId(task.clone()), clear_queue: false }).await {
                        tracing::warn!(error = %err.message, task, "workflows: runtime.stop");
                    }
                    run.finished(&node, false, Value::Null, "it ran past its timeout", costs.remove(&task).unwrap_or(0.0));
                }
            }
        }
        report(&ctx, &call, &parent, &name, &run, "running", &notes).await;
        if run.over() {
            break;
        }
        // a turn ended somewhere, or it's time to look at the timeouts
        tokio::select! {
            got = wake.recv() => {
                if let Ok((task, cost)) = got {
                    *costs.entry(task).or_default() += cost;
                }
            }
            () = clock.sleep(LOOK_MS) => {}
        }
        let running: Vec<(String, String)> = run
            .runs
            .iter()
            .filter_map(|(id, r)| {
                (r.state == wisp_workflows_api::StepState::Running).then(|| r.task.clone().map(|t| (id.clone(), t))).flatten()
            })
            .collect();
        for (node, task) in running {
            if let Some((ok, output, why)) = ended(&ctx, &call, &task).await {
                run.finished(&node, ok, output, &why, costs.remove(&task).unwrap_or(0.0));
            }
        }
    }
    let state = if run.ok() { SessionState::Review } else { SessionState::Error };
    report(&ctx, &call, &parent, &name, &run, if run.ok() { "done" } else { "failed" }, &notes).await;
    set_state(&ctx, &call, &parent, state).await;
}

async fn start(ctx: &Ctx, call: &Call, st: &State, a: RunArgs) -> Result<Started> {
    let store = ctx.service::<Store>()?;
    let all = list(&store).await?;
    let Some(w) = all.into_iter().find(|w| w.name == a.name) else {
        return Err(WireError::not_found(format!("no workflow named {} (wisp export workflows lists them)", a.name)));
    };
    let missing: Vec<&String> = w.spec.inputs.iter().filter(|(k, v)| v.is_null() && !a.inputs.contains_key(*k)).map(|(k, _)| k).collect();
    if !missing.is_empty() {
        return Err(WireError::invalid(format!(
            "{} needs {}",
            w.name,
            missing.iter().map(|m| format!("{m}=…")).collect::<Vec<_>>().join(" ")
        )));
    }
    let project = a.project.clone().unwrap_or_else(|| w.spec.project.clone());
    let steps: Vec<String> = w.spec.tasks.keys().cloned().collect();
    let made = r::StartArgs {
        prompt: format!("Run the workflow {}: {}", w.name, steps.join(", ")),
        title: Some(format!("{} (workflow)", w.name)),
        hold: true,
        cwd: some(&project),
        ext: [(EXT.to_owned(), json!({ "workflow": w.name, "state": "starting" }))].into(),
        ..r::StartArgs::default()
    };
    let id = ctx.run::<r::Create>(call, made).await?.id.0;
    set_state(ctx, call, &id, SessionState::Running).await;
    ctx.spawn(drive(ctx.clone(), st.ended.subscribe(), id.clone(), w.name, project, w.spec, a.inputs));
    Ok(Started { id })
}

/// The `workflow` resource kind; a definition is checked when it's applied.
struct WorkflowKind(CrudKind);

impl ResourceKind for WorkflowKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> wisp_kernel::BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn check(&self, r: &Resource) -> Vec<String> {
        match serde_json::from_value::<WorkflowSpec>(r.spec.clone()) {
            Ok(w) => check(&w),
            Err(e) => vec![e.to_string()],
        }
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a wisp_resources_api::Op) -> wisp_kernel::BoxFuture<'a, Result<()>> {
        self.0.apply(call, op)
    }
}

#[derive(Debug, Default)]
pub struct WorkflowsPlugin;

impl Plugin for WorkflowsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let info = KindInfo::new("workflow", "workflows", PLUGIN_ID, schema_of::<WorkflowSpec>()).order(90);
        let kind: Arc<dyn ResourceKind> = Arc::new(WorkflowKind(
            CrudKind::new::<WorkflowSpec>(info, s.ctx(), "workflows.list", "workflows.set", "workflows.set", "workflows.remove")
                .keyed("name", "name", "name"),
        ));
        s.contribute(&RESOURCE_KIND, kind);
        let st = Arc::new(State { ended: broadcast::channel(256).0 });
        s.command::<List, _, _>(|ctx, _, _| async move { list(&*ctx.service::<Store>()?).await });
        s.command::<Set, _, _>(|ctx, _, w| async move { put(&*ctx.service::<Store>()?, w).await });
        s.command::<Remove, _, _>(|ctx, _, a| async move {
            let store = ctx.service::<Store>()?;
            store.write(move |w| w.del(DEF.kind, a.name.as_str()).map(|_| ())).await.map_err(store_err)?;
            Ok(json!({ "ok": true }))
        });
        let st2 = st.clone();
        s.command::<RunCmd, _, _>(move |ctx, call, a| {
            let st = st2.clone();
            async move { start(&ctx, &call, &st, a).await }
        });
        let st3 = st;
        s.on::<TurnEnded, _, _>(move |_ctx, e| {
            // no run listening (none going) is fine: nothing waits on this turn
            let _ = st3.ended.send((e.session_id.as_str().to_owned(), e.cost_usd.unwrap_or(0.0)));
            async move {}
        });
        s.on_start(|ctx| async move {
            let store = ctx.service::<Store>()?;
            store.migrate(OWNER, MIGRATIONS).map_err(store_err)?;
            store.define_entity(DEF).map_err(store_err)?;
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(WorkflowsPlugin.manifest().id, PLUGIN_ID);
    }

    #[test]
    fn a_wrong_mode_fails_the_step_and_an_empty_one_is_left_out() {
        assert_eq!(mode_of(""), Ok(None));
        assert_eq!(mode_of("plan"), Ok(Some(Mode::Plan)));
        assert!(mode_of("yolo").is_err_and(|e| e.contains("yolo")));
    }

    fn turn(status: TurnStatus, is_error: bool) -> Turn {
        serde_json::from_value(json!({
            "id": "t1", "sessionId": "s1", "idx": 0, "prompt": "p", "agent": "claude", "model": "", "effort": "",
            "mode": "auto", "status": status, "startedAt": 0, "endedAt": null, "stats": null, "presentation": null,
            "isError": is_error,
        }))
        .unwrap_or_else(|e| panic!("turn: {e}"))
    }

    #[test]
    fn a_step_is_ok_only_when_its_last_turn_is_done_without_an_error() {
        assert!(outcome(SessionState::Review, Some(&turn(TurnStatus::Done, false))).0);
        let (ok, _, why) = outcome(SessionState::Review, Some(&turn(TurnStatus::Done, true)));
        assert!(!ok);
        assert_eq!(why, "it ended done");
        assert_eq!(outcome(SessionState::Error, Some(&turn(TurnStatus::Stopped, false))).2, "it ended stopped");
        // no turn at all: the task's own state says how it ended
        assert_eq!(outcome(SessionState::Error, None), (false, Value::Null, "it ended error".to_owned()));
    }
}
