//! Plan budget's model (v1 server/budget.js:265-363 `Budget`), pure: how much of each account's usage
//! windows is gone, from what the CLI reports on every run. Time comes in as `now`. Every change
//! marks its account dirty, so the host writes only what moved.

use std::collections::{BTreeMap, BTreeSet};

use wisp_budget_api::{LimitsReport, Past, Period, Share};

use crate::ledger::Ledger;
use crate::shape::shape;
use crate::state::{Acc, Early, Win, acc_key, account_or_default};
use crate::windows::{MIN, known_ms, reset_early, same_period};

/// Closed periods remembered per window.
pub const PERIOD_KEEP: usize = 40;
/// A CLI that starts reporting dozens of windows doesn't grow the rows.
pub const MAX_WINDOWS: usize = 6;
/// Readings further apart than this may hide use outside wisp: nothing is learned across them.
pub const LEARN_GAP: i64 = 30 * MIN;

/// What one report changed, for the host to act on after it is written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Recorded {
    /// the run is billed past the plan
    pub past: Option<Past>,
    /// a number the page shows moved
    pub moved: bool,
    /// windows that reset before the time they last gave (a banked reset), once per period
    pub early: Vec<String>,
    /// each turn's part of a window's move: (session id, turn id, share)
    pub shares: Vec<(String, String, Share)>,
}

#[derive(Debug, Clone, Default)]
pub struct Budget {
    pub(crate) accounts: BTreeMap<(String, String), Acc>,
    pub(crate) ledger: Ledger,
    dirty: BTreeSet<(String, String)>,
}

fn key(agent: &str, account: &str) -> (String, String) {
    (agent.to_owned(), account_or_default(account).to_owned())
}

impl Budget {
    pub fn new() -> Self {
        Self::default()
    }

    /// Loads what the store kept (no account is dirty after).
    pub fn load(rows: impl IntoIterator<Item = (String, String, Acc)>) -> Self {
        let accounts = rows.into_iter().map(|(agent, account, acc)| ((agent, account), acc)).collect();
        Self { accounts, ..Self::default() }
    }

    pub fn get(&self, agent: &str, account: &str) -> Option<&Acc> {
        self.accounts.get(&key(agent, account))
    }

    pub(crate) fn ensure(&mut self, agent: &str, account: &str) -> &mut Acc {
        let k = key(agent, account);
        self.dirty.insert(k.clone());
        self.accounts.entry(k).or_default()
    }

    pub(crate) fn touch(&mut self, agent: &str, account: &str) -> Option<&mut Acc> {
        let k = key(agent, account);
        let acc = self.accounts.get_mut(&k)?;
        self.dirty.insert(k);
        Some(acc)
    }

    /// Every account of `agent`: (account, acc).
    pub fn of<'a>(&'a self, agent: &'a str) -> impl Iterator<Item = (&'a str, &'a Acc)> + 'a {
        self.accounts.iter().filter(move |((a, _), _)| a == agent).map(|((_, acc), v)| (acc.as_str(), v))
    }

    /// Every account wisp has readings for: (agent, account, acc).
    pub fn all(&self) -> impl Iterator<Item = (&str, &str, &Acc)> {
        self.accounts.iter().map(|((a, b), v)| (a.as_str(), b.as_str(), v))
    }

    /// The accounts changed since the last call, with their state, for the store.
    pub fn take_dirty(&mut self) -> Vec<(String, String, Acc)> {
        let dirty = std::mem::take(&mut self.dirty);
        dirty.into_iter().filter_map(|k| self.accounts.get(&k).map(|a| (k.0.clone(), k.1.clone(), a.clone()))).collect()
    }

    /// A turn starts on an account (where it went).
    pub fn begin(&mut self, agent: &str, account: &str, sid: &str, tid: &str, now: i64) {
        self.ledger.begin(&acc_key(agent, account), sid, tid, now);
    }

    /// A turn ends, on whichever account it began on.
    pub fn end(&mut self, sid: &str, tid: &str, now: i64) {
        self.ledger.end(sid, tid, now);
    }

    /// What a run (or a read) reported (budget.js:293-350).
    pub fn record(&mut self, agent: &str, account: &str, report: &LimitsReport, now: i64) -> Recorded {
        let mut out = Recorded::default();
        if agent.is_empty() {
            return out;
        }
        if report.overage {
            out.past = Some(Past::Extra);
        }
        if let Some(b) = &report.banked {
            let acc = self.ensure(agent, account);
            let was = acc.banked.as_ref().map(|x| (x.count, x.credits.clone()));
            acc.banked = Some(wisp_budget_api::Banked { count: b.count, credits: b.credits.clone(), at: Some(now) });
            out.moved |= was != Some((b.count, b.credits.clone()));
        }
        if let Some(credits) = report.credits.filter(|c| c.is_finite()) {
            let acc = self.ensure(agent, account);
            if acc.credits.is_some_and(|was| credits < was - 1e-9) {
                out.past = Some(Past::Credits);
            }
            acc.credits = Some(credits);
        }
        if report.windows.is_empty() {
            return out;
        }
        self.windows_of(agent, account, report, now, &mut out);
        out
    }

