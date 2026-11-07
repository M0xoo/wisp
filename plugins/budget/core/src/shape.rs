//! Window changes (v1 budget.js:550-600, design/budget.md): a plan's window that appears, goes,
//! changes length or moves its reset. What wisp last saw of each window is kept in `acc.shape`, so a
//! restart doesn't announce anything again; each change leaves `acc.notices[id]` until it's dismissed
//! or the next change of that window replaces it. The first report of an account only sets what was seen.

use wisp_budget_api::{LimitWindow, NoticeKind};

use crate::state::{Acc, NoticeRow, Seen, Shape, Win};
use crate::windows::{H, MIN, same_period};

/// A window is gone once this many complete reports in a row, over at least `GONE_AGE`, left it out.
pub const GONE_MISS: u32 = 3;
pub const GONE_AGE: i64 = 6 * H;

/// A long window's reset moved off its schedule (its old reset plus whole periods), beyond Codex's
/// drift. The 5-hour window starts at your first message, so its reset always moves: never counted.
fn shifted(was: &Seen, cur: &Win) -> bool {
    let (Some(ms), Some(was_at), Some(at)) = (cur.ms, was.resets_at, cur.resets_at) else { return false };
    if ms < 24 * H || same_period(Some(was_at), Some(at)) {
        return false;
    }
    let r = (at - was_at).rem_euclid(ms);
    r.min(ms - r) > 10 * MIN
}

struct Notes<'a> {
    acc: &'a mut Acc,
    now: i64,
    added: bool,
}

impl Notes<'_> {
    fn row(&self, window: &str, kind: NoticeKind, ms: Option<i64>, resets_at: Option<i64>) -> NoticeRow {
        NoticeRow { window: window.to_owned(), kind, at: self.now, ms, resets_at, was_ms: None, was_window: None, was_resets_at: None }
    }
    fn note(&mut self, row: NoticeRow) {
        self.added = true;
        self.acc.notices.insert(row.window.clone(), row);
    }
}

type SeenMap = std::collections::BTreeMap<String, Seen>;

/// The window seen before under the same Codex slot and not in this report: a length change.
fn same_slot(seen: &SeenMap, w: &LimitWindow, all: &[LimitWindow]) -> Option<(String, Option<i64>)> {
    let slot = w.slot.as_ref()?;
    seen.iter().find(|(id, x)| x.slot.as_ref() == Some(slot) && **id != w.id && !all.iter().any(|y| y.id == **id)).map(|(id, x)| (id.clone(), x.ms))
}

/// One reported window against what was seen of it.
fn see_window(n: &mut Notes<'_>, seen: &mut SeenMap, w: &LimitWindow, all: &[LimitWindow], complete: bool, early: &[String], first: bool) {
    let Some(cur) = n.acc.windows.get(&w.id).copied() else { return }; // over MAX_WINDOWS
    let next = Seen { ms: cur.ms, resets_at: cur.resets_at, slot: w.slot.clone(), at: n.now, miss: 0 };
    match seen.get(&w.id) {
        None => {
            if let Some((oid, oms)) = (!first).then(|| same_slot(seen, w, all)).flatten() {
                seen.remove(&oid);
                n.acc.windows.remove(&oid);
                n.acc.notices.remove(&oid);
                let mut row = n.row(&w.id, NoticeKind::Length, cur.ms, cur.resets_at);
                row.was_ms = oms;
                row.was_window = Some(oid);
                n.note(row);
            } else if !first && !complete {
                return; // only a report of every window says it's new
            } else if !first {
                n.note(n.row(&w.id, NoticeKind::New, cur.ms, cur.resets_at));
            }
        }
        Some(was) => {
            if let (Some(a), Some(b)) = (was.ms, cur.ms)
                && (a - b).abs() > MIN
            {
                let mut row = n.row(&w.id, NoticeKind::Length, cur.ms, cur.resets_at);
                row.was_ms = Some(a);
                n.note(row);
            } else if shifted(was, &cur)
                && !early.contains(&w.id)
                && let (Some(ms), Some(at), Some(was_at)) = (cur.ms, cur.resets_at, was.resets_at)
            {
                // An early (banked) reset moves it too, but has its own line (earlyAt).
                let mut row = n.row(&w.id, NoticeKind::Reset, cur.ms, cur.resets_at);
                row.was_resets_at = Some(was_at + div_round(at - was_at, ms) * ms);
                n.note(row);
            }
        }
    }
    seen.insert(w.id.clone(), next);
}

/// JS `Math.round(a / b)` for integers (half rounds up).
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
fn div_round(a: i64, b: i64) -> i64 {
    (a as f64 / b as f64 + 0.5).floor() as i64
}

/// Records the report's windows against what was seen. Returns whether a notice was added.
pub fn shape(acc: &mut Acc, windows: &[LimitWindow], complete: bool, early: &[String], now: i64) -> bool {
    let mut sh = acc.shape.take().unwrap_or(Shape { since: now, n: 0, windows: std::collections::BTreeMap::new() });
    let first = sh.n == 0;
    sh.n = (sh.n + 1).min(2);
    let mut seen = std::mem::take(&mut sh.windows);
    let mut n = Notes { acc, now, added: false };
    let mut got: Vec<&str> = Vec::new();
    for w in windows.iter().filter(|w| !w.id.is_empty() && w.used.is_finite()) {
        got.push(&w.id);
        see_window(&mut n, &mut seen, w, windows, complete, early, first);
    }
    // Gone: missing from several reports that list every window, over hours (a report can skip one).
    if complete && !first {
        let ids: Vec<String> = seen.keys().cloned().collect();
        for id in ids {
            if got.contains(&id.as_str()) {
                continue;
            }
            let Some(x) = seen.get_mut(&id) else { continue };
            x.miss += 1;
            if x.miss < GONE_MISS || now - x.at < GONE_AGE {
                continue;
            }
            let (ms, resets_at) = (x.ms, x.resets_at);
            seen.remove(&id);
            n.acc.windows.remove(&id);
            n.note(n.row(&id, NoticeKind::Gone, ms, resets_at));
        }
    }
    let added = n.added;
    sh.windows = seen;
    acc.shape = Some(sh);
    added
}

/// A window the last complete report left out (Claude Ultra's gone 5-hour one), once its reset has
/// passed: there's nothing to show but an empty bar until `shape` calls it gone (budget.js:662).
pub fn stale(acc: &Acc, id: &str, w: &Win, now: i64) -> bool {
    acc.shape.as_ref().and_then(|s| s.windows.get(id)).is_some_and(|s| s.miss > 0) && w.resets_at.is_none_or(|r| r <= now)
}
