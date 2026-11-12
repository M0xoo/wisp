//! `impl Plugin`: wisp.runtime's commands, its v1 routes and its start (migrations, the list cache, turns
//! a crash left running). The runtime itself is built in `on_start`, once the store and proc services are
//! there; a command that arrives before answers `unavailable` (retry).

use std::sync::{Arc, OnceLock};

use wisp_kernel::{BoxFuture, Ctx, Manifest, Plugin, Result as WireResult, Setup, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::commands as c;
use wisp_runtime_api::hooks::{BeforeCreate, BeforeFollowUp, BeforeRun, BeforeRunCtx};
use wisp_runtime_api::points::{AFTER, BLOCK, OUTCOME, PROMPT, RUN, SUMMARY};
use wisp_runtime_api::{HARNESS, Harness};
use wisp_store::Store;

use crate::host::{Emitted, Host};
use crate::repo::Repo;
use crate::runtime::Runtime;

/// The plugin.
#[derive(Debug, Default)]
pub struct RuntimePlugin;

pub(crate) type Slot = Arc<OnceLock<Arc<Runtime>>>;

pub(crate) fn rt(slot: &Slot) -> WireResult<Arc<Runtime>> {
    slot.get()
        .cloned()
        .ok_or_else(|| WireError::unavailable("wisp.runtime is starting"))
}

/// The kernel side of the host seam.
struct CtxHost {
    ctx: Ctx,
}

impl Host for CtxHost {
    fn setting(&self, key: &str) -> Option<serde_json::Value> {
        self.ctx.setting(key)
    }
    fn net(&self) -> Option<wisp_kernel::services::NetService> {
        wisp_kernel::services::net(&self.ctx).ok()
    }
    fn command(&self, cmd: &str, args: serde_json::Value) -> wisp_kernel::BoxFuture<'static, std::result::Result<serde_json::Value, WireError>> {
        self.ctx.run_json(&self.ctx.root_call(), cmd, args)
    }
    fn emit(&self, e: Emitted) {
        let call = self.ctx.root_call();
        match e {
            Emitted::Created(x) => self.ctx.emit(&call, &x),
            Emitted::Changed(x) => self.ctx.emit(&call, &x),
            Emitted::Deleted(x) => self.ctx.emit(&call, &x),
            Emitted::Started(x) => self.ctx.emit(&call, &x),
            Emitted::Activity(x) => self.ctx.emit(&call, &x),
            Emitted::Finished(x) => self.ctx.emit(&call, &x),
            Emitted::Ended(x) => self.ctx.emit(&call, &x),
            Emitted::Held(x) => self.ctx.emit(&call, &x),
            Emitted::Limits(x) => self.ctx.emit(&call, &x),
            Emitted::Task(ty, f) => {
                use wisp_runtime_api::events::{TaskAsked, TaskDone, TaskFailed, TaskFinished, TaskHeld};
                match ty {
                    "task.finished" => self.ctx.emit(&call, &TaskFinished(f)),
                    "task.failed" => self.ctx.emit(&call, &TaskFailed(f)),
                    "task.held" => self.ctx.emit(&call, &TaskHeld(f)),
                    "task.asked" => self.ctx.emit(&call, &TaskAsked(f)),
                    _ => self.ctx.emit(&call, &TaskDone(f)),
                }
            }
        }
    }
    fn before_run(&self, c: BeforeRunCtx) -> BoxFuture<'static, WireResult<BeforeRunCtx>> {
        self.ctx.run_hook::<BeforeRun>(&self.ctx.root_call(), c)
    }
    fn harnesses(&self) -> Vec<Arc<dyn Harness>> {
        self.ctx.contributions(&HARNESS)
    }
    fn spawn(&self, fut: BoxFuture<'static, ()>) {
        self.ctx.spawn(fut);
    }
    fn agent_access(&self) -> Option<Arc<dyn wisp_runtime_api::points::AgentAccess>> {
        self.ctx.service::<Arc<dyn wisp_runtime_api::points::AgentAccess>>().ok().map(|a| a.as_ref().clone())
    }
    fn summary_fields(&self) -> Vec<Arc<dyn wisp_runtime_api::points::SummaryField>> {
        self.ctx.contributions(&SUMMARY)
    }
    fn after_steps(&self) -> Vec<Arc<dyn wisp_runtime_api::points::AfterTurn>> {
        self.ctx.contributions(&AFTER)
    }
    fn blocks(&self) -> Vec<Arc<dyn wisp_runtime_api::points::BlockType>> {
        self.ctx.contributions(&BLOCK)
    }
    fn prompt_parts(&self) -> Vec<Arc<dyn wisp_runtime_api::points::PromptPart>> {
        self.ctx.contributions(&PROMPT)
    }
    fn run_parts(&self) -> Vec<Arc<dyn wisp_runtime_api::points::RunPart>> {
        self.ctx.contributions(&RUN)
    }
    fn outcomes(&self) -> Vec<Arc<dyn wisp_runtime_api::points::TurnOutcome>> {
        self.ctx.contributions(&OUTCOME)
    }
    fn router(&self) -> Option<(Arc<dyn wisp_router_api::service::RouterApi>, wisp_kernel::Call)> {
        self.ctx.use_service::<wisp_router_api::service::RouterService>().ok().map(|r| (r, self.ctx.root_call()))
    }
}

