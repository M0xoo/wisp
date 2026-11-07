//! What Auto believes about an arm (v1 Router #prior, #counts, #levels, estimate, taste, picks): a
//! Beta posterior stacked from the benchmarks, your history on every kind of task and on this kind,
//! and the same model at its other levels; and your taste, the share of your own picks.

use wisp_router_api::{LEVELS, split_key};

use crate::keys::{canon, family, level_of, round, stem_key};
use crate::priors::{PriorArm, shipped};
use crate::state::RouterState;

const PRIOR_CAP: f64 = 8.0; // benchmarks count as at most this many tasks, so yours soon outweigh them
const ALL_WEIGHT: f64 = 0.5; // your history on other kinds of task counts half
const LEVEL_WEIGHT: f64 = 0.5; // the same model's record at its other thinking levels counts half
pub const HALF_LIFE_MS: f64 = 30.0 * 86_400_000.0; // models change: older outcomes fade
pub const TASTE_HALF_LIFE_MS: f64 = 60.0 * 86_400_000.0; // habits change slower than models do

/// Thinking levels against medium: a shift in the chance of success and multipliers on cost and
/// time, from Anthropic's Opus 5.5 sweep (v1 router.js:82); only for models the benchmarks don't
/// cover, and outcomes take over.
pub fn effort_of(e: &str) -> (f64, f64, f64) {
    use crate::priors_build::{level_cost, level_time};
    let chance = match e {
        "minimal" => -0.08,
        "low" => -0.05,
        "high" => 0.03,
        "xhigh" => 0.04,
        "max" => 0.06,
        _ => 0.0,
    };
    let e = if e.is_empty() { "medium" } else { e };
    (chance, level_cost(e), level_time(e))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Prior {
    pub a: f64,
    pub b: f64,
    pub usd: f64,
    pub min: f64,
    pub from: Vec<String>,
    pub inherited: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub a: f64,
    pub b: f64,
    pub mean: f64,
    /// outcomes on this kind of task
    pub n: u32,
    /// outcomes on every kind
    pub n_all: u32,
    pub usd: f64,
    pub minutes: f64,
    /// the benchmarks measured this arm (or its model at another level)
    pub prior: bool,
    /// the benchmarks measured its family (a new version)
    pub inherited: bool,
    pub from: Vec<String>,
}

fn level_index(l: &str) -> i64 {
    LEVELS.iter().position(|x| *x == l).and_then(|i| i64::try_from(i).ok()).unwrap_or(-1)
}

/// The same model measured at another level, shifted by how hard this one thinks.
fn shift(p: &PriorArm, from: &str, lvl: &str, inherited: bool) -> Prior {
    let n = p.a + p.b;
    let s = if inherited { (4.0 / n).min(1.0) } else { 1.0 };
    let (ec, eu, em) = effort_of(lvl);
    let (fc, fu, fm) = effort_of(from);
    let mean = (p.a / n + ec - fc).clamp(0.05, 0.95);
    Prior { a: mean * n * s, b: (1.0 - mean) * n * s, usd: p.usd * (eu / fu), min: p.min * (em / fm), from: p.from.clone(), inherited }
}

/// What the benchmarks say about an arm: its own row, else the same model at another level shifted
/// by how hard it thinks, else its family's (a new version) at less weight.
pub fn prior_of(k: &str) -> Option<Prior> {
    let sh = shipped();
    let c = canon(k);
    if let Some(p) = sh.priors.arms.get(&c) {
        return Some(Prior { a: p.a, b: p.b, usd: p.usd, min: p.min, from: p.from.clone(), inherited: false });
    }
    let stem = stem_key(k);
    let lvl = level_of(k);
    let at = level_index(&lvl);
    // the closest level wins; on a tie the first in the file (v1's stable sort)
    let closest = |inherit: bool| {
        let fam = family(&stem);
        let agent = split_key(&c).agent;
        sh.keys
            .iter()
            .filter(|x| if inherit { x.agent == agent && x.family == fam } else { x.stem == stem })
            .min_by_key(|x| (level_index(&x.level) - at).abs())
            .and_then(|x| sh.priors.arms.get(&x.key).map(|p| shift(p, &x.level, &lvl, inherit)))
    };
    closest(false).or_else(|| closest(true))
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Counts {
    pub a: f64,
    pub b: f64,
    pub n: u32,
    pub usd: Option<f64>,
    pub ms: Option<f64>,
}

/// Decayed counts for (kind, arm) from this user's routes; every name of the run counts.
pub fn counts(st: &RouterState, kind: &str, key: &str, now: i64) -> Counts {
    counts_canon(st, kind, &canon(key), now)
}

#[allow(clippy::cast_precision_loss)]
fn counts_canon(st: &RouterState, kind: &str, c: &str, now: i64) -> Counts {
    let (mut a, mut b, mut n, mut usd, mut usd_n, mut ms) = (0.0, 0.0, 0u32, 0.0, 0u32, 0.0);
    for (_, s) in st.stats_of(kind, c) {
        let at = if s.at == 0 { now } else { s.at };
        let f = 0.5f64.powf((now - at) as f64 / HALF_LIFE_MS);
        a += s.a * f;
        b += s.b * f;
        n += s.n;
        usd += s.usd;
        usd_n += s.usd_n;
        ms += s.ms;
    }
    Counts { a, b, n, usd: (usd_n > 0).then(|| usd / f64::from(usd_n)), ms: (n > 0).then(|| ms / f64::from(n)) }
}

/// The same model at its other thinking levels, on this kind of task.
fn levels(st: &RouterState, kind: &str, key: &str, now: i64) -> (f64, f64) {
    let c = canon(key);
    let stem = stem_key(key);
    st.canons_of(kind).filter(|k| *k != c && stem_key(k) == stem).fold((0.0, 0.0), |(a, b), k| {
        let x = counts_canon(st, kind, k, now);
        (a + x.a, b + x.b)
    })
}

/// Beta posterior for an arm on a kind of task, plus what it usually costs.
pub fn estimate(st: &RouterState, kind: &str, key: &str, now: i64) -> Estimate {
    let p = prior_of(key);
    let (pa, pb) = p.as_ref().map_or((1.0, 1.0), |p| (p.a, p.b));
    let scale = (PRIOR_CAP / (pa + pb).max(1.0)).min(1.0);
    let mine = counts(st, kind, key, now);
    let all = counts(st, "*", key, now);
    let kin = levels(st, kind, key, now);
    // a flat Beta(1, 1) underneath only when the benchmarks say nothing: it would pull every
    // measured chance toward a coin flip
    let flat = if p.is_some() { 0.0 } else { 1.0 };
    let a = flat + pa * scale + (all.a - mine.a) * ALL_WEIGHT + kin.0 * LEVEL_WEIGHT + mine.a;
    let b = flat + pb * scale + (all.b - mine.b) * ALL_WEIGHT + kin.1 * LEVEL_WEIGHT + mine.b;
    // cost and time: the benchmarks' guess, pulled toward what this user's runs actually cost
    let blend = |own: Option<f64>, n: u32, guess: f64| own.map_or(guess, |o| (guess * 3.0 + o * f64::from(n)) / (3.0 + f64::from(n)));
    let usd = blend(all.usd, all.n, p.as_ref().map_or(0.3, |p| p.usd));
    let minutes = blend(all.ms.map(|m| m / 60_000.0), all.n, p.as_ref().map_or(5.0, |p| p.min));
    let mean = if a + b > 0.0 { a / (a + b) } else { 0.5 };
    let inherited = p.as_ref().is_some_and(|p| p.inherited);
    Estimate { a, b, mean, n: mine.n, n_all: all.n, usd: round(usd, 4), minutes, prior: p.is_some() && !inherited, inherited, from: p.map(|p| p.from).unwrap_or_default() }
}

#[allow(clippy::cast_precision_loss)]
fn decayed(n: f64, at: i64, now: i64) -> f64 {
    n * 0.5f64.powf((now - at).max(0) as f64 / TASTE_HALF_LIFE_MS)
}

/// Your share of picks for this run on this kind of task (the same model at another level counts
/// half); with few picks on this kind it leans on your picks overall. 0 when you never picked it.
pub fn taste(st: &RouterState, kind: &str, key: &str, now: i64) -> f64 {
    let c = canon(key);
    let stem = stem_key(key);
    let share = |t: &str| {
        let (mut same, mut near, mut all) = (0.0, 0.0, 0.0);
        for (k, x) in st.taste_of(t) {
            let v = decayed(x.n, x.at, now);
            all += v;
            if k == c {
                same += v;
            } else if stem_key(k) == stem {
                near += v;
            }
        }
        (if all > 0.0 { (same + 0.5 * near) / all } else { 0.0 }, all)
    };
    let (here, n) = share(kind);
    let w = (n / 5.0).min(1.0);
    round(w * here + (1.0 - w) * share("*").0, 3)
}

/// How many times you picked this run yourself: (on this kind, overall).
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn picks(st: &RouterState, kind: &str, key: &str) -> (u32, u32) {
    let c = canon(key);
    let n = |t: &str| st.taste(t, &c).map_or(0, |x| x.n.round().max(0.0) as u32);
    (n(kind), n("*"))
}

/// The name you launch this run by (`claude:` rather than `claude:opus:medium`).
pub fn form_of(st: &RouterState, c: &str) -> Option<String> {
    let raw = &st.taste("*", c)?.raw;
    // the most used; on a tie the first (v1 iterates in insertion order, here in key order)
    raw.iter().fold(None::<(&String, u32)>, |best, (k, v)| match best {
        Some((_, n)) if n >= *v => best,
        _ => Some((k, *v)),
    })
    .map(|(k, _)| k.clone())
}
