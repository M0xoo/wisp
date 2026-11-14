//! Try it two ways: each run's plan share (v1 web/js/compare-metrics.js planShares). wisp splits a
//! window's move among the turns running on the account by time (`Ledger::sharers`), so runs that
//! overlap on one account can't each show a true share: only their total is known. Pooled is read
//! from the turns, not from their shares: a share lands late, and a turn that has none yet was still
//! running beside the others.

use crate::receipt::{longest_first, pct, window_name};
use crate::work::{RunLike, TurnLike, by_age, letter, listed, own, turn_plan, work_of};

pub const ESTIMATE: &str = "An estimate. When runs overlap on one account, wisp can only trace what they took together, so this splits the total by each run's cost.";
pub const NO_COST: &str = "Not every run reported a cost, so wisp can't split the total between them.";
pub const DASH: &str = "—";

struct Span<'a> {
    t: &'a TurnLike,
    key: String,
    from: i64,
    to: i64,
    cost: Option<f64>,
    pooled: bool,
}

struct Run<'a> {
    i: usize,
    turns: Vec<Span<'a>>,
    /// window → share, in the order first seen
    solo: Vec<(String, f64)>,
}

impl Run<'_> {
    fn add_solo(&mut self, window: &str, used: f64) {
        match self.solo.iter_mut().find(|(w, _)| w == window) {
            Some((_, u)) => *u += used,
            None => self.solo.push((window.to_owned(), used)),
        }
    }
    fn solo_of(&self, window: &str) -> f64 {
        self.solo.iter().find(|(w, _)| w == window).map_or(0.0, |(_, u)| *u)
    }
}

struct Pool {
    key: String,
    window: String,
    used: f64,
    /// (run index, its pooled spans' indexes)
    members: Vec<(usize, Vec<usize>)>,
    split: bool,
    costs: f64,
    waiting: bool,
}

fn share_key(agent: &str, account: &str) -> String {
    format!("{agent}@{}", if account.is_empty() { "default" } else { account })
}

fn runs_of<'a>(sessions: &'a [RunLike], now: i64) -> Vec<Run<'a>> {
    let sorted: Vec<&RunLike> = by_age(&sessions.iter().collect::<Vec<_>>(), |s| s.created_at.unwrap_or(0));
    let mut runs: Vec<Run<'a>> = sorted
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let work = work_of(s);
            let turns = own(s)
                .into_iter()
                .filter_map(|(ti, t)| {
                    let from = t.started_at?;
                    let agent = t.agent.as_deref().filter(|a| !a.is_empty()).or(s.agent.as_deref()).unwrap_or_default();
                    let account = t.account.as_deref().filter(|a| !a.is_empty()).or(s.account.as_deref()).unwrap_or_default();
                    Some(Span {
                        t,
                        key: share_key(agent, account),
                        from,
                        to: t.ended_at.unwrap_or(now),
                        cost: work.get(&ti).and_then(|w| w.cost),
                        pooled: false,
                    })
                })
                .collect();
            Run { i, turns, solo: Vec::new() }
        })
        .collect();
    let overlap = |a: &Span<'_>, b: &Span<'_>| a.key == b.key && a.from < b.to && b.from < a.to;
    let flags: Vec<Vec<bool>> = runs
        .iter()
        .enumerate()
        .map(|(ri, r)| {
            r.turns.iter().map(|x| runs.iter().enumerate().any(|(oi, o)| oi != ri && o.turns.iter().any(|y| overlap(x, y)))).collect()
        })
        .collect();
    for (r, f) in runs.iter_mut().zip(flags) {
        for (x, p) in r.turns.iter_mut().zip(f) {
            x.pooled = p;
        }
    }
    runs
}

