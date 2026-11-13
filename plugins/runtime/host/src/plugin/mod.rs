//! `impl Plugin`: wisp.runtime's commands, its v1 routes and its start (migrations, the list cache, turns
//! a crash left running). The runtime itself is built in `on_start`, once the store and proc services are
//! there; a command that arrives before answers `unavailable` (retry). One module per group of commands;
//! this one holds the slot, the `cmd!` macro and the order they register in.

use std::sync::{Arc, OnceLock};

use wisp_kernel::{Manifest, Plugin, Result as WireResult, Setup, WireError};
use wisp_proc::Proc;
use wisp_store::Store;

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

/// Registers command `$cmd` with a handler over the started runtime.
macro_rules! cmd {
    ($s:expr, $slot:expr, $cmd:ty, |$rt:ident, $call:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$cmd, _, _>(move |_ctx, $call, $a| {
            let slot = slot.clone();
            async move {
                let $rt = $crate::plugin::rt(&slot)?;
                let _ = &$call;
                let out: crate::error::Result<_> = $body;
                out.map_err(wisp_kernel::WireError::from)
            }
        });
    }};
}

mod create;
mod ctx_host;
mod edits;
mod more;
mod projects;
mod reads;
mod retention;
mod sessions;
mod specs;

use ctx_host::{CtxHost, Tree};

/// A catalogue event for the fact this plugin owns (ADR-0021); never fails the command that caused it.
async fn track(ctx: &wisp_kernel::Ctx, event: &str, props: serde_json::Value) {
    let props = match props {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    if let Err(err) = ctx.run::<wisp_telemetry_api::Track>(&ctx.root_call(), wisp_telemetry_api::TrackArgs { event: event.into(), props }).await {
        tracing::warn!(error = %err.message, event, "runtime: telemetry.track");
    }
}

fn commands(s: &mut Setup, slot: &Slot) {
    let made_kinds = crate::kinds::register(s);
    let harness_kind = made_kinds.harness.clone();
    let project_kind = made_kinds.project.clone();
    let issue_projects: Arc<dyn wisp_issues_api::Projects> = Arc::new(crate::kinds::IssueProjects(project_kind.clone()));
    s.contribute(&wisp_issues_api::PROJECTS, issue_projects);
    let brief: Arc<dyn wisp_runtime_api::points::PromptPart> = Arc::new(crate::kinds::Brief);
    s.contribute(&wisp_runtime_api::points::PROMPT, brief);
    create::create_and_follow_up(s, slot, made_kinds);
    specs::specs(s, slot);
    edits::edits(s, slot);
    reads::reads(s, slot);
    reads::for_agents(s, slot);
    more::more(s, slot, harness_kind, project_kind);
    crate::term::setup(s, slot);
    crate::group::setup(s);
    crate::watch::setup(s, slot);
}

impl Plugin for RuntimePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> WireResult<()> {
        let slot: Slot = Arc::default();
        commands(s, &slot);
        s.route(crate::media::route(&slot));
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
            retention::retention(&ctx, &slot);
            Ok(())
        });
        Ok(())
    }
}
