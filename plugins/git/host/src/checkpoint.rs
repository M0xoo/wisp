//! A turn's rollback (v1's per-turn checkpoint): just before a turn runs, the folder as it is is kept
//! (`snapshot`, or HEAD when nothing is changed) on the turn as `ext["wisp.git"].checkpoint = {to, head}`;
//! `git.restoreTurn` puts the folder and the branch back there. Nothing of the user's is touched to keep it:
//! the snapshot is a commit no branch points at, made through a temporary index.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_git_api::GitService;
use wisp_kernel::{BoxFuture, Command, Ctx, Setup, WireError};
use wisp_runtime_api::model::Session;
use wisp_runtime_api::points::{RUN, RunPart};

use crate::service::{GitServiceImpl, Service};

pub const EXT: &str = "wisp.git";

/// Where a turn's rollback goes: the folder (`to`) and the branch (`head`) as they were.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub to: String,
    pub head: String,
}

/// The checkpoint a turn keeps, from its ext.
pub fn of_turn(ext: &Value) -> Option<Checkpoint> {
    serde_json::from_value(ext.get(EXT)?.get("checkpoint")?.clone()).ok()
}

struct Keep {
    ctx: Ctx,
    svc: Service,
}

impl RunPart for Keep {
    fn id(&self) -> &str {
        EXT
    }
    fn before_turn(&self, session: &Session) -> BoxFuture<'static, Option<(String, Value)>> {
        let (ctx, svc, cwd) = (self.ctx.clone(), self.svc.clone(), session.cwd.clone());
        Box::pin(async move {
            let call = ctx.root_call();
            let repo = svc.repo(&call, ctx.scope(), &cwd).await.ok()?;
            let head = repo.rev_parse(&call, "HEAD").await.ok().flatten()?;
            let to = repo.snapshot(&call).await.ok().flatten().unwrap_or_else(|| head.clone());
            Some((EXT.to_owned(), json!({ "checkpoint": Checkpoint { to, head } })))
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreTurnArgs {
    /// the task
    pub id: String,
    pub turn: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Restored {
    pub restored: bool,
}

/// `git.restoreTurn`: the task's folder back as it was just before `turn` ran.
#[derive(Debug)]
pub struct RestoreTurn;
impl Command for RestoreTurn {
    const ID: &'static str = "git.restoreTurn";
    type Args = RestoreTurnArgs;
    type Out = Restored;
}

async fn restore(ctx: &Ctx, svc: &Service, a: RestoreTurnArgs) -> Result<Restored, WireError> {
    let call = ctx.root_call();
    let task = ctx.run_json(&call, "runtime.get", json!({ "id": a.id })).await?;
    let cwd = task.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned();
    let turns = ctx.run_json(&call, "runtime.turns", json!({ "id": a.id })).await?;
    let turn = turns
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(a.turn.as_str()))
        .ok_or_else(|| WireError::not_found("No such turn on this task."))?;
    let Some(cp) = turn.get("ext").and_then(of_turn) else {
        return Err(WireError::invalid("This turn ran before checkpoints were kept: there's nothing to go back to."));
    };
    let repo = svc.repo(&call, ctx.scope(), &cwd).await?;
    repo.restore(&call, &cp.to, &cp.head).await?;
    let _ = repo.touch(&call, "restore");
    Ok(Restored { restored: true })
}

pub(crate) fn register(s: &mut Setup, svc: &Arc<GitServiceImpl>) {
    let part: Arc<dyn RunPart> = Arc::new(Keep { ctx: s.ctx(), svc: Service(svc.clone()) });
    s.contribute(&RUN, part);
    let sv = Service(svc.clone());
    s.command::<RestoreTurn, _, _>(move |ctx, _call, a| {
        let sv = sv.clone();
        async move { restore(&ctx, &sv, a).await }
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_turns_checkpoint_is_read_from_its_ext() {
        let ext = json!({ "wisp.git": { "checkpoint": { "to": "abc", "head": "def" } }, "other": 1 });
        assert_eq!(of_turn(&ext).unwrap(), Checkpoint { to: "abc".into(), head: "def".into() });
        assert!(of_turn(&json!({})).is_none(), "a turn from before checkpoints");
    }
}
