//! A banked (early) reset (v1 index.js `app.resetEarly`, F-auto-12): a reading shows a window reset before its time, so
//! what waits on that account goes now, not at the old reset: the runs held here start, and `budget.plan_free` tells
//! wisp.later to bring due the follow-ups it holds (it sends the phone's one note, with the count). Starting a held
//! turn is tried again on the next looks when the runtime refuses it.

use wisp_budget_api::PlanFree;
use wisp_budget_api::events::Reset;
use wisp_kernel::Ctx;
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::{SessionId, TurnId};

use crate::{State, account_of, lock, now};

/// A held turn to start: ((agent, account), (task, turn)).
pub(crate) type Due = ((String, String), (String, String));

/// How many looks a held turn the runtime refuses to start is tried again.
const RELEASE_TRIES: u8 = 5;

/// Held turns the runtime refused to start: tries per turn, and those to try again at the next look.
#[derive(Debug, Default)]
pub(crate) struct Retry {
    tries: std::collections::BTreeMap<String, u8>,
    again: Vec<Due>,
}

impl State {
    /// The turns `start` couldn't start wait again, from this look on (not the same look's `release`, which would
    /// spend their tries before the runtime could have written them held).
    pub(crate) fn requeue(&self) {
        let again = std::mem::take(&mut lock(&self.retry).again);
        let mut held = lock(&self.held);
        for (key, t) in again {
            held.entry(key).or_default().push(t);
        }
    }

    /// Held turns start: → how many did. One the runtime refuses goes back to wait for the next look, a few times:
    /// a look can come between `before:run` holding a turn and the runtime writing it held ("that turn isn't
    /// waiting"), and dropping it then left it held for good.
    pub(crate) async fn start(&self, ctx: &Ctx, due: Vec<Due>) -> u32 {
        let mut n = 0;
        for (key, (id, turn)) in due {
            let a = rt::ReleaseArgs { id: SessionId(id.clone()), turn_id: TurnId(turn.clone()), action: rt::ReleaseAction::Start };
            match ctx.run::<rt::Release>(&ctx.root_call(), a).await {
                Ok(_) => {
                    lock(&self.retry).tries.remove(&turn);
                    n += 1;
                }
                Err(err) => {
                    let again = {
                        let mut r = lock(&self.retry);
                        let tries = r.tries.entry(turn.clone()).or_insert(0);
                        *tries += 1;
                        let again = *tries <= RELEASE_TRIES;
                        if again {
                            r.again.push((key, (id.clone(), turn.clone())));
                        } else {
                            r.tries.remove(&turn);
                        }
                        again
                    };
                    tracing::warn!(error = %err.message, task = %id, turn = %turn, again, "budget: runtime.release");
                }
            }
        }
        n
    }

    /// Windows of `agent@account` reset before their time (a banked reset, v1 `app.resetEarly`): `budget.reset`, and
    /// when no window holds the account any more, what waits on it goes now: the runs held here start, and
    /// `budget.plan_free` brings due the follow-ups later holds for it (it sends the one phone note, with the count).
    pub(crate) async fn reset_early(&self, ctx: &Ctx, agent: &str, account: &str, ids: Vec<String>) {
        let account = account_of(account);
        let free = self.free(agent, &account, now(ctx));
        tracing::info!(agent, %account, ?ids, free, "budget: a window reset early");
        ctx.emit(&ctx.root_call(), &Reset { agent: agent.to_owned(), account: account.clone(), ids, free });
        if !free {
            return; // another window still holds it (the weekly one, say)
        }
        let key = (agent.to_owned(), account.clone());
        lock(&self.limited).remove(&key);
        let mut due: Vec<Due> = lock(&self.held).remove(&key).unwrap_or_default().into_iter().map(|t| (key.clone(), t)).collect();
        due.extend(self.ask_freed(agent, &account));
        let started = self.start(ctx, due).await;
        ctx.emit(&ctx.root_call(), &PlanFree { agent: agent.to_owned(), account, started });
    }

    /// Codex accounts work waits on (v1 `waitingOn`): runs held here, and accounts a run found at their limit.
    pub(crate) fn waiting(&self, at: i64) -> Vec<String> {
        let mut out: std::collections::BTreeSet<String> =
            lock(&self.held).keys().filter(|(g, _)| g == "codex").map(|(_, a)| a.clone()).collect();
        out.extend(lock(&self.asked).iter().filter(|a| a.agent == "codex").map(|a| a.account.clone()));
        let limited: Vec<String> = lock(&self.limited).iter().filter(|(g, _)| g == "codex").map(|(_, a)| a.clone()).collect();
        let (free, held): (Vec<String>, Vec<String>) = limited.into_iter().partition(|a| self.free("codex", a, at));
        {
            let mut l = lock(&self.limited);
            for a in free {
                l.remove(&("codex".to_owned(), a));
            }
        }
        out.extend(held);
        out.into_iter().collect()
    }
}