/// The task tree as the kernel's scope reads it: a delegation's parent chain.
struct Tree(Slot);

impl wisp_kernel::scope::TaskTree for Tree {
    fn within(&self, task: &str, root: &str) -> BoxFuture<'static, bool> {
        let (slot, task, root) = (self.0.clone(), task.to_owned(), root.to_owned());
        Box::pin(async move {
            match rt(&slot) {
                Ok(r) => r.under(&task, &root).await,
                Err(_) => false,
            }
        })
    }
}

/// Registers command `$cmd` with a handler over the started runtime.
macro_rules! cmd {
    ($s:expr, $slot:expr, $cmd:ty, |$rt:ident, $call:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$cmd, _, _>(move |_ctx, $call, $a| {
            let slot = slot.clone();
            async move {
                let $rt = rt(&slot)?;
                let _ = &$call;
                let out: crate::error::Result<_> = $body;
                out.map_err(WireError::from)
            }
        });
    }};
}

/// A catalogue event for the fact this plugin owns (ADR-0021); never fails the command that caused it.
async fn track(ctx: &wisp_kernel::Ctx, event: &str, props: serde_json::Value) {
    let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", serde_json::json!({ "event": event, "props": props })).await;
}

/// How often the retention sweep looks.
const SWEEP_MS: u64 = 6 * 60 * 60 * 1000;

/// `runtime.retentionDays` (ADR-0029): a finished task untouched for that long is archived (never
/// deleted: history is data). 0 keeps everything in the list.
fn retention(ctx: &wisp_kernel::Ctx, slot: &Slot) {
    let (ctx2, slot) = (ctx.clone(), slot.clone());
    ctx.spawn(async move {
        let Ok(clock) = ctx2.clock() else { return };
        loop {
            clock.sleep(60_000).await;
            let days = ctx2.setting("runtime.retentionDays").and_then(|v| v.as_i64()).unwrap_or(0);
            if days > 0
                && let Ok(rt) = rt(&slot)
                && let Ok(list) = rt.repo.summaries().await
            {
                let before = clock.now_ms() - days * 86_400_000;
                let call = ctx2.root_call();
                for s in list.iter().filter(|s| !s.archived && s.updated_at < before && !matches!(s.state, wisp_runtime_api::model::SessionState::Running | wisp_runtime_api::model::SessionState::Waiting)) {
                    let _ = ctx2.run_json(&call, "runtime.archive", serde_json::json!({ "id": s.id, "archived": true })).await;
                }
            }
            clock.sleep(SWEEP_MS).await;
        }
    });
}

