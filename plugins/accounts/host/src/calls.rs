//! wisp.accounts' calls to other plugins, through their typed commands (`wisp-runtime-api`, `wisp-telemetry-api`,
//! `wisp-git-api`). What accounts only reports on (a usage stat, a held turn let go, a sign-in card woken) is logged
//! when refused; what a caller answers with is returned.

use serde_json::{Map, Value};
use wisp_git_api::Tools;
use wisp_git_api::commands as g;
use wisp_kernel::{Ctx, Result};
use wisp_runtime_api::commands::{self as r, AgentStatus};
use wisp_runtime_api::{SessionId, TurnId};
use wisp_telemetry_api as tel;

/// `telemetry.track`: a usage event this plugin owns (wisp.telemetry's catalogue: v1's names and keys); props that
/// aren't an object are sent as none.
pub async fn track(ctx: &Ctx, event: &str, props: Value) {
    let props = match props {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if let Err(err) = ctx.run::<tel::Track>(&ctx.root_call(), tel::TrackArgs { event: event.into(), props }).await {
        tracing::warn!(error = %err.message, event, "accounts: telemetry.track");
    }
}

/// `runtime.release` (start): a turn the harness watch held runs now.
pub async fn release(ctx: &Ctx, id: &str, turn: &str) {
    let a = r::ReleaseArgs { id: SessionId(id.to_owned()), turn_id: TurnId(turn.to_owned()), action: r::ReleaseAction::Start };
    if let Err(err) = ctx.run::<r::Release>(&ctx.root_call(), a).await {
        tracing::warn!(error = %err.message, task = id, turn, "accounts: runtime.release");
    }
}

/// `runtime.signInDone`: its models are looked up again, and the turn a sign-in card waits on runs again.
pub async fn sign_in_done(ctx: &Ctx, agent: &str, account: &str) {
    let a = r::SignInDoneArgs { agent: agent.to_owned(), account: account.to_owned() };
    if let Err(err) = ctx.run::<r::SignInDone>(&ctx.root_call(), a).await {
        tracing::warn!(error = %err.message, agent, "accounts: runtime.signInDone");
    }
}

/// `runtime.agents`: every harness as runtime sees it (`fresh: Some("all")` detects them all again).
pub async fn agents(ctx: &Ctx, fresh: Option<&str>) -> Result<Vec<AgentStatus>> {
    ctx.run::<r::Agents>(&ctx.root_call(), r::AgentsArgs { fresh: fresh.map(str::to_owned) }).await
}

/// `git.tools`: git's and gh's install state (None, logged at debug, when refused: asked on every publish).
pub async fn tools(ctx: &Ctx) -> Option<Tools> {
    match ctx.run::<g::GetTools>(&ctx.root_call(), ()).await {
        Ok(t) => Some(t),
        Err(err) => {
            tracing::debug!(error = %err.message, "accounts: git.tools");
            None
        }
    }
}
