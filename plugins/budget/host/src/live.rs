//! Check Codex while work waits (v1 live-limits.js, Settings → Usage, `budget.liveLimits`, off by default): while
//! work on a Codex account waits for its plan, wisp asks Codex's app-server how that account's windows stand
//! (`accounts.limits`: no model turn, nothing spent), every 10 minutes. A window that reset early (a banked reset)
//! frees the waiting work through `record`. A read that fails tries less often, up to hourly. Claude Code has no
//! such read. wisp never redeems a reset credit.

use std::collections::BTreeMap;

use wisp_budget_core::limits::{codex_banked, codex_live};
use wisp_kernel::Ctx;

use crate::{State, lock, now};

pub const SETTING: &str = "budget.liveLimits";
pub const EVERY_MS: i64 = 10 * 60_000;
pub const MAX_BACKOFF_MS: i64 = 60 * 60_000;

/// When each account's next read is due, and how long the last failure waits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Due {
    pub at: i64,
    pub backoff: i64,
}

/// After a read: on time again in ten minutes, or later and later while it fails (v1: half of ten, doubled).
pub fn next(d: Option<Due>, ok: bool, now: i64) -> Due {
    if ok {
        return Due { at: now + EVERY_MS, backoff: 0 };
    }
    let backoff = (d.map_or(EVERY_MS / 2, |d| if d.backoff == 0 { EVERY_MS / 2 } else { d.backoff }) * 2).min(MAX_BACKOFF_MS);
    Due { at: now + backoff, backoff }
}

impl State {
    /// One pass: each Codex account with work held on it, when its read is due.
    pub(crate) async fn live(&self, ctx: &Ctx, due: &mut BTreeMap<String, Due>) -> u32 {
        if ctx.setting(SETTING).and_then(|v| v.as_bool()) != Some(true) {
            return 0;
        }
        let waiting: Vec<String> = lock(&self.held).keys().filter(|(g, _)| g == "codex").map(|(_, a)| a.clone()).collect();
        let mut n = 0;
        for account in waiting {
            let t = now(ctx);
            if due.get(&account).is_some_and(|d| d.at > t) {
                continue;
            }
            let a = wisp_accounts_api::commands::AccountArgs { agent: "codex".into(), account: account.clone() };
            let read = match ctx.run::<wisp_accounts_api::commands::Limits>(&ctx.root_call(), a).await {
                Ok(v) => Some(v).filter(|v| !v.is_null()),
                Err(err) => {
                    tracing::warn!(error = %err.message, %account, "budget: accounts.limits");
                    None
                }
            };
            let report = read.as_ref().and_then(|v| {
                let banked = codex_banked(v, t);
                codex_live(v, t).map(|mut r| {
                    r.read = true;
                    r.banked = banked;
                    r
                })
            });
            let ok = report.is_some();
            if let Some(r) = report {
                self.record(ctx, "codex", &account, &r).await;
                n += 1;
            } else {
                tracing::debug!(%account, "codex usage: no reading");
            }
            let was = due.get(&account).copied();
            due.insert(account, next(was, ok, t));
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_comes_every_ten_minutes_and_less_often_while_it_fails() {
        assert_eq!(next(None, true, 0), Due { at: EVERY_MS, backoff: 0 });
        let f1 = next(None, false, 0);
        assert_eq!(f1, Due { at: EVERY_MS, backoff: EVERY_MS }, "half of ten, doubled");
        let f2 = next(Some(f1), false, 0);
        assert_eq!(f2.backoff, 2 * EVERY_MS);
        let mut d = f2;
        for _ in 0..5 {
            d = next(Some(d), false, 0);
        }
        assert_eq!(d.backoff, MAX_BACKOFF_MS, "up to hourly");
        assert_eq!(next(Some(d), true, 0).backoff, 0, "a good read starts over");
    }
}
