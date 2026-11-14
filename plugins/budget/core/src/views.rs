//! What the model says to its readers (v1 budget.js:370-416, 453-487, 540-548, 602-656): fresh
//! windows at 0, the hold for Automations stop at, Settings → Usage's accounts, and the small writes
//! the page makes.

use wisp_budget_api::{
    AccountView, BankedCredit, BankedDue, Drain, OverageKind, OverageView, PlanHold, WindowNotice, WindowNow, WindowView,
};

use crate::drain::{drain_of, rate_of, spend};
use crate::limits::{banked_at, banked_due};
use crate::model::Budget;
use crate::shape::stale;
use crate::state::{Acc, Ack, Over, Win, account_or_default};
use crate::windows::{FULL, H, pace_of, rank, window_label};

const OVER_KEEP: usize = 50;
const OVER_AGE: i64 = 7 * 24 * H;

/// Windows at or past `stop` whose reset is still to come. A window with no reset time holds
/// nothing: wisp couldn't say until when (budget.js:460, edge case Top-10 #1).
fn over(acc: &Acc, stop: f64, now: i64) -> Vec<(&String, &Win)> {
    acc.windows.iter().filter(|(_, w)| w.used >= stop - 1e-9 && w.resets_at.is_some_and(|r| r > now)).collect()
}

fn fresh(w: &Win, now: i64) -> bool {
    w.resets_at.is_some_and(|r| r <= now)
}

impl Budget {
    /// Automations stop at: the window that holds work back on this account, or None (budget.js:456).
    /// `until`: when every window past the line has reset. `why` is left for the host (it knows names).
    pub fn hold(&self, agent: &str, account: &str, stop: Option<f64>, now: i64) -> Option<PlanHold> {
        let stop = stop.filter(|s| *s > 0.0)?;
        let acc = self.get(agent, account)?;
        let list = over(acc, stop, now);
        let until = list.iter().filter_map(|(_, w)| w.resets_at).max()?;
        // the fullest names it; ties go to the first
        let (id, w) = list.iter().fold(None::<(&String, &Win)>, |best, (id, w)| match best {
            Some((_, b)) if b.used >= w.used => best,
            _ => Some((id, w)),
        })?;
        Some(PlanHold {
            agent: agent.to_owned(),
            account: account_or_default(account).to_owned(),
            window: id.clone(),
            label: window_label(id, w.ms),
            used: w.used,
            stop,
            until,
            why: String::new(),
            load: false,
        })
    }

    /// When the account can run again after a limit: the latest reset among windows at 99.5%+ whose
    /// reset hasn't passed, or None when it doesn't know (budget.js:468).
    pub fn reset_at(&self, agent: &str, account: &str, now: i64) -> Option<i64> {
        over(self.get(agent, account)?, FULL, now).iter().filter_map(|(_, w)| w.resets_at).max()
    }

    /// No window holds the account: none past `stop`, none full (v1 index.js:504 `planFree`).
    pub fn free(&self, agent: &str, account: &str, stop: Option<f64>, now: i64) -> bool {
        self.hold(agent, account, stop, now).is_none() && self.reset_at(agent, account, now).is_none()
    }

    /// An account's windows as they stand now, fresh ones at 0 (budget.js:477).
    pub fn windows_now(&self, agent: &str, account: &str, now: i64) -> Vec<WindowNow> {
        let Some(acc) = self.get(agent, account) else { return Vec::new() };
        let mut out: Vec<WindowNow> = acc
            .windows
            .iter()
            .filter(|(id, w)| !stale(acc, id, w, now))
            .map(|(id, w)| {
                let f = fresh(w, now);
                WindowNow {
                    id: id.clone(),
                    label: window_label(id, w.ms),
                    used: if f { 0.0 } else { w.used },
                    resets_at: if f { None } else { w.resets_at },
                    ms: w.ms,
                }
            })
            .collect();
        out.sort_by_key(|w| rank(&w.id));
        out
    }

    pub(crate) fn view_windows(acc: &Acc, now: i64) -> Vec<WindowView> {
        let mut out: Vec<WindowView> = acc
            .windows
            .iter()
            .filter(|(id, w)| !stale(acc, id, w, now))
            .map(|(id, w)| {
                let f = fresh(w, now);
                let used = if f { 0.0 } else { w.used };
                let early_at = acc.early.get(id).filter(|e| !f && crate::windows::same_period(e.resets_at, w.resets_at)).map(|e| e.at);
                WindowView {
                    id: id.clone(),
                    label: window_label(id, w.ms),
                    used,
                    resets_at: if f { None } else { w.resets_at },
                    hit_at: if f { None } else { pace_of(used, w.resets_at, w.ms, now) },
                    ms: w.ms,
                    early_at,
                }
            })
            .collect();
        out.sort_by_key(|w| rank(&w.id));
        out
    }

    fn over_view(acc: &Acc, now: i64) -> Option<OverageView> {
        let list: Vec<&Over> = acc.over.iter().filter(|x| x.at > now - OVER_AGE).collect();
        let last = list.last()?;
        Some(OverageView { runs: u32::try_from(list.len()).unwrap_or(u32::MAX), at: last.at, kind: last.kind, sid: last.sid.clone() })
    }