/// Profiles, specs and snapshots (ADR-0027, ADR-0029), and the `agent` resource kind.
fn specs(s: &mut Setup, slot: &Slot) {
    use wisp_resources_api::{CrudKind, KindInfo, RESOURCE_KIND, ResourceKind, schema_of};
    use wisp_runtime_api::spec::AgentSpec;
    let info = KindInfo::new("agent", "agents", "wisp.runtime", schema_of::<AgentSpec>()).order(20);
    let kind: Arc<dyn ResourceKind> = Arc::new(CrudKind::new::<AgentSpec>(info, s.ctx(), "runtime.profiles", "runtime.profile.set", "runtime.profile.set", "runtime.profile.remove").keyed("name", "name", "name").renames("runtime.profile.rename"));
    s.contribute(&RESOURCE_KIND, kind);
    s.command::<c::Profiles, _, _>(|ctx, _, _| async move { crate::specs::profiles(&*ctx.service::<Store>()?).await });
    s.command::<c::ProfileSet, _, _>(|ctx, _, p| async move { crate::specs::set_profile(&*ctx.service::<Store>()?, p).await });
    s.command::<c::ProfileRename, _, _>(|ctx, _, a| async move { crate::specs::rename_profile(&*ctx.service::<Store>()?, &a.from, &a.to).await });
    s.command::<c::ProfileRemove, _, _>(|ctx, _, a| async move {
        crate::specs::remove_profile(&*ctx.service::<Store>()?, &a.name).await?;
        Ok(c::Ack {})
    });
    let sp = slot.clone();
    s.command::<c::SpecOf, _, _>(move |_, _, a| {
        let slot = sp.clone();
        async move {
            let rt = rt(&slot)?;
            let s = rt.repo.session(a.id.as_str()).await.map_err(WireError::from)?;
            let turns = rt.repo.turns(a.id.as_str(), None, None).await.map_err(WireError::from)?;
            Ok(crate::specs::spec_of(&s, &turns))
        }
    });
    let hi = slot.clone();
    s.command::<c::History, _, _>(move |ctx, _, a| {
        let slot = hi.clone();
        async move {
            let rt = rt(&slot)?;
            let store = ctx.service::<Store>()?;
            let sessions = rt.repo.sessions().await.map_err(WireError::from)?;
            let costs: std::collections::HashMap<String, f64> = rt.repo.summaries().await.map_err(WireError::from)?.into_iter().filter_map(|s| s.cost_usd.map(|c| (s.id.as_str().to_owned(), c))).collect();
            // the snapshots the profile filter needs, read once each
            let mut snaps: std::collections::HashMap<String, Option<serde_json::Value>> = std::collections::HashMap::new();
            if !a.profiles.is_empty() {
                for s in &sessions {
                    if let Some(h) = crate::specs::spec_of(s, &[]).formula
                        && !snaps.contains_key(&h)
                    {
                        let f = crate::specs::snapshot(&store, &h).await.ok().map(|x| x.formula);
                        snaps.insert(h, f);
                    }
                }
            }
            Ok(crate::specs::history(&sessions, &costs, &a, &mut |h: &str| snaps.get(h).cloned().flatten()))
        }
    });
    let sn = slot.clone();
    s.command::<c::SnapshotOf, _, _>(move |ctx, _, a| {
        let slot = sn.clone();
        async move {
            let store = ctx.service::<Store>()?;
            // a task's id: its spec names the hash
            let hash = match rt(&slot)?.repo.session(&a.of).await {
                Ok(s) => crate::specs::spec_of(&s, &[]).formula.ok_or_else(|| WireError::not_found(format!("task {} ran before snapshots were kept", a.of)))?,
                Err(_) => a.of.clone(),
            };
            crate::specs::snapshot(&store, &hash).await
        }
    });
}

