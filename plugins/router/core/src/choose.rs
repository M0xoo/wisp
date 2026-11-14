//! Picking an arm (v1 Router.choose, levelUp, whyOf; router.js:477-617). Each arm's chance of
//! success is drawn (Thompson-style) unless the pick is a preview, important or exploring is off;
//! your taste is added; the best value for the goal wins: value × chance − expected $ − a price on
//! your waiting time. Never pick and Prefer rules come on top. A better arm that isn't your habit is
//! offered, not run. A pick only reads: arms the router hasn't seen are judged as the next sync
//! would mark them.

use std::collections::{BTreeMap, BTreeSet};

use wisp_router_api::{AgentInfo, ChooseArgs, GOALS, LEVELS, Pick, Route, RouteAlt, Suggest, arm_key, is_goal, split_key};

use crate::estimate::{Estimate, estimate, form_of, picks, prior_of, taste};
use crate::keys::{
    Candidate, base_of, by_named_level, candidates, canon, effort_label, level_of, levels_for, round, rule_matches, stem_key, tier_of,
};
use crate::math::{Mulberry32, Rng, beta_sample};
use crate::state::{Cool, Life, RouterState};

const MINUTE_USD: f64 = 0.05; // what a minute of waiting costs you, in the utility
const TASTE: f64 = 0.25; // your habit is worth up to this much chance of success
const PREFER: f64 = 0.1; // a Prefer rule from Settings
const SUGGEST_MARGIN: f64 = 0.04; // how much better (in chance) an arm must look to be suggested
const DRAWS: u32 = 200;

/// Settings → Auto: what a pick uses for anything the caller left out (v1 `router.prefs()`).
#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    pub explore: bool,
    pub allowed: Option<Vec<String>>,
    pub blocked: Vec<String>,
    pub prefer: Vec<String>,
    pub habits: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { explore: true, allowed: None, blocked: Vec::new(), prefer: Vec::new(), habits: true }
    }
}

/// A harness (`agent:*`) or a model at every level cooling down after a limit, if it still is. An
/// expired entry never hides a live one (v1 read the first entry found, live or not).
pub fn cooling<'a>(st: &'a RouterState, key: &str, now: i64) -> Option<&'a Cool> {
    let agent = format!("{}:*", split_key(key).agent);
    [key.to_owned(), base_of(key), base_of(&canon(key)), agent].into_iter().find_map(|k| st.cooling.get(&k).filter(|c| c.until > now))
}

/// An arm's state; one the router hasn't seen is what the next sync would make it.
pub fn arm_state(st: &RouterState, base: &str) -> Life {
    match st.arms.get(base) {
        Some(a) => a.state,
        None if st.arms.is_empty() || prior_of(base).is_some() => Life::Ready,
        None => Life::New,
    }
}

#[derive(Debug, Clone)]
pub struct Arm {
    pub c: Candidate,
    pub effort: String,
    pub base: String,
    pub est: Estimate,
    pub state: Life,
    pub taste: f64,
    pub preferred: bool,
}

struct Opts<'a> {
    goal: &'static str,
    explore: bool,
    allowed: Option<&'a [String]>,
    blocked: &'a [String],
    prefer: &'a [String],
    habits: bool,
}

fn opts<'a>(a: &'a ChooseArgs, p: &'a Prefs) -> Opts<'a> {
    let goal = a.goal.as_deref().filter(|g| is_goal(g)).and_then(|g| GOALS.iter().find(|x| x.0 == g)).map_or("balanced", |x| x.0);
    let allowed = match &a.allowed {
        Some(x) => x.as_deref(),
        None => p.allowed.as_deref(),
    };
    Opts {
        goal,
        explore: a.explore.unwrap_or(p.explore),
        allowed,
        blocked: a.blocked.as_deref().unwrap_or(&p.blocked),
        prefer: a.prefer.as_deref().unwrap_or(&p.prefer),
        habits: a.habits.unwrap_or(p.habits),
    }
}

fn goal_value(goal: &str) -> f64 {
    GOALS.iter().find(|g| g.0 == goal).map_or(5.0, |g| g.2)
}

