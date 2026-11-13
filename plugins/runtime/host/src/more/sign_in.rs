//! A signed-out turn's sign-in and rerun, and a turn billed past its plan.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_runtime_api::TurnId;
use wisp_runtime_api::commands::RerunArgs;
use wisp_runtime_api::model::SessionState;

use super::{SLOT, with_slot};
use crate::error::Result;
use crate::runtime::Runtime;

/// How long an armed sign-in waits for its login (v1 `SIGN_IN_MS`).
pub(crate) const SIGN_IN_MS: i64 = 15 * 60_000;

/// A turn that failed signed out, waiting for this login to land (v1 `armSignIn`).
#[derive(Debug, Clone)]
pub(crate) struct SignIn {
    pub session: String,
    pub agent: String,
    pub account: String,
    pub until: i64,
}

pub(super) fn account_of(a: Option<&str>) -> String {
    a.filter(|a| !a.is_empty() && *a != "default").unwrap_or_default().to_owned()
}

impl Runtime {
    /// `runtime.signIn` (v1 `armSignIn`): this signed-out turn reruns when its login lands.
    pub async fn sign_in(&self, id: &str, turn: &TurnId) -> Result<bool> {
        let Some(t) = self.last_turn(id).await?.filter(|t| &t.id == turn) else { return Ok(false) };
        let signed_out = t.ext.get(SLOT).and_then(|x| x.get("authFailed")).and_then(Value::as_bool).unwrap_or(false);
        if !signed_out || t.ext.get(SLOT).and_then(|x| x.get("rerun")).is_some() {
            return Ok(false);
        }
        let s = self.repo.session(id).await?;
        self.sign_ins().insert(t.id.0.clone(), SignIn { session: id.to_owned(), agent: t.agent.clone(), account: account_of(s.account.as_deref()), until: self.now() + SIGN_IN_MS });
        Ok(true)
    }

    /// `runtime.signInDone` (v1 `signInDone`): a login finished here; the turns armed for it run again.
    pub async fn sign_in_done(self: &Arc<Self>, agent: &str, account: &str) -> Result<()> {
        let acc = account_of(Some(account));
        let now = self.now();
        let due: Vec<(String, SignIn)> = {
            let mut m = self.sign_ins();
            m.retain(|_, x| x.until >= now);
            let keys: Vec<String> = m.iter().filter(|(_, x)| x.agent == agent && x.account == acc).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| m.remove(&k).map(|x| (k, x))).collect()
        };
        for (turn, x) in due {
            let s = self.repo.session(&x.session).await?;
            if s.archived || s.state == SessionState::Done {
                continue;
            }
            if let Err(e) = self.rerun(RerunArgs { id: s.id, turn_id: TurnId(turn), account: None }).await {
                tracing::warn!(error = %e, "rerun after sign-in");
            }
        }
        Ok(())
    }

    /// `runtime.overage` (v1 `#pastPlan`): the turn was billed past its plan; once per turn.
    pub async fn overage(self: &Arc<Self>, id: &str, turn: &TurnId, kind: &str) -> Result<()> {
        let _g = self.task_lock(id).await;
        let mut t = self.repo.turn(turn.as_str()).await?;
        if t.ext.get(SLOT).and_then(|x| x.get("overage")).is_some() {
            return Ok(());
        }
        with_slot(&mut t.ext, |m| m.insert("overage".into(), json!({ "kind": kind, "at": self.now() })));
        let mut s = self.repo.session(id).await?;
        self.persist(&mut s, vec![t]).await.map(|_| ())
    }
}
