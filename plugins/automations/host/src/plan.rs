//! Runs a trigger started that wait for their plan (wisp.budget held the turn, `turn.held` by `wisp.budget`, kind
//! `plan`): the trigger's row says so (`held`, with why) until the plan frees (`budget.plan_free`, or
//! `automations.release` by hand; v1 index.js `app.triggers.release(agent)`), or the run ends.

use wisp_automations_core::plan::{self, PlanWait};
use wisp_kernel::Ctx;
use wisp_runtime_api::commands as rt;

use crate::engine::Engine;

/// The plugin whose hold is the plan's, and its kind.
const BUDGET: (&str, &str) = ("wisp.budget", "plan");

impl Engine {
    /// `turn.held`: a run one of the triggers started waits for its plan; that trigger's row says so.
    pub async fn plan_held(&self, ctx: &Ctx, session: &str, by: &str, kind: &str, now: i64) {
        if (by, kind) != BUDGET {
            return;
        }
        let names: Vec<String> =
            self.states().await.into_iter().filter(|(_, st)| st.running.iter().any(|s| s == session)).map(|(n, _)| n).collect();
        if names.is_empty() {
            return; // not a trigger's run: no read
        }
        let (agent, account) = match ctx.run::<rt::Get>(&ctx.root_call(), rt::IdArgs { id: session.into() }).await {
            Ok(s) => (s.agent, s.account.unwrap_or_default()),
            Err(e) => {
                tracing::warn!(task = %session, "automations: runtime.get: {}", e.message);
                return;
            }
        };
        let why = format!("waits for {agent}'s plan (Automations stop at)");
        for name in names {
            let _one = self.gate.lock().await;
            let mut st = self.load(&name).await;
            let w = PlanWait { at: now, session: session.to_owned(), agent: agent.clone(), account: account.clone(), why: why.clone() };
            if plan::held(&mut st, w)
                && let Err(e) = self.save(&name, &st).await
            {
                tracing::warn!(trigger = %name, "state not saved: {}", e.message);
            }
        }
    }

    /// `agent@account`'s plan is free (an empty account: all of `agent`'s): the rows that waited for it stop saying
    /// so. The run itself is wisp.budget's to start. → how many rows.
    pub async fn release(&self, agent: &str, account: &str) -> u32 {
        let mut n = 0;
        for (name, st) in self.states().await {
            if st.plan.is_none() {
                continue;
            }
            let _one = self.gate.lock().await;
            let mut st = self.load(&name).await;
            if plan::release(&mut st, agent, account) {
                n += 1;
                if let Err(e) = self.save(&name, &st).await {
                    tracing::warn!(trigger = %name, "state not saved: {}", e.message);
                }
            }
        }
        n
    }
}