/// Every arm the goal allows: installed, not taken, at the goal's levels, not ruled out.
fn arms_of(st: &RouterState, now: i64, a: &ChooseArgs, o: &Opts, agents: &[AgentInfo], kind: &str) -> Vec<Arm> {
    let out: BTreeSet<String> = a.exclude.iter().map(|k| stem_key(k)).collect();
    let known: BTreeSet<String> = st.arms.keys().cloned().collect();
    let usable: Vec<Candidate> = candidates(agents, &known)
        .into_iter()
        .filter(|c| (!a.need_delegate || c.delegates) && o.allowed.is_none_or(|al| al.contains(&c.agent)))
        .collect();
    let frontier_only = o.goal == "best" && usable.iter().any(|c| tier_of(&c.key) >= 3);
    let defaults = &crate::priors::shipped().priors.defaults;
    let mut levelled = Vec::new();
    for c in by_named_level(usable.into_iter().filter(|c| !out.contains(&stem_key(&c.key))).collect(), o.goal) {
        if frontier_only && tier_of(&c.key) < 3 {
            continue;
        }
        let def = defaults.get(&base_of(&canon(&c.key))).map_or("", String::as_str);
        for effort in levels_for(&c.efforts, o.goal, def) {
            let key = arm_key(&c.agent, &c.model, &effort);
            if o.blocked.iter().any(|r| rule_matches(r, &key, Some(kind))) {
                continue;
            }
            let label = if effort.is_empty() { c.label.clone() } else { format!("{} · {}", c.label, effort_label(&effort)) };
            levelled.push((Candidate { key, label, ..c.clone() }, effort, c.key.clone()));
        }
    }
    // One run under several names (claude: and claude:opus:medium): keep the one you launch by,
    // else the model named outright (the harness default may not be what the benchmarks assume).
    let named = |k: &str| usize::from(!split_key(k).model.is_empty());
    let mut by_canon: BTreeMap<String, usize> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for (i, (c, ..)) in levelled.iter().enumerate() {
        let k = canon(&c.key);
        let form = form_of(st, &k);
        let better = match by_canon.get(&k) {
            None => true,
            Some(&h) => {
                let have = &levelled[h].0.key;
                Some(&c.key) == form.as_ref()
                    || (Some(have) != form.as_ref()
                        && (named(&c.key) > named(have) || (named(&c.key) == named(have) && c.key.len() < have.len())))
            }
        };
        if better {
            if !by_canon.contains_key(&k) {
                order.push(k.clone());
            }
            by_canon.insert(k, i);
        }
    }
    order
        .iter()
        .filter_map(|k| by_canon.get(k))
        .map(|&i| {
            let (c, effort, base) = levelled[i].clone();
            let est = estimate(st, kind, &c.key, now);
            let taste = if o.habits { taste(st, kind, &c.key, now) } else { 0.0 };
            let preferred = o.prefer.iter().any(|r| rule_matches(r, &c.key, Some(kind)));
            Arm { state: arm_state(st, &base), c, effort, base, est, taste, preferred }
        })
        .collect()
}

/// Balanced and Best run on the strongest tier that can run now; an arm that keeps failing is out.
fn narrow(arms: Vec<Arm>, min_tier: u8, goal: &str) -> Vec<Arm> {
    let top = arms.iter().map(|x| tier_of(&x.c.key)).max().unwrap_or(0);
    let floor_tier = min_tier.max(if goal == "cheap" { 0 } else { top });
    let mut out = arms;
    for t in (1..=floor_tier).rev() {
        if out.iter().any(|x| tier_of(&x.c.key) >= t) {
            out.retain(|x| tier_of(&x.c.key) >= t);
            break;
        }
    }
    let keeps = |x: &Arm| !(x.est.n >= 5 && x.est.mean < 0.35);
    if out.iter().any(keeps) {
        out.retain(keeps);
    }
    out
}

fn utility(v: f64, x: &Arm, theta: f64, own: bool) -> f64 {
    let bonus = if own { TASTE * x.taste + if x.preferred { PREFER } else { 0.0 } } else { 0.0 };
    v * (theta + bonus) - x.est.usd - MINUTE_USD * x.est.minutes
}

/// One draw: the best utility, each chance drawn (or the mean when `fixed`). New arms on probation
/// aren't run behind your back: they're suggested.
fn draw(arms: &[Arm], v: f64, fixed: bool, r: &mut dyn Rng) -> usize {
    let pool: Vec<usize> = (0..arms.len()).filter(|&i| arms[i].state != Life::New || arms[i].taste > 0.0).collect();
    let list: Vec<usize> = if pool.is_empty() { (0..arms.len()).collect() } else { pool };
    let mut best = list.first().copied().unwrap_or(0);
    let mut bu = f64::NEG_INFINITY;
    for i in list {
        let x = &arms[i];
        let theta = if fixed { x.est.mean } else { beta_sample(x.est.a, x.est.b, r) };
        let u = utility(v, x, theta, true);
        if u > bu {
            best = i;
            bu = u;
        }
    }
    best
}

