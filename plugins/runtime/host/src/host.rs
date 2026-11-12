//! What the runtime needs from the kernel, as one seam: events to publish after commit, the `before:run`
//! interceptors, and the contributions to its points. The plugin wires it to `Ctx` (`plugin.rs`); tests
//! give a recording fake. So the runtime's logic runs, and is tested, without a kernel dispatcher.

use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::{BoxFuture, WireError};
use wisp_runtime_api::Harness;
use wisp_runtime_api::events::{
    SessionChanged, SessionCreated, SessionDeleted, TurnActivity, TurnEnded, TurnFinished,
    TurnHeld, TurnLimits, TurnStarted,
};
use wisp_runtime_api::hooks::BeforeRunCtx;
use wisp_runtime_api::points::{
    AfterTurn, BlockType, PromptPart, RunPart, SummaryField, TurnOutcome,
};

/// An event, published by the kernel after the write that caused it committed.
#[derive(Debug, Clone, PartialEq)]
pub enum Emitted {
    Created(SessionCreated),
    Changed(SessionChanged),
    Deleted(SessionDeleted),
    Started(TurnStarted),
    Activity(TurnActivity),
    Finished(TurnFinished),
    Ended(TurnEnded),
    Held(TurnHeld),
    Limits(TurnLimits),
    /// a `task.*` fact (ADR-0043): its type and what it says
    Task(&'static str, wisp_runtime_api::events::TaskFact),
}

impl Emitted {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Created(_) => "session.created",
            Self::Changed(_) => "session.changed",
            Self::Deleted(_) => "session.deleted",
            Self::Started(_) => "turn.started",
            Self::Activity(_) => "turn.activity",
            Self::Finished(_) => "turn.finished",
            Self::Ended(_) => "turn.ended",
            Self::Held(_) => "turn.held",
            Self::Limits(_) => "turn.limits",
            Self::Task(ty, _) => ty,
        }
    }
}

pub trait Host: Send + Sync + 'static {
    fn emit(&self, e: Emitted);
    /// `before:run`'s interceptors, in order. Err: vetoed (the message reaches the user on the turn).
    fn before_run(&self, c: BeforeRunCtx) -> BoxFuture<'static, Result<BeforeRunCtx, WireError>>;
    fn harnesses(&self) -> Vec<Arc<dyn Harness>>;
    /// A setting's value (the kernel's settings store), if set or declared.
    fn setting(&self, _key: &str) -> Option<serde_json::Value> {
        None
    }
    /// Where an answer's pictures are kept (`~/.wisp/shots`, v1 store.shots); none: they aren't copied. Additive.
    fn shots(&self) -> Option<std::path::PathBuf> {
        None
    }
    /// How a task's agent reaches wisp, if the install provides it.
    fn agent_access(&self) -> Option<Arc<dyn wisp_runtime_api::points::AgentAccess>> {
        None
    }
    /// Work that outlives the command (a side run): on the plugin's scope, so switching it off ends it.
    fn spawn(&self, fut: wisp_kernel::BoxFuture<'static, ()>) {
        tokio::spawn(fut);
    }
    fn summary_fields(&self) -> Vec<Arc<dyn SummaryField>> {
        Vec::new()
    }
    /// The kernel's net service, for probing a run's HTTP MCP servers (ADR-0029). None in tests.
    fn net(&self) -> Option<wisp_kernel::services::NetService> {
        None
    }
    fn after_steps(&self) -> Vec<Arc<dyn AfterTurn>> {
        Vec::new()
    }
    /// `router.service@1` (Auto) and a call that speaks for wisp.runtime, when a router is on. Additive.
    fn router(&self) -> Option<(Arc<dyn wisp_router_api::service::RouterApi>, wisp_kernel::Call)> {
        None
    }
    fn blocks(&self) -> Vec<Arc<dyn BlockType>> {
        Vec::new()
    }
    fn prompt_parts(&self) -> Vec<Arc<dyn PromptPart>> {
        Vec::new()
    }
    fn run_parts(&self) -> Vec<Arc<dyn RunPart>> {
        Vec::new()
    }
    fn outcomes(&self) -> Vec<Arc<dyn TurnOutcome>> {
        Vec::new()
    }
    /// Another plugin's command, through its id (a My Stuff mention's `stuff.describe`). Unavailable in tests.
    fn command(&self, cmd: &str, _args: serde_json::Value) -> BoxFuture<'static, Result<serde_json::Value, WireError>> {
        let e = WireError::unavailable(format!("{cmd}: no kernel here"));
        Box::pin(async move { Err(e) })
    }
}

