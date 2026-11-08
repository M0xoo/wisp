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

/// The plugin. `mirror`: v1's sessions folder to keep current (the dual-write release), if any.
#[derive(Debug, Default)]
pub struct RuntimePlugin {
    pub mirror: Option<std::path::PathBuf>,
}

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

fn commands(s: &mut Setup, slot: &Slot) {
    let ctx = s.ctx();
    let (c1, c2) = (ctx.clone(), ctx);
    let start = slot.clone();
    s.command::<c::Create, _, _>(move |_ctx, call, a| {
        let (slot, ctx) = (start.clone(), c1.clone());
        async move {
            let a = ctx.run_hook::<BeforeCreate>(&call, a).await?;
            rt(&slot)?.create(a).await.map_err(WireError::from)
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
    edits(s, slot);
    reads(s, slot);
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
        crate::routes::register(s, &slot);
        let mirror = self.mirror.clone();
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?;
            let proc = ctx.service::<Proc>()?;
            let clock = ctx.clock()?;
            crate::schema::install(&store).map_err(WireError::from)?;
            let host = Arc::new(CtxHost { ctx: ctx.clone() });
            let mut runtime =
                Runtime::new(Repo::new((*store).clone()), host, (*proc).clone(), clock);
            if let Some(m) = mirror
                && let Some(r) = Arc::get_mut(&mut runtime)
            {
                r.mirror = Some(m);
            }
            runtime.start().await.map_err(WireError::from)?;
            let _ = slot.set(runtime);
            Ok(())
        });
        Ok(())
    }
}