fn alt(x: &Arm) -> RouteAlt {
    RouteAlt {
        key: x.c.key.clone(),
        agent: x.c.agent.clone(),
        model: x.c.model.clone(),
        effort: x.effort.clone(),
        label: x.c.label.clone(),
        chance: round(x.est.mean, 2),
        usd: round(x.est.usd, 2),
    }
}

/// Pick an arm for a task, or `None` when nothing allowed can run now. `here`: the harnesses used
/// when `a.agents` is absent.
pub fn choose(st: &RouterState, now: i64, a: &ChooseArgs, here: &[AgentInfo], prefs: &Prefs, rng: &mut dyn Rng) -> Option<Pick> {
    let o = opts(a, prefs);
    let (guess_kind, guess_size) = crate::classify::task(&a.prompt, a.attachments);
    let scouted = a.scouted.as_ref();
    let kind = scouted.and_then(|s| s.kind.clone()).filter(|k| !k.is_empty()).unwrap_or_else(|| guess_kind.to_owned());
    let size = scouted.and_then(|s| s.size.clone()).filter(|k| !k.is_empty()).unwrap_or_else(|| guess_size.to_owned());
    let agents = a.agents.as_deref().unwrap_or(here);
    let mut arms = arms_of(st, now, a, &o, agents, &kind);
    // everything allowed at its limit: nothing to route to now
    arms.retain(|x| cooling(st, &x.c.key, now).is_none());
    if arms.is_empty() {
        return None;
    }
    let arms = narrow(arms, a.min_tier, o.goal);
    let v = goal_value(o.goal);
    let fixed = a.preview || a.important || !o.explore;
    let pinned = a.pin.as_ref().and_then(|p| arms.iter().position(|x| &x.c.key == p || canon(&x.c.key) == canon(p)));
    let pick_i = pinned.unwrap_or_else(|| draw(&arms, v, fixed, rng));
    // how likely this pick was: logged so the router's own choices can be corrected for later
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mut sim = Mulberry32::new((rng.next_f64() * 2_147_483_648.0).floor() as u32);
    let hits =
        if fixed || pinned.is_some() { DRAWS } else { (0..DRAWS).filter(|_| draw(&arms, v, false, &mut sim) == pick_i).map(|_| 1).sum() };
    let mut by_mean: Vec<usize> = (0..arms.len()).collect();
    by_mean.sort_by(|&p, &q| utility(v, &arms[q], arms[q].est.mean, true).total_cmp(&utility(v, &arms[p], arms[p].est.mean, true)));
    let pick = &arms[pick_i];
    let explored = pinned.is_none() && by_mean.first() != Some(&pick_i);
    let suggest = if o.explore { suggestion(st, &arms, pick_i, v, &kind, o.goal) } else { None };
    let (here_n, all_n) = picks(st, &kind, &pick.c.key);
    let why = why_of(pick, &kind, (here_n, all_n), o.goal, Why { pinned: pinned.is_some(), explored, suggest: false });
    let route = Route {
        goal: o.goal.to_owned(),
        kind,
        size,
        key: pick.c.key.clone(),
        effort: pick.effort.clone(),
        label: pick.c.label.clone(),
        chance: round(pick.est.mean, 2),
        n: pick.est.n,
        usd: round(pick.est.usd, 2),
        minutes: round(pick.est.minutes, 1),
        explored,
        trying: pick.state == Life::New,
        tier: tier_of(&pick.c.key),
        taste: pick.taste,
        pinned: pinned.map(|_| true),
        why,
        propensity: round(f64::from(hits) / f64::from(DRAWS), 2),
        alternatives: by_mean.iter().filter(|&&i| i != pick_i).take(4).map(|&i| alt(&arms[i])).collect(),
        suggest,
        at: now,
        ..Route::default()
    };
    Some(Pick {
        agent: pick.c.agent.clone(),
        model: pick.c.model.clone(),
        effort: pick.effort.clone(),
        key: pick.c.key.clone(),
        label: pick.c.label.clone(),
        route,
    })
}