/// A host for tests and tools: records what was emitted, lets every run through, serves fixed harnesses.
#[derive(Default)]
pub struct Recorder {
    pub events: Mutex<Vec<Emitted>>,
    pub harnesses: Vec<Arc<dyn Harness>>,
    /// a `before:run` that vetoes with this message, or holds with this kind
    pub veto: Option<String>,
    pub hold: Option<String>,
    /// `runtime.run@1` contributions (a test's checkpoint keeper)
    pub parts: Vec<Arc<dyn RunPart>>,
    /// a stand-in for `router.service@1` (Auto)
    pub router: Option<Arc<dyn wisp_router_api::service::RouterApi>>,
    /// the settings it answers
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
    /// what other plugins' commands answer (`budget.resetAt`, `later.waitAtLimit`…); one not here is unavailable
    pub answers: std::collections::BTreeMap<String, serde_json::Value>,
    /// the commands it was asked, in order
    pub asked: Mutex<Vec<(String, serde_json::Value)>>,
    /// where an answer's pictures are kept (`~/.wisp/shots`); none: not copied
    pub shots: Option<std::path::PathBuf>,
}

impl std::fmt::Debug for Recorder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recorder")
            .field("events", &self.names())
            .finish_non_exhaustive()
    }
}

impl Recorder {
    pub fn names(&self) -> Vec<&'static str> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(Emitted::name)
            .collect()
    }
    pub fn taken(&self) -> Vec<Emitted> {
        std::mem::take(&mut *self.events.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl Host for Recorder {
    fn command(&self, cmd: &str, args: serde_json::Value) -> BoxFuture<'static, Result<serde_json::Value, WireError>> {
        self.asked.lock().unwrap_or_else(PoisonError::into_inner).push((cmd.to_owned(), args));
        let out = self.answers.get(cmd).cloned().ok_or_else(|| WireError::unavailable(format!("{cmd}: no kernel here")));
        Box::pin(async move { out })
    }
    fn setting(&self, key: &str) -> Option<serde_json::Value> {
        self.settings.get(key).cloned()
    }
    fn run_parts(&self) -> Vec<Arc<dyn RunPart>> {
        self.parts.clone()
    }
    fn shots(&self) -> Option<std::path::PathBuf> {
        self.shots.clone()
    }
    fn emit(&self, e: Emitted) {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(e);
    }
    fn before_run(
        &self,
        mut c: BeforeRunCtx,
    ) -> BoxFuture<'static, Result<BeforeRunCtx, WireError>> {
        if let Some(m) = &self.veto {
            let e = WireError::new(wisp_kernel::Code::Vetoed, m.clone());
            return Box::pin(async move { Err(e) });
        }
        if let Some(kind) = &self.hold {
            c.hold = Some(wisp_runtime_api::model::Held {
                by: "test".into(),
                kind: kind.clone(),
                until: None,
                data: serde_json::Value::Null,
            });
        }
        Box::pin(async move { Ok(c) })
    }
    fn harnesses(&self) -> Vec<Arc<dyn Harness>> {
        self.harnesses.clone()
    }
    fn router(&self) -> Option<(Arc<dyn wisp_router_api::service::RouterApi>, wisp_kernel::Call)> {
        self.router.clone().map(|r| (r, wisp_kernel::Call::new_root(wisp_kernel::Caller::user())))
    }
}

/// A `task.*` fact about `s` (ADR-0043).
pub fn fact(s: &wisp_runtime_api::model::Session, turn: Option<&wisp_runtime_api::TurnId>, status: &str, text: &str, cost: Option<f64>) -> wisp_runtime_api::events::TaskFact {
    wisp_runtime_api::events::TaskFact {
        session_id: s.id.clone(),
        turn_id: turn.cloned(),
        title: s.title.clone(),
        cwd: s.cwd.clone(),
        agent: s.agent.clone(),
        crew: s.ext_of("wisp.crew").get("id").and_then(serde_json::Value::as_str).map(str::to_owned),
        tags: s.tags.clone(),
        status: status.to_owned(),
        text: text.chars().take(500).collect(),
        cost_usd: cost,
    }
}