    fn notices(acc: &Acc) -> Vec<WindowNotice> {
        acc.notices
            .values()
            .map(|n| WindowNotice {
                window: n.window.clone(),
                kind: n.kind,
                at: n.at,
                ms: n.ms,
                resets_at: n.resets_at,
                was_ms: n.was_ms,
                was_window: n.was_window.clone(),
                was_resets_at: n.was_resets_at,
                label: window_label(&n.window, n.ms),
                was_label: n.was_ms.filter(|m| *m != 0).map(|m| window_label(n.was_window.as_deref().unwrap_or_default(), Some(m))),
            })
            .collect()
    }

    /// For the page: each account with something to show, most-known windows first (budget.js:636).
    pub fn view(&self, agent: &str, now: i64) -> Vec<AccountView> {
        let mut out = Vec::new();
        for (account, acc) in self.of(agent) {
            let windows = Self::view_windows(acc, now);
            let notices = Self::notices(acc);
            let overage = Self::over_view(acc, now);
            let banked = if agent == "codex" { banked_at(acc.banked.as_ref(), now) } else { None };
            if windows.is_empty() && notices.is_empty() && overage.is_none() && banked.is_none() {
                continue;
            }
            let where_went = crate::traced::where_of(acc, &windows, now);
            out.push(AccountView {
                account: account.to_owned(),
                at: acc.at,
                windows,
                drain: drain_of(acc, now),
                notices,
                overage,
                banked,
                where_went,
            });
        }
        out
    }

    /// Drain watch's card for one account.
    pub fn drain(&self, agent: &str, account: &str, now: i64) -> Option<Drain> {
        drain_of(self.get(agent, account)?, now)
    }

    /// Ask near the limit's learned rate.
    pub fn rate(&self, agent: &str, account: &str, id: &str) -> Option<f64> {
        rate_of(self.get(agent, account)?, id)
    }

    /// A run on the account ended (budget.js:491): returns the drain it shows, if any.
    pub fn spend(&mut self, agent: &str, account: &str, units: f64, failed: bool, now: i64) -> Option<Drain> {
        let acc = self.touch(agent, account)?;
        if !spend(acc, units, failed, now) {
            return None;
        }
        drain_of(acc, now)
    }

    /// A run on the account was billed past its plan. Once per turn; a week is kept. Whether it was new.
    pub fn overage(&mut self, agent: &str, account: &str, kind: OverageKind, sid: Option<&str>, tid: Option<&str>, now: i64) -> bool {
        if agent.is_empty() {
            return false;
        }
        let acc = self.ensure(agent, account);
        acc.over.retain(|x| x.at > now - OVER_AGE);
        if acc.over.iter().any(|x| x.sid.as_deref() == sid && x.tid.as_deref() == tid) {
            return false;
        }
        acc.over.push(Over { at: now, kind, sid: sid.map(str::to_owned), tid: tid.map(str::to_owned) });
        if acc.over.len() > OVER_KEEP {
            let extra = acc.over.len() - OVER_KEEP;
            acc.over.drain(..extra);
        }
        true
    }

    /// The banked credits of each account of `agent` whose note is due (budget.js:389).
    pub fn banked_due(&self, agent: &str, now: i64) -> Vec<BankedDue> {
        let mut out = Vec::new();
        for (account, acc) in self.of(agent) {
            let count = banked_at(acc.banked.as_ref(), now).map_or(0, |b| b.count);
            for credit in banked_due(acc.banked.as_ref(), &acc.banked_sent, now) {
                out.push(BankedDue { account: account.to_owned(), credit, count });
            }
        }
        out
    }

    /// Its note went: never again for that credit. Entries go once their credit has expired.
    pub fn banked_sent(&mut self, agent: &str, account: &str, credit: &BankedCredit, now: i64) {
        let Some(acc) = self.touch(agent, account) else { return };
        acc.banked_sent.retain(|_, at| *at == 0 || *at > now);
        acc.banked_sent.insert(credit.id.clone(), credit.expires_at.unwrap_or(0));
    }

    /// Hide that window's drain card until a later run shows it again.
    pub fn dismiss_drain(&mut self, agent: &str, account: &str, id: &str, now: i64) -> bool {
        if !self.get(agent, account).is_some_and(|a| a.drain.contains_key(id)) {
            return false;
        }
        let Some(acc) = self.touch(agent, account) else { return false };
        acc.drain_seen.insert(id.to_owned(), now);
        true
    }

    /// × on a window's notice: gone until that window changes again.
    pub fn dismiss_notice(&mut self, agent: &str, account: &str, id: &str) -> bool {
        if !self.get(agent, account).is_some_and(|a| a.notices.contains_key(id)) {
            return false;
        }
        self.touch(agent, account).is_some_and(|acc| acc.notices.remove(id).is_some())
    }

    /// You said yes at `line` to a window: the next ask for it comes higher, until it resets.
    pub fn ack(&mut self, agent: &str, account: &str, id: &str, resets_at: Option<i64>, line: f64) {
        self.ensure(agent, account).acks.insert(id.to_owned(), Ack { resets_at: resets_at.filter(|r| *r != 0), line });
    }

    /// The line you said yes at for this window, while it hasn't reset; 0 when you haven't.
    pub fn acked(&self, agent: &str, account: &str, id: &str, resets_at: Option<i64>, now: i64) -> f64 {
        let Some(a) = self.get(agent, account).and_then(|acc| acc.acks.get(id)) else { return 0.0 };
        if a.line <= 0.0 || a.line.is_nan() || a.resets_at != resets_at.filter(|r| *r != 0) || a.resets_at.is_some_and(|r| r <= now) {
            return 0.0;
        }
        a.line
    }
}