fn commands(s: &mut Setup, slot: &Slot) {
    let ctx = s.ctx();
    let (c1, c2) = (ctx.clone(), ctx);
    let start = slot.clone();
    let made_kinds = crate::kinds::register(s);
    let harness_kind = made_kinds.harness.clone();
    let project_kind = made_kinds.project.clone();
    let issue_projects: Arc<dyn wisp_issues_api::Projects> = Arc::new(crate::kinds::IssueProjects(project_kind.clone()));
    s.contribute(&wisp_issues_api::PROJECTS, issue_projects);
    let brief: Arc<dyn wisp_runtime_api::points::PromptPart> = Arc::new(crate::kinds::Brief);
    s.contribute(&wisp_runtime_api::points::PROMPT, brief);
    s.command::<c::Create, _, _>(move |_ctx, call, a| {
        let (slot, ctx, kinds) = (start.clone(), c1.clone(), made_kinds.clone());
        async move {
            let mut a = ctx.run_hook::<BeforeCreate>(&call, a).await?;
            if let Some(rest) = crate::term::slash(&a.prompt) {
                a.prompt = rest;
                a.terminal = true;
            }
            let (store, proc) = (ctx.service::<Store>()?, ctx.service::<Proc>()?);
            let home = wisp_kernel::services::paths(&ctx).ok().map(|p| p.home().to_owned());
            // a worktree of its own: made before the first turn, the project's setup run in it
            let p = crate::specs::prepare(&store, &proc, home.as_deref(), Some(&kinds), a).await?;
            let rt = rt(&slot)?;
            let mut args = p.args;
            let on = ctx.setting("terminal.terminalSessions").is_some_and(|v| v == true || v == "on");
            args.terminal = crate::term::starts_in_terminal(&args, on) && rt.harness(args.agent.as_deref().unwrap_or("claude")).is_ok_and(|h| h.resume_command(&wisp_runtime_api::harness::ResumeOptions::default()).is_some());
            let terminal = args.terminal;
            let wants_tree = args.worktree == Some(true) && !args.hold && args.cwd.as_deref().is_some_and(|c| !c.is_empty());
            let setup = if wants_tree { crate::specs::project_setup(Some(&kinds), &args).await } else { Vec::new() };
            args.hold |= wants_tree;
            let (cwd, title, mode) = (args.cwd.clone().unwrap_or_default(), args.title.clone().unwrap_or_default(), args.mode);
            let made = rt.create(args).await.map_err(WireError::from)?;
            let made = if wants_tree {
                let mode = mode.map(|m| serde_json::to_value(m).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()).unwrap_or_default();
                let wt = ctx.run_json(&call, "worktrees.create", serde_json::json!({ "sessionId": made.id.as_str(), "cwd": cwd, "title": title, "mode": mode })).await.ok().filter(serde_json::Value::is_object);
                let failed = match wt.as_ref().and_then(|w| w.get("path")).and_then(serde_json::Value::as_str) {
                    Some(dir) if !setup.is_empty() => crate::specs::run_setup(&proc, dir, &setup).await,
                    _ => None,
                };
                let turn_id = rt.worktree_ready(made.id.as_str(), wt, failed).await.map_err(WireError::from)?;
                c::Created { id: made.id, turn_id }
            } else {
                made
            };
            if terminal {
                crate::term::open(&ctx, &call, &rt, made.id.as_str(), None, (None, None)).await?;
            }
            // the steps after the first go in the queue, in order: each starts when the turn before ends
            for text in p.steps {
                let f = c::FollowUpArgs { id: made.id.clone(), text, queue: Some(true), by: Some("step".into()), ..c::FollowUpArgs::default() };
                rt.follow_up(f).await.map_err(WireError::from)?;
            }
            Ok(made)
        }
    });
    let follow = slot.clone();
    s.command::<c::FollowUp, _, _>(move |_ctx, call, a| {
        let (slot, ctx) = (follow.clone(), c2.clone());
        async move {
            let a = ctx.run_hook::<BeforeFollowUp>(&call, a).await?;
            let rt = rt(&slot)?;
            if rt.repo.session(a.id.as_str()).await.is_ok_and(|s| crate::term::term_of(&s).is_some()) {
                return crate::term::follow_up(&ctx, &call, &rt, a.id.as_str(), &a.text).await;
            }
            rt.follow_up(a).await.map_err(WireError::from)
        }
    });
    specs(s, slot);
    edits(s, slot);
    reads(s, slot);
    for_agents(s, slot);
    more(s, slot, harness_kind, project_kind);
    crate::term::setup(s, slot);
}

