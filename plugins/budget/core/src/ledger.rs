//! Where it went (v1 budget.js:420-451): the turns that ran on an account between two of its reports.
//! Kept in memory: after a restart, what ran before it isn't traced.

use std::collections::BTreeMap;

/// Turns remembered per account between two reports.
const MAX_LEDGER: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub sid: String,
    pub tid: String,
    pub from: i64,
    pub to: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct Ledger {
    by_key: BTreeMap<String, Vec<Entry>>,
}

impl Ledger {
    /// A turn starts on an account (`key`: `agent@account`).
    pub fn begin(&mut self, key: &str, sid: &str, tid: &str, now: i64) {
        let list = self.by_key.entry(key.to_owned()).or_default();
        list.push(Entry { sid: sid.to_owned(), tid: tid.to_owned(), from: now, to: None });
        if list.len() > MAX_LEDGER {
            let extra = list.len() - MAX_LEDGER;
            list.drain(..extra);
        }
    }

    /// A turn ends, on whichever account it began on.
    pub fn end(&mut self, sid: &str, tid: &str, now: i64) {
        for list in self.by_key.values_mut() {
            if let Some(e) = list.iter_mut().rev().find(|x| x.sid == sid && x.tid == tid && x.to.is_none()) {
                e.to = Some(now);
            }
        }
    }

    /// Turns open on `key` right now.
    pub fn open(&self, key: &str) -> usize {
        self.by_key.get(key).map_or(0, |l| l.iter().filter(|e| e.to.is_none()).count())
    }

    /// Each turn's part of the time turns ran on the account since `since` (the last report), the
    /// parts summing to 1; the turns that ended are let go. Empty: the move happened outside wisp.
    /// A run that reports the moment it starts (no time yet) still counts: it's what moved it.
    #[allow(clippy::cast_precision_loss)]
    pub fn sharers(&mut self, key: &str, since: Option<i64>, now: i64) -> Vec<(Entry, f64)> {
        let list = self.by_key.remove(key).unwrap_or_default();
        let start = since.filter(|s| *s != 0).unwrap_or(now);
        let spans: Vec<(Entry, i64)> = list
            .iter()
            .map(|e| (e.clone(), (e.to.unwrap_or(now).min(now) - e.from.max(start)).max(0)))
            .filter(|(e, ms)| *ms > 0 || (e.to.is_none() && e.from >= start))
            .collect();
        let total: i64 = spans.iter().map(|(_, ms)| ms).sum();
        let n = spans.len() as f64;
        let kept: Vec<Entry> = list.into_iter().filter(|e| e.to.is_none()).collect();
        if !kept.is_empty() {
            self.by_key.insert(key.to_owned(), kept);
        }
        spans.into_iter().map(|(e, ms)| (e, if total > 0 { ms as f64 / total as f64 } else { 1.0 / n })).collect()
    }
}
