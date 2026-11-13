//! The kernel side of the host seam (`CtxHost`) and the task tree the kernel's agent-token scope reads.

use std::sync::Arc;

use wisp_kernel::{BoxFuture, Ctx, Result as WireResult, WireError};
use wisp_runtime_api::hooks::{BeforeRun, BeforeRunCtx};
use wisp_runtime_api::points::{AFTER, BLOCK, OUTCOME, PROMPT, RUN, SUMMARY};
use wisp_runtime_api::{HARNESS, Harness};

use super::{Slot, rt};
use crate::host::{Emitted, Host};

/// The kernel side of the host seam.
pub(super) struct CtxHost {
    pub(super) ctx: Ctx,
}

impl Host for CtxHost {
    fn setting(&self, key: &str) -> Option<serde_json::Value> {
        self.ctx.setting(key)
    }
    fn shots(&self) -> Option<std::path::PathBuf> {
        self.ctx.service::<wisp_kernel::services::Paths>().ok().map(|p| p.join("shots"))
    }
    fn net(&self) -> Option<wisp_kernel::services::NetService> {
        wisp_kernel::services::net(&self.ctx).ok()
    }
    fn command(
        &self,
        cmd: &str,
        args: serde_json::Value,
    ) -> wisp_kernel::BoxFuture<'static, std::result::Result<serde_json::Value, WireError>> {
        self.ctx.run_json(&self.ctx.root_call(), cmd, args)
    }
    fn emit(&self, e: Emitted) {
        let call = self.ctx.root_call();
        match e {
            Emitted::Created(x) => self.ctx.emit(&call, &x),
            Emitted::Changed(x) => self.ctx.emit(&call, &x),
            Emitted::Deleted(x) => self.ctx.emit(&call, &x),
            Emitted::Started(x) => self.ctx.emit(&call, &x),
            // a step's .env output never leaves on the event either (ADR-0050)
            Emitted::Activity(mut x) => {
                if crate::env_view::on(&self.ctx) {
                    match crate::env_view::mask_items(std::mem::take(&mut x.items)) {
                        Ok(items) => x.items = items,
                        Err(_) => return,
                    }
                }
                self.ctx.emit(&call, &x);
            }
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
pub(super) struct Tree(pub(super) Slot);

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