/// What agents read of the user's tasks (`wisp_sessions`, `wisp_session`), with their usage events.
fn for_agents(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::AgentSessions, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let capped = call.caller().set.starts_with("agent:capped");
            let out = r.agent_sessions(&a, capped).await.map_err(WireError::from)?;
            let agent = r.get(&a.session).await.map(|x| x.agent).unwrap_or_default();
            let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", serde_json::json!({ "event": "wisp_sessions", "props": { "agent": agent } })).await;
            Ok(out)
        }
    });
    let sl = slot.clone();
    s.command::<c::AgentSession, _, _>(move |ctx, call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let capped = call.caller().set.starts_with("agent:capped");
            let out = r.agent_session(&a, capped).await.map_err(WireError::from)?;
            let agent = r.get(&a.session).await.map(|x| x.agent).unwrap_or_default();
            let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", serde_json::json!({ "event": "wisp_session", "props": { "agent": agent } })).await;
            Ok(out)
        }
    });
}

/// `runtime.fork`, counted as `fork_task`.
fn fork(s: &mut Setup, slot: &Slot) {
    let sl = slot.clone();
    s.command::<c::Fork, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let (id, latest) = (a.id.clone(), a.turn_id.is_none());
            let out = r.fork(a).await.map_err(WireError::from)?;
            let agent = r.get(id.as_str()).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "fork_task", serde_json::json!({ "agent": agent, "switched": false, "latest": latest })).await;
            Ok(out)
        }
    });
}

