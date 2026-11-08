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
        }
    }
}

pub trait Host: Send + Sync + 'static {
    fn emit(&self, e: Emitted);
    /// `before:run`'s interceptors, in order. Err: vetoed (the message reaches the user on the turn).
    fn before_run(&self, c: BeforeRunCtx) -> BoxFuture<'static, Result<BeforeRunCtx, WireError>>;
    fn harnesses(&self) -> Vec<Arc<dyn Harness>>;
    fn summary_fields(&self) -> Vec<Arc<dyn SummaryField>> {
        Vec::new()
    }
    fn after_steps(&self) -> Vec<Arc<dyn AfterTurn>> {
        Vec::new()
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
}

/// A host for tests and tools: records what was emitted, lets every run through, serves fixed harnesses.
#[derive(Default)]
pub struct Recorder {
    pub events: Mutex<Vec<Emitted>>,
    pub harnesses: Vec<Arc<dyn Harness>>,
    /// a `before:run` that vetoes with this message, or holds with this kind
    pub veto: Option<String>,
    pub hold: Option<String>,
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
}
