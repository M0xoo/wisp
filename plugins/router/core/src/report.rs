//! Settings → Auto (v1 Router.report, router.js:714-750): every harness · model, the thinking levels
//! it has a record at, each with its record overall and per kind, your picks of it, and the latest
//! routes Auto picked.

use std::collections::{BTreeMap, BTreeSet};

use wisp_router_api::{AgentInfo, ArmReport, RecentRoute, RouterReport, TYPES, TypeRecord, split_key};

use crate::choose::{Prefs, cooling};
use crate::estimate::{counts, estimate, picks};
use crate::keys::{base_of, candidates, canon, effort_label, round, rule_matches, tier_of};
use crate::priors::shipped;
use crate::router::Router;
use crate::state::Life;

/// Every key worth a row (one per run: claude: and claude:opus:medium are the same one), and its
/// label where a harness here names it.
fn keys_of(r: &Router, agents: &[AgentInfo]) -> (Vec<String>, BTreeMap<String, String>) {
    let arm_keys: BTreeSet<String> = r.st.arms.keys().cloned().collect();
    let mut keys: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let levels = r.st.all_stats().map(|(_, k, _)| k.to_owned()).filter(|k| !split_key(k).effort.is_empty());
    for k in arm_keys.iter().cloned().chain(candidates(agents, &arm_keys).into_iter().map(|c| c.key)).chain(levels) {
        if seen.insert(k.clone()) {
            keys.push(k);
        }
    }
    let bases: BTreeSet<String> = keys.iter().map(|k| base_of(k)).collect();
    let names: BTreeMap<String, String> = candidates(agents, &bases).into_iter().map(|c| (c.key, c.label)).collect();
    let mut labels = BTreeMap::new();
    for k in &keys {
        if let Some(name) = names.get(&base_of(k)) {
            let e = split_key(k).effort;
            labels.insert(k.clone(), if e.is_empty() { name.clone() } else { format!("{name} · {}", effort_label(e)) });
        }
    }
    let mut rows: BTreeMap<String, String> = BTreeMap::new();
    let mut order = Vec::new();
    for k in &keys {
        let c = canon(k);
        let better = match rows.get(&c) {
            None => true,
            Some(have) => (labels.contains_key(k) && !labels.contains_key(have)) || (labels.contains_key(k) && k.len() < have.len()),
        };
        if better {
            if !rows.contains_key(&c) {
                order.push(c.clone());
            }
            rows.insert(c, k.clone());
        }
    }
    (order.iter().filter_map(|c| rows.get(c).cloned()).collect(), labels)
}

fn arm_row(r: &Router, k: &str, label: Option<&String>, prefs: &Prefs, now: i64) -> ArmReport {
    let e = estimate(&r.st, "*", k, now);
    let mut by_type = BTreeMap::new();
    for t in TYPES {
        let c = counts(&r.st, t, k, now);
        if c.n > 0 {
            by_type.insert(t.to_owned(), TypeRecord { n: c.n, chance: round(estimate(&r.st, t, k, now).mean, 2) });
        }
    }
    let state = r.st.arms.get(&base_of(k)).map_or(if label.is_some() { Life::Ready } else { Life::Gone }, |a| a.state);
    let cool = cooling(&r.st, k, now);
    let (_, picks) = picks(&r.st, "*", k);
    let shown = if cool.is_some() && state != Life::Gone {
        "cooling"
    } else if state == Life::Ready && !e.prior && !e.inherited && e.n_all == 0 && picks == 0 {
        "untried"
    } else {
        state.as_str()
    };
    let global = |list: &[String]| list.iter().any(|x| !x.contains('@') && rule_matches(x, k, None));
    let p = split_key(k);
    ArmReport {
        key: k.to_owned(),
        agent: p.agent.to_owned(),
        model: p.model.to_owned(),
        effort: p.effort.to_owned(),
        canon: canon(k),
        label: label.cloned().unwrap_or_else(|| k.to_owned()),
        tier: tier_of(k),
        cooling_until: cool.map(|c| c.until),
        cooling_why: cool.map(|c| c.why.clone()),
        state: shown.to_owned(),
        chance: round(e.mean, 2),
        n: e.n,
        usd: round(e.usd, 2),
        minutes: round(e.minutes, 1),
        prior: e.prior,
        inherited: e.inherited,
        from: e.from,
        picks,
        blocked: global(&prefs.blocked),
        preferred: global(&prefs.prefer),
        by_type,
    }
}

/// The report for Settings → Auto: `agents` are this computer's harnesses.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn report(r: &Router, agents: &[AgentInfo], prefs: &Prefs, now: i64) -> RouterReport {
    let (rows, labels) = keys_of(r, agents);
    let mut arms: Vec<ArmReport> = rows.iter().map(|k| arm_row(r, k, labels.get(k), prefs, now)).filter(|a| a.state != "gone" || a.n > 0).collect();
    arms.sort_by(|x, y| y.picks.cmp(&x.picks).then(y.chance.total_cmp(&x.chance)));
    let picks: f64 = r.st.taste_of("*").map(|(_, x)| x.n).sum();
    let mut recent: Vec<RecentRoute> = r
        .st
        .routes()
        .filter(|(_, x)| !x.manual)
        .map(|(id, x)| RecentRoute {
            id: id.to_owned(),
            key: x.key.clone(),
            label: x.label.clone(),
            kind: x.kind.clone(),
            goal: x.goal.clone(),
            chance: x.chance,
            r: x.r,
            explored: x.explored,
            trying: x.trying,
            why: x.why.clone(),
            at: x.at,
            signals: x.signals.clone(),
        })
        .collect();
    recent.sort_by(|x, y| y.at.cmp(&x.at));
    recent.truncate(30);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    RouterReport {
        priors: shipped().info(),
        learned: count(r.learned()),
        routed: count(r.st.routes().filter(|(_, x)| !x.manual).count()),
        picks: picks.round().max(0.0) as u32,
        corrections: count(r.st.pairs.len()),
        arms,
        recent,
    }
}