/// Something that looks clearly better on the record than your habit: offered, not run.
fn suggestion(st: &RouterState, arms: &[Arm], pick: usize, v: f64, kind: &str, goal: &str) -> Option<Suggest> {
    let mut plain: Vec<usize> = (0..arms.len()).collect();
    plain.sort_by(|&p, &q| utility(v, &arms[q], arms[q].est.mean, false).total_cmp(&utility(v, &arms[p], arms[p].est.mean, false)));
    let pc = canon(&arms[pick].c.key);
    let rival = &arms[*plain.iter().find(|&&i| canon(&arms[i].c.key) != pc && !arms[i].preferred)?];
    let me = &arms[pick];
    let better =
        rival.est.mean >= me.est.mean + SUGGEST_MARGIN && utility(v, rival, rival.est.mean, false) > utility(v, me, me.est.mean, false);
    better.then(|| Suggest {
        alt: alt(rival),
        trying: rival.state == Life::New,
        why: why_of(rival, kind, picks(st, kind, &rival.c.key), goal, Why { suggest: true, ..Why::default() }),
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct Why {
    pinned: bool,
    explored: bool,
    suggest: bool,
}

/// Why this pick, in a few words: your habit, your record, the benchmarks, or the goal.
fn why_of(x: &Arm, kind: &str, (here, all): (u32, u32), goal: &str, o: Why) -> String {
    let pct = format!("{}%", round(x.est.mean * 100.0, 0));
    let first = if o.suggest {
        if x.est.n >= 3 { format!("{pct} on your {kind} tasks ({})", x.est.n) } else { format!("{pct} expected from public benchmarks") }
    } else if o.explored {
        "trying an alternative to learn".to_owned()
    } else if x.taste >= 0.2 && here >= 3 {
        format!("your usual for {kind} tasks ({here} of yours)")
    } else if x.taste >= 0.2 && all >= 3 {
        format!("your usual pick ({all} of yours)")
    } else if x.taste >= 0.2 {
        "the model you usually run".to_owned()
    } else if x.est.n >= 3 {
        format!("{pct} on your {kind} tasks ({})", x.est.n)
    } else if x.est.prior {
        format!("{pct} expected from public benchmarks")
    } else if x.est.inherited {
        format!("{pct} expected from its family's benchmarks")
    } else {
        format!("{pct} expected")
    };
    let mut parts = vec![first];
    if x.preferred {
        parts.push("you prefer it".into());
    }
    if !x.effort.is_empty() && !o.suggest {
        let label = GOALS.iter().find(|g| g.0 == goal).map_or("Balanced", |g| g.1);
        parts.push(format!("{} thinking for {label}", effort_label(&x.effort)));
    }
    if o.pinned {
        parts.push("as previewed".into());
    }
    parts.join(" · ")
}

/// A hand-over that keeps the model and thinks harder: a run at low or medium that failed goes again
/// at high (low, then failures at high, solves more than high everywhere, for less), one at high goes
/// to x-high. `None` when there's no level up.
pub fn level_up(st: &RouterState, now: i64, route: &Route, agents: &[AgentInfo]) -> Option<Pick> {
    if route.key.is_empty() {
        return None;
    }
    let p = split_key(&route.key);
    let lvl = level_of(&route.key);
    let a = agents.iter().find(|x| x.id == p.agent && x.available);
    let m = a.and_then(|a| a.models.iter().find(|x| x.id == p.model));
    let efforts = m.and_then(|m| m.efforts.clone()).or_else(|| a.and_then(|a| a.efforts.clone())).unwrap_or_default();
    let at = LEVELS.iter().position(|l| *l == lvl)?;
    let to = if at < 3 {
        "high"
    } else if lvl == "high" {
        "xhigh"
    } else {
        return None;
    };
    if !efforts.iter().any(|e| e == to) {
        return None;
    }
    let key = arm_key(p.agent, p.model, to);
    if cooling(st, &key, now).is_some() {
        return None;
    }
    let est = estimate(st, if route.kind.is_empty() { "*" } else { &route.kind }, &key, now);
    let head =
        ["Minimal", "Low", "Medium", "High"].iter().find_map(|l| route.label.strip_suffix(&format!(" · {l}"))).unwrap_or(&route.label);
    let label = format!("{} · {}", if head.is_empty() { &key } else { head }, effort_label(to));
    let r = Route {
        key: key.clone(),
        effort: to.to_owned(),
        label: label.clone(),
        chance: round(est.mean, 2),
        usd: round(est.usd, 2),
        why: "The same model, thinking harder".into(),
        at: now,
        tier: tier_of(&key),
        ..route.clone()
    };
    Some(Pick { agent: p.agent.to_owned(), model: p.model.to_owned(), effort: to.to_owned(), key, label, route: r })
}
