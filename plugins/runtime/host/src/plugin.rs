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
    let kind: Arc<dyn ResourceKind> = Arc::new(CrudKind::new::<AgentSpec>(info, s.ctx(), "runtime.profiles", "runtime.profile.set", "runtime.profile.set", "runtime.profile.remove").keyed("name", "name", "name"));
    s.contribute(&RESOURCE_KIND, kind);
    s.command::<c::Profiles, _, _>(|ctx, _, _| async move { crate::specs::profiles(&*ctx.service::<Store>()?).await });
    s.command::<c::ProfileSet, _, _>(|ctx, _, p| async move { crate::specs::set_profile(&*ctx.service::<Store>()?, p).await });
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
    let brief: Arc<dyn wisp_runtime_api::points::PromptPart> = Arc::new(crate::kinds::Brief);
    s.contribute(&wisp_runtime_api::points::PROMPT, brief);
    s.command::<c::Create, _, _>(move |_ctx, call, a| {
        let (slot, ctx, kinds) = (start.clone(), c1.clone(), made_kinds.clone());
        async move {
            let a = ctx.run_hook::<BeforeCreate>(&call, a).await?;
            let (store, proc) = (ctx.service::<Store>()?, ctx.service::<Proc>()?);
            let home = wisp_kernel::services::paths(&ctx).ok().map(|p| p.home().to_owned());
            let p = crate::specs::prepare(&store, &proc, home.as_deref(), Some(&kinds), a).await?;
            let rt = rt(&slot)?;
            let made = rt.create(p.args).await.map_err(WireError::from)?;
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
            rt(&slot)?.follow_up(a).await.map_err(WireError::from)
        }
    });
    specs(s, slot);
    edits(s, slot);
    reads(s, slot);
    for_agents(s, slot);
    more(s, slot, harness_kind);
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

/// asks, approvals, /btw, compact, rerun, fork, subagents, quick, sign-in, overage, agents (more.rs)
fn more(s: &mut Setup, slot: &Slot, harness_kind: Arc<wisp_resources_api::StoredKind>) {
    cmd!(s, slot, c::Ask, |r, call, a| r.ask(a).await.map(|ask_id| c::Asked { ask_id }));
    cmd!(s, slot, c::Answer, |r, call, a| r.answer(&a.id, &a.text).await);
    cmd!(s, slot, c::PollAnswerOf, |r, call, a| Ok(r.poll_answer(&a.ask_id)));
    cmd!(s, slot, c::Approval, |r, call, a| r.approval(a).await);
    cmd!(s, slot, c::ApproveBlocked, |r, call, a| r.approve_blocked(&a.id, a.turn_id.as_ref(), a.allow).await);
    cmd!(s, slot, c::Btw, |r, call, a| r.btw(a).await);
    cmd!(s, slot, c::BtwDrop, |r, call, a| r.btw_drop(a.id.as_str(), &a.btw_id).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Compact, |r, call, a| r.compact(&a.id).await);
    cmd!(s, slot, c::Rerun, |r, call, a| r.rerun(a).await);
    cmd!(s, slot, c::Fork, |r, call, a| r.fork(a).await);
    cmd!(s, slot, c::Adopt, |r, call, a| r.adopt(a).await);
    cmd!(s, slot, c::Delegate, |r, call, a| r.delegate(a).await);
    cmd!(s, slot, c::Results, |r, call, a| r.results(a).await);
    cmd!(s, slot, c::Quick, |r, call, a| r.quick(a).await);
    cmd!(s, slot, c::SignIn, |r, call, a| r.sign_in(a.id.as_str(), &a.turn_id).await.map(|_| c::Ack {}));
    cmd!(s, slot, c::SignInDone, |r, call, a| r.sign_in_done(&a.agent, &a.account).await.map(|()| c::Ack {}));
    cmd!(s, slot, c::Overage, |r, call, a| r.overage(a.id.as_str(), &a.turn_id, &a.kind).await.map(|()| c::Ack {}));
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
    cmd!(s, slot, c::PresentationOf, |r, call, a| r
        .presentation(a.id.as_str(), a.turn)
        .await);
    cmd!(s, slot, c::SetExt, |r, call, a| {
        own_slot(&call, &a.plugin)?;
        r.set_ext(a.id.as_str(), &a.plugin, a.value)
            .await
            .map(|()| c::Ack {})
    });
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