    fn windows_of(&mut self, agent: &str, account: &str, report: &LimitsReport, now: i64, out: &mut Recorded) {
        let since = self.get(agent, account).and_then(|a| a.at);
        let share = self.ledger.sharers(&acc_key(agent, account), since, now);
        let account = account_or_default(account).to_owned();
        let acc = self.ensure(agent, &account);
        // Readings close together come from runs at work: what moved in between is theirs. A read is
        // no run's report: chats it sees aren't the next run's.
        let close = !report.read && acc.at.is_some_and(|at| at != 0 && now - at <= LEARN_GAP);
        for w in report.windows.iter().filter(|w| !w.id.is_empty() && w.used.is_finite()) {
            let was = acc.windows.get(&w.id).copied();
            if was.is_none() && acc.windows.len() >= MAX_WINDOWS {
                continue;
            }
            let next = Win { used: w.used.clamp(0.0, 1.0), resets_at: w.resets_at.filter(|r| *r != 0), ms: w.ms.filter(|m| *m != 0).or_else(|| known_ms(&w.id)) };
            if let Some(was) = was
                && close
                && was.resets_at == next.resets_at
                && next.used > was.used
            {
                let d = next.used - was.used;
                acc.learn.entry(w.id.clone()).or_default().du += d;
                *acc.run.entry(w.id.clone()).or_insert(0.0) += d; // this run's, until spend()
            }
            if was.is_none_or(|was| pct100(was.used) != pct100(next.used) || was.resets_at != next.resets_at) {
                out.moved = true;
            }
            if reset_early(was.map(|x| (x.used, x.resets_at)), (next.used, next.resets_at), now) {
                acc.early.insert(w.id.clone(), Early { at: now, resets_at: next.resets_at });
                out.early.push(w.id.clone());
            }
            // How far it moved since the last report: in a new period, all of what's used now.
            let d = match was {
                Some(was) if same_period(was.resets_at, next.resets_at) => next.used - was.used,
                Some(was) if was.resets_at.is_some_and(|r| r <= now) => next.used,
                None | Some(_) => 0.0,
            };
            if d > 0.0 {
                for (e, part) in &share {
                    let s = Share { agent: agent.to_owned(), account: account.clone(), window: w.id.clone(), used: d * part, resets_at: next.resets_at };
                    out.shares.push((e.sid.clone(), e.tid.clone(), s));
                }
            }
            if let Some(was) = was
                && was.resets_at.is_some()
                && !same_period(was.resets_at, next.resets_at)
            {
                close_period(acc, &w.id, was, now);
            }
            acc.windows.insert(w.id.clone(), next);
        }
        if shape(acc, &report.windows, report.complete, &out.early, now) {
            out.moved = true;
        }
        acc.at = Some(now);
    }

    /// A window's closed periods, oldest first.
    pub fn periods(&self, agent: &str, account: &str, id: &str) -> Vec<Period> {
        self.get(agent, account).and_then(|a| a.periods.get(id)).cloned().unwrap_or_default()
    }

    /// When the account's windows were last read.
    pub fn reading_at(&self, agent: &str, account: &str) -> Option<i64> {
        self.get(agent, account).and_then(|a| a.at)
    }
}

#[allow(clippy::cast_possible_truncation)]
fn pct100(x: f64) -> i64 {
    (x * 100.0).round() as i64
}

/// A period is over: keep its last reading (budget.js:354-363). Runs at the same time can report out
/// of order, so the same period can close twice: the higher reading stands, and one that reached its
/// reset clears `cut`.
fn close_period(acc: &mut Acc, id: &str, was: Win, now: i64) {
    let Some(resets_at) = was.resets_at else { return };
    let list = acc.periods.entry(id.to_owned()).or_default();
    let cut = resets_at > now;
    if let Some(e) = list.iter_mut().find(|x| same_period(Some(x.resets_at), Some(resets_at))) {
        e.used = e.used.max(was.used);
        if !cut {
            e.cut = false;
        }
    } else {
        list.push(Period { resets_at, ms: was.ms, used: was.used, cut });
    }
    list.sort_by_key(|p| p.resets_at);
    if list.len() > PERIOD_KEEP {
        let extra = list.len() - PERIOD_KEEP;
        list.drain(..extra);
    }
}