/// asks, approvals, /btw, compact, rerun, fork, subagents, quick, sign-in, overage, agents (more.rs)
fn more(s: &mut Setup, slot: &Slot, harness_kind: Arc<wisp_resources_api::StoredKind>, kinds_for_run: Arc<wisp_resources_api::StoredKind>) {
    cmd!(s, slot, c::Ask, |r, call, a| r.ask(a).await.map(|ask_id| c::Asked { ask_id }));
    cmd!(s, slot, c::Answer, |r, call, a| r.answer(&a.id, &a.text).await);
    cmd!(s, slot, c::PollAnswerOf, |r, call, a| Ok(r.poll_answer(&a.ask_id)));
    cmd!(s, slot, c::Approval, |r, call, a| r.approval(a).await);
    cmd!(s, slot, c::ApproveBlocked, |r, call, a| r.approve_blocked(&a.id, a.turn_id.as_ref(), a.allow).await);
    cmd!(s, slot, c::Btw, |r, call, a| r.btw(a).await);
    cmd!(s, slot, c::BtwDrop, |r, call, a| r.btw_drop(a.id.as_str(), &a.btw_id).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Compact, |r, call, a| r.compact(&a.id).await);
    cmd!(s, slot, c::Rerun, |r, call, a| r.rerun(a).await);
    fork(s, slot);
    cmd!(s, slot, c::Adopt, |r, call, a| r.adopt(a).await);
    cmd!(s, slot, c::Delegate, |r, call, a| r.delegate(a).await);
    cmd!(s, slot, c::Results, |r, call, a| r.results(a).await);
    cmd!(s, slot, c::Quick, |r, call, a| r.quick(a).await);
    cmd!(s, slot, c::SignIn, |r, call, a| r.sign_in(a.id.as_str(), &a.turn_id).await.map(|_| c::Ack {}));
    cmd!(s, slot, c::SignInDone, |r, call, a| r.sign_in_done(&a.agent, &a.account).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Overage, |r, call, a| r.overage(a.id.as_str(), &a.turn_id, &a.kind).await.map(|()| c::Ack {}));
    project_test(s, kinds_for_run.clone());
    discover(s, kinds_for_run.clone());
    folders(s);
    let projects = kinds_for_run;
    s.command::<c::ProjectRun, _, _>(move |ctx, call, a| {
        let projects = projects.clone();
        async move {
            let list = projects.specs().await.unwrap_or_default();
            let (name, p) = crate::kinds::project_for(&list, &a.cwd).ok_or_else(|| WireError::not_found(format!("{} isn't in a declared project (projects: in a formula)", a.cwd)))?;
            if p.run.is_empty() {
                return Err(WireError::invalid(format!("{name} has no run scripts (run: in its project)")));
            }
            let args = serde_json::json!({ "kind": "shell", "id": format!("run:{name}"), "argv": ["sh", "-c", p.run.join(" && ")], "cwd": p.path });
            let out = ctx.run_json(&call, "terminal.open", args).await?;
            track(&ctx, "run_app", serde_json::json!({ "source": "project" })).await;
            Ok(out)
        }
    });
    s.command::<c::Sessions, _, _>(|ctx, _call, a| async move {
        let mut out = Vec::new();
        for h in ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS) {
            out.extend(h.list(&a.cwd).await);
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        Ok(out)
    });
    let adopting = slot.clone();
    s.command::<c::AdoptSession, _, _>(move |ctx, _call, a| {
        let slot = adopting.clone();
        async move {
            if !wisp_runtime_api::harness::sessions::safe_id(&a.id) {
                return Err(WireError::invalid(format!("{} isn't a session id", a.id)));
            }
            let h = ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().find(|h| h.harness() == a.harness).ok_or_else(|| WireError::not_found(format!("{} can't read its sessions", a.harness)))?;
            let (sess, turns) = h.read(&a.id).await.ok_or_else(|| WireError::not_found(format!("no {} session {}", a.harness, a.id)))?;
            let args = crate::specs::adopted(&sess, &turns);
            let rt = rt(&slot)?;
            if let Some(made) = rt.readopt(&sess.id, &args).await.map_err(WireError::from)? {
                return Ok(made);
            }
            rt.adopt(args).await.map_err(WireError::from)
        }
    });
    s.command::<c::RestoreSession, _, _>(|ctx, _call, a| async move {
        use base64::Engine as _;
        if !wisp_runtime_api::harness::sessions::safe_id(&a.id) {
            return Err(WireError::invalid(format!("{} isn't a session id", a.id)));
        }
        let h = ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().find(|h| h.harness() == a.harness).ok_or_else(|| WireError::not_found(format!("{} can't take a session back", a.harness)))?;
        let raw = base64::engine::general_purpose::STANDARD.decode(a.raw.as_bytes()).map_err(|e| WireError::invalid(e.to_string()))?;
        Ok(serde_json::json!({ "restored": h.restore(&a.id, &a.cwd, raw).await }))
    });
    let setups = slot.clone();
    s.command::<c::TaskSetup, _, _>(move |_ctx, _call, a| {
        let slot = setups.clone();
        async move {
            let rt = rt(&slot)?;
            let id = a.id.as_str();
            let s = rt.repo.session(id).await.map_err(WireError::from)?;
            let mut steps = Vec::new();
            for t in rt.repo.turns(id, None, None).await.map_err(WireError::from)? {
                steps.extend(rt.repo.steps(t.id.as_str(), None).await.map_err(WireError::from)?);
            }
            let available = crate::setup::load(&rt.repo.store, id).await.map(|a| crate::setup::changed(a, &crate::setup::latest_versions()));
            let note = if available.is_some() { serde_json::Value::Null } else if s.ext.contains_key("wisp.adopted") { serde_json::json!("it ran outside wisp: what it had isn't known") } else { serde_json::json!("not recorded (it ran before wisp kept setups)") };
            Ok(serde_json::json!({ "id": id, "available": available, "note": note, "used": crate::setup::used(&steps) }))
        }
    });
    let (agents, harnesses) = (slot.clone(), harness_kind);
    s.command::<c::Agents, _, _>(move |_ctx, _call, a| {
        let (slot, harnesses) = (agents.clone(), harnesses.clone());
        async move {
            let mut list = rt(&slot)?.agents(&a).await;
            crate::kinds::declared(&mut list, &harnesses.specs().await.unwrap_or_default());
            Ok(list)
        }
    });
}