fn pools_of(runs: &mut [Run<'_>]) -> Vec<Pool> {
    let mut pools: Vec<Pool> = Vec::new();
    for r in runs.iter_mut() {
        let mut solo: Vec<(String, f64)> = Vec::new();
        for x in &r.turns {
            for p in turn_plan(x.t).into_iter().filter(|p| !p.window.is_empty() && p.used > 0.0) {
                if !x.pooled {
                    solo.push((p.window, p.used));
                    continue;
                }
                let key = share_key(&p.agent, &p.account);
                match pools.iter_mut().find(|q| q.key == key && q.window == p.window) {
                    Some(q) => q.used += p.used,
                    None => pools.push(Pool {
                        key,
                        window: p.window,
                        used: p.used,
                        members: Vec::new(),
                        split: false,
                        costs: 0.0,
                        waiting: false,
                    }),
                }
            }
        }
        for (w, u) in solo {
            r.add_solo(&w, u);
        }
    }
    let mut shared = Vec::new();
    for mut pool in pools {
        for (ri, r) in runs.iter().enumerate() {
            let mine: Vec<usize> = (0..r.turns.len())
                .filter(|&si| {
                    let x = &r.turns[si];
                    x.pooled
                        && (x.key == pool.key
                            || turn_plan(x.t).iter().any(|p| p.window == pool.window && share_key(&p.agent, &p.account) == pool.key))
                })
                .collect();
            if !mine.is_empty() {
                pool.members.push((ri, mine));
            }
        }
        // One turn's entry on an account the others never touched: nothing to split.
        if pool.members.len() < 2 {
            for (ri, _) in &pool.members {
                runs[*ri].add_solo(&pool.window, pool.used);
            }
            continue;
        }
        let spans: Vec<&Span<'_>> = pool.members.iter().flat_map(|(ri, ss)| ss.iter().map(|si| &runs[*ri].turns[*si])).collect();
        pool.costs = spans.iter().map(|x| x.cost.unwrap_or(0.0)).sum();
        pool.split = pool.costs > 0.0 && spans.iter().all(|x| x.cost.is_some());
        pool.waiting = spans.iter().any(|x| x.cost.is_none() && x.t.status() == "running"); // its cost is on the way
        shared.push(pool);
    }
    shared
}

/// One Plan cell: its text and tip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub text: String,
    pub tip: String,
}

fn cell_of(ri: usize, r: &Run<'_>, shared: &[Pool]) -> Cell {
    let mine: Vec<&Pool> = shared.iter().filter(|p| p.members.iter().any(|(m, _)| *m == ri)).collect();
    let mut windows: Vec<String> = Vec::new();
    for w in r.solo.iter().map(|(w, _)| w.clone()).chain(mine.iter().map(|p| p.window.clone())) {
        if !windows.contains(&w) {
            windows.push(w);
        }
    }
    windows.sort_by(|a, b| longest_first(a, b));
    let Some(window) = windows.first() else { return Cell { text: DASH.into(), tip: String::new() } };
    let name = window_name(window);
    let here: Vec<&&Pool> = mine.iter().filter(|p| &p.window == window).collect();
    let solo = r.solo_of(window);
    if here.is_empty() {
        return Cell { text: format!("{} of {name}", pct(solo)), tip: String::new() };
    }
    if let Some(stuck) = here.iter().find(|p| !p.split) {
        return Cell { text: DASH.into(), tip: if stuck.waiting { String::new() } else { NO_COST.into() } };
    }
    let part: f64 = here
        .iter()
        .map(|p| {
            let cost: f64 =
                p.members.iter().filter(|(m, _)| *m == ri).flat_map(|(_, ss)| ss.iter().map(|si| r.turns[*si].cost.unwrap_or(0.0))).sum();
            p.used * cost / if p.costs == 0.0 { 1.0 } else { p.costs }
        })
        .sum();
    Cell { text: format!("≈{} of {name}", pct(solo + part)), tip: ESTIMATE.into() }
}

/// Plan cells, in `createdAt` order, and the line with what overlapping runs took together.
pub fn plan_shares(sessions: &[RunLike], now: i64) -> (Vec<Cell>, String) {
    let mut runs = runs_of(sessions, now);
    let mut shared = pools_of(&mut runs);
    let cells = runs.iter().enumerate().map(|(ri, r)| cell_of(ri, r, &shared)).collect();
    // One line per account, on its longest window, as on a cell.
    shared.sort_by(|a, b| longest_first(&a.window, &b.window));
    let mut longest: Vec<&Pool> = Vec::new();
    for p in &shared {
        if !longest.iter().any(|q| q.key == p.key) {
            longest.push(p);
        }
    }
    let who = |p: &Pool| {
        let k = p.members.len();
        if k < runs.len() {
            let mut letters: Vec<String> = p.members.iter().map(|(ri, _)| letter(runs[*ri].i)).collect();
            letters.sort();
            listed(&letters)
        } else if k == 2 {
            "Both runs".to_owned()
        } else {
            format!("All {k} runs")
        }
    };
    let total =
        longest.iter().map(|p| format!("{} took {} of {}.", who(p), pct(p.used), window_name(&p.window))).collect::<Vec<_>>().join(" ");
    (cells, total)
}