fn edits(s: &mut Setup, slot: &Slot) {
    cmd!(s, slot, c::Stop, |r, call, a| r
        .stop(a.id.as_str(), a.clear_queue)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Rename, |r, call, a| r
        .rename(a.id.as_str(), &a.title)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Archive, |r, call, a| r
        .archive(a.id.as_str(), a.archived)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::SetMode, |r, call, a| r.set_mode(a.id.as_str(), a.mode).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::SetLean, |r, call, a| r.set_lean(a.id.as_str(), a.lean).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::SetAgent, |r, call, a| r.set_agent(a.id.as_str(), &a.agent).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::ForLater, |r, call, a| r.for_later(a.id.as_str(), a.for_later, a.at).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueOrder, |r, call, a| r.queue_order(a.id.as_str(), &a.order).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueCancel, |r, call, a| r.queue_cancel(a.id.as_str(), &a.item_id).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Held, |r, call, a| r.held(a.id.as_str(), a.action == c::ReleaseAction::Start).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::MarkRead, |r, call, a| r
        .mark_read(a.id.as_str(), a.unread)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::SetState, |r, call, a| r
        .set_state(a.id.as_str(), a.state)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Delete, |r, call, a| r
        .delete(a.id.as_str())
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueEdit, |r, call, a| r
        .queue_edit(a)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueSendNow, |r, call, a| r
        .queue_send_now(a.id.as_str(), &a.item_id)
        .await);
    cmd!(s, slot, c::QueueMerge, |r, call, a| r
        .queue_merge(a.id.as_str(), &a.ids)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::QueueText, |r, call, a| r
        .queue_text(a.id.as_str(), &a.item_id, &a.text)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Release, |r, call, a| r
        .release(
            a.id.as_str(),
            a.turn_id.as_str(),
            a.action == c::ReleaseAction::Start
        )
        .await
        .map(|()| c::Ack {}));
}

fn reads(s: &mut Setup, slot: &Slot) {
    cmd!(s, slot, c::Get, |r, call, a| r.get(a.id.as_str()).await);
    cmd!(s, slot, c::ResumeCommand, |r, call, a| r.resume_line(a.id.as_str()).await.map(|command| c::ResumeLine { command }));
    cmd!(s, slot, c::List, |r, call, a| Ok(r
        .list(&a)
        .iter()
        .map(|x| (**x).clone())
        .collect()));
    cmd!(s, slot, c::Turns, |r, call, a| r
        .turns(a.id.as_str(), a.before, a.limit)
        .await);
    cmd!(s, slot, c::ActivityOf, |r, call, a| r
        .activity(a.turn_id.as_str(), a.since_seq)
        .await);
    cmd!(s, slot, c::Cold, |r, call, a| r.cold(a.id.as_str()).await);
    cmd!(s, slot, c::PresentationOf, |r, call, a| r
        .presentation(a.id.as_str(), a.turn)
        .await);
    cmd!(s, slot, c::SetExt, |r, call, a| {
        own_slot(&call, &a.plugin)?;
        r.set_ext(a.id.as_str(), &a.plugin, a.value)
            .await
            .map(|()| c::Ack {})
    });
    cmd!(s, slot, c::Usage, |r, call, a| {
        let from = r.now() - i64::from(a.days.unwrap_or(7).clamp(1, 366)) * 86_400_000;
        let turns = r.repo.turns_since(from).await?;
        // where each task ran, for the per-project breakdown (v1 usage.js By project)
        let cwd: std::collections::HashMap<String, String> = r.repo.sessions().await?.into_iter().map(|x| (x.id.as_str().to_owned(), x.cwd)).collect();
        Ok(wisp_runtime_core::usage::breakdown(&turns, from, r.now(), &|id| cwd.get(id).cloned()))
    });
    let sl = slot.clone();
    s.command::<c::Exec, _, _>(move |ctx, _call, a| {
        let slot = sl.clone();
        async move {
            let r = rt(&slot)?;
            let (code, output) = r.exec(a.id.as_str(), &a.command).await.map_err(WireError::from)?;
            let agent = r.get(a.id.as_str()).await.map(|x| x.agent).unwrap_or_default();
            track(&ctx, "exec_action", serde_json::json!({ "agent": agent, "exitCode": code })).await;
            Ok(c::ExecOut { code, output })
        }
    });
    cmd!(s, slot, c::AppState, |r, call, a| r.app_state(a.id.as_str(), a.turn_id.as_str(), &a.block, a.state).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::TurnSetExt, |r, call, a| {
        own_slot(&call, &a.plugin)?;
        r.turn_set_ext(a.id.as_str(), a.turn_id.as_str(), &a.plugin, a.value)
            .await
            .map(|()| c::Ack {})
    });
    cmd!(s, slot, c::Note, |r, call, a| r
        .note(
            a.id.as_str(),
            a.turn_id.as_ref().map(wisp_runtime_api::TurnId::as_str),
            &a.label,
            a.tone
        )
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Settle, |r, call, a| r
        .settle(a.id.as_str(), a.quiet)
        .await
        .map(|()| c::Ack {}));
    cmd!(s, slot, c::Search, |r, call, a| r
        .search(&a.q, a.limit.unwrap_or(30).clamp(1, 100))
        .await);
    cmd!(s, slot, c::Card, |r, call, a| r.card(a).await);
    cmd!(s, slot, c::Import, |r, call, a| r
        .import_v1(a.dir.map(Into::into))
        .await);
}

/// A plugin writes its own ext slot only; the user and the kernel may write any.
fn own_slot(call: &wisp_kernel::Call, plugin: &str) -> crate::error::Result<()> {
    let caller = call.caller();
    let ok = matches!(caller.set.as_str(), "user:full" | "kernel")
        || caller.plugin.as_deref() == Some(plugin);
    if ok {
        Ok(())
    } else {
        Err(WireError::forbidden(format!("{} may not write {plugin}'s slot", caller.set)).into())
    }
}

impl Plugin for RuntimePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> WireResult<()> {
        let slot: Slot = Arc::default();
        commands(s, &slot);
        // who is under whom, for the kernel's agent-token scope (v1 edge case HTTP #3)
        s.contribute(&wisp_kernel::scope::TASKS, Arc::new(Tree(slot.clone())) as Arc<dyn wisp_kernel::scope::TaskTree>);
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?;
            let proc = ctx.service::<Proc>()?;
            let clock = ctx.clock()?;
            crate::schema::install(&store).map_err(WireError::from)?;
            let host = Arc::new(CtxHost { ctx: ctx.clone() });
            let runtime = Runtime::new(Repo::new((*store).clone()), host, (*proc).clone(), clock);
            runtime.start().await.map_err(WireError::from)?;
            let _ = slot.set(runtime);
            retention(&ctx, &slot);
            Ok(())
        });
        Ok(())
    }
}

/// `runtime.discover`: git repos under your home that aren't projects yet (`found.rs`).
fn discover(s: &mut Setup, known: Arc<wisp_resources_api::StoredKind>) {
    s.command::<c::Discover, _, _>(move |_ctx, _call, _a| {
        let known = known.clone();
        async move {
            let paths: Vec<String> = known.specs().await.unwrap_or_default().into_iter().filter_map(|(_, s)| s.get("path").and_then(serde_json::Value::as_str).map(str::to_owned)).collect();
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
            Ok(match home {
                Some(h) => crate::found::discover(&h, &paths).await,
                None => Vec::new(),
            })
        }
    });
}

/// `runtime.folders`: the folders a typed path could go on to (`found.rs` `folders`).
fn folders(s: &mut Setup) {
    s.command::<c::Folders, _, _>(move |_ctx, _call, a| async move {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
        Ok(crate::found::folders(&a.q, home.as_deref()).await)
    });
}

/// `runtime.projectTest`: a declared project's test command, written through its resource kind.
fn project_test(s: &mut Setup, tests_kind: Arc<wisp_resources_api::StoredKind>) {
    s.command::<c::ProjectTest, _, _>(move |_ctx, call, a| {
        let kind = tests_kind.clone();
        async move {
            use wisp_resources_api::ResourceKind as _;
            let list = kind.specs().await.unwrap_or_default();
            let (_, before) = list.into_iter().find(|(n, _)| *n == a.name).ok_or_else(|| WireError::not_found(format!("No project called {}", a.name)))?;
            let spec = crate::kinds::with_test(&before, &a.test_command);
            let op = wisp_resources_api::Op { op: wisp_resources_api::OpKind::Update, kind: "project".into(), name: a.name.clone(), spec, id: None, changes: Vec::new(), before: Some(before) };
            kind.apply(&call, &op).await?;
            Ok(c::Ack {})
        }
    });
}
