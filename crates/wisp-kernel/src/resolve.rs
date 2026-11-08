//! Resolution (plan §6.4, §6.11.2 rule 8): a pure function from manifests to an activation order. Edges
//! come from `extends` and `requires`, where a requirement names a plugin or a service contract (then it
//! points at the chosen provider). Missing or switched-off requirements refuse the plugin with the exact
//! reason, cycles refuse every plugin on them (printed), and refusals cascade to dependents. Optional
//! requirements order the set when they can but never refuse anything.
//!
//! size-ok: one pure resolution function and the graph it walks
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::manifest::Manifest;
use crate::semver::satisfies;

/// The kernel api this crate implements; a manifest's `api` range must accept it.
pub const KERNEL_API: &str = "1.0.0";

#[derive(Debug, Default)]
pub struct Input<'a> {
    /// in registration order; the first manifest of an id wins
    pub manifests: Vec<&'a Manifest>,
    /// switched off, with the reason
    pub off: HashMap<String, String>,
    /// which plugin provides a contract when several do: contract id → plugin id
    pub choices: HashMap<String, String>,
    /// plugins that aren't built in: they win a contract over built-ins (overrides, plan §6.0.3)
    pub overrides: HashSet<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Resolution {
    /// resolved plugin ids, dependencies first
    pub order: Vec<String>,
    /// every plugin that won't run, with why
    pub refused: BTreeMap<String, String>,
    /// contract id → the plugin chosen to provide it
    pub providers: BTreeMap<String, String>,
    /// plugin id → the plugins it hard-depends on
    pub deps: BTreeMap<String, Vec<String>>,
    /// plugin id → the plugins it optionally depends on (started with it when they resolved)
    pub wants: BTreeMap<String, Vec<String>>,
}

struct Edge {
    to: String,
    hard: bool,
    /// "{state}" is replaced by the target's state
    why: String,
}

fn candidates(
    ms: &BTreeMap<&str, (usize, &Manifest)>,
    input: &Input<'_>,
) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<(usize, String)>> = BTreeMap::new();
    for (id, (i, m)) in ms {
        for sid in m.provides.keys() {
            out.entry(sid.clone())
                .or_default()
                .push((*i, (*id).to_owned()));
        }
    }
    out.into_iter()
        .map(|(sid, mut ids)| {
            let chosen = input.choices.get(&sid);
            let rank = |id: &str| {
                if Some(id) == chosen.map(String::as_str) {
                    0
                } else if input.overrides.contains(id) {
                    1
                } else {
                    2
                }
            };
            ids.sort_by_key(|(i, id)| (rank(id), *i));
            (sid, ids.into_iter().map(|(_, id)| id).collect())
        })
        .collect()
}

fn edges_of(
    m: &Manifest,
    ms: &BTreeMap<&str, (usize, &Manifest)>,
    providers: &BTreeMap<String, String>,
) -> Vec<Edge> {
    let mut out = Vec::new();
    if let Some(e) = &m.extends {
        out.push(Edge {
            to: e.clone(),
            hard: true,
            why: format!("{} extends {e}, which is {{state}}", m.id),
        });
    }
    for r in m.requirements() {
        let hard = !r.optional;
        if ms.contains_key(r.id.as_str()) || !providers.contains_key(&r.id) {
            out.push(Edge {
                to: r.id.clone(),
                hard,
                why: format!("{} requires {}, which is {{state}}", m.id, r.id),
            });
        } else if let Some(p) = providers.get(&r.id).filter(|p| **p != m.id) {
            out.push(Edge {
                to: p.clone(),
                hard,
                why: format!(
                    "{} requires {}, whose provider {p} is {{state}}",
                    m.id, r.id
                ),
            });
        }
    }
    out
}

pub fn resolve(input: &Input<'_>) -> Resolution {
    let mut ms: BTreeMap<&str, (usize, &Manifest)> = BTreeMap::new();
    let mut ids: Vec<&str> = Vec::new();
    for (i, m) in input.manifests.iter().enumerate() {
        if !ms.contains_key(m.id.as_str()) {
            ms.insert(&m.id, (i, m));
            ids.push(&m.id);
        }
    }
    let mut refused: BTreeMap<String, String> = BTreeMap::new();
    for id in &ids {
        let m = ms[id].1;
        if let Some(why) = input.off.get(*id) {
            refused.insert((*id).to_owned(), why.clone());
        } else if !satisfies(KERNEL_API, &m.api) {
            refused.insert(
                (*id).to_owned(),
                format!(
                    "{id} needs kernel api {}, this kernel is {KERNEL_API}",
                    m.api
                ),
            );
        }
    }
    let cands = candidates(&ms, input);
    // refusals change which providers are usable, so iterate until nothing new is refused
    let (providers, edges) = loop {
        let providers: BTreeMap<String, String> = cands
            .iter()
            .filter_map(|(sid, ps)| {
                ps.iter()
                    .find(|p| !refused.contains_key(*p))
                    .map(|p| (sid.clone(), p.clone()))
            })
            .collect();
        let edges: HashMap<&str, Vec<Edge>> = ids
            .iter()
            .map(|id| (*id, edges_of(ms[id].1, &ms, &providers)))
            .collect();
        // judged against this round's snapshot, so the result doesn't depend on registration order
        let round: Vec<(String, String)> = ids
            .iter()
            .filter(|id| !refused.contains_key(**id))
            .filter_map(|id| {
                refusal_of(ms[id].1, &edges[id], &ms, &refused, &providers, &input.off)
                    .map(|w| ((*id).to_owned(), w))
            })
            .collect();
        let changed = !round.is_empty();
        refused.extend(round);
        if !changed && !refuse_cycles(&ids, &edges, &ms, &mut refused) {
            break (providers, edges);
        }
    };
    let live: Vec<&str> = ids
        .iter()
        .copied()
        .filter(|id| !refused.contains_key(*id))
        .collect();
    let order = topo(&live, &edges);
    let pick = |hard: bool| {
        edges
            .iter()
            .map(|(id, es)| {
                (
                    (*id).to_owned(),
                    es.iter()
                        .filter(|e| e.hard == hard)
                        .map(|e| e.to.clone())
                        .collect(),
                )
            })
            .collect()
    };
    Resolution {
        order,
        refused,
        providers,
        deps: pick(true),
        wants: pick(false),
    }
}

fn state_of(
    id: &str,
    ms: &BTreeMap<&str, (usize, &Manifest)>,
    refused: &BTreeMap<String, String>,
    off: &HashMap<String, String>,
) -> Option<String> {
    if !ms.contains_key(id) {
        return Some("missing".into());
    }
    if off.contains_key(id) {
        return Some("off".into());
    }
    refused.get(id).map(|why| format!("refused ({why})"))
}

fn refusal_of(
    m: &Manifest,
    edges: &[Edge],
    ms: &BTreeMap<&str, (usize, &Manifest)>,
    refused: &BTreeMap<String, String>,
    providers: &BTreeMap<String, String>,
    off: &HashMap<String, String>,
) -> Option<String> {
    for e in edges.iter().filter(|e| e.hard) {
        if let Some(s) = state_of(&e.to, ms, refused, off) {
            return Some(e.why.replace("{state}", &s));
        }
    }
    for r in m.requirements().into_iter().filter(|r| !r.optional) {
        let provider = if ms.contains_key(r.id.as_str()) {
            None
        } else {
            providers.get(&r.id)
        };
        let target = provider.unwrap_or(&r.id);
        let version = match provider {
            Some(p) => ms.get(p.as_str()).and_then(|(_, pm)| pm.provided(&r.id)),
            None => ms.get(r.id.as_str()).map(|(_, pm)| pm.version.as_str()),
        };
        let Some(version) = version else { continue };
        if refused.contains_key(target) || provider.is_some_and(|p| *p == m.id) {
            continue;
        }
        if !satisfies(version, &r.version) {
            let by = provider
                .map(|p| format!("{p} provides "))
                .unwrap_or_default();
            return Some(format!(
                "{} requires {} {}, but {by}{version}",
                m.id, r.id, r.version
            ));
        }
    }
    None
}

/// Tarjan's SCCs over hard edges among plugins still in; every plugin on a cycle is refused.
fn refuse_cycles(
    ids: &[&str],
    edges: &HashMap<&str, Vec<Edge>>,
    ms: &BTreeMap<&str, (usize, &Manifest)>,
    refused: &mut BTreeMap<String, String>,
) -> bool {
    struct T<'a> {
        index: HashMap<&'a str, usize>,
        low: HashMap<&'a str, usize>,
        stack: Vec<&'a str>,
        on: HashSet<&'a str>,
        n: usize,
        sccs: Vec<Vec<&'a str>>,
    }
    fn visit<'a>(
        v: &'a str,
        t: &mut T<'a>,
        edges: &'a HashMap<&str, Vec<Edge>>,
        live: &HashSet<&'a str>,
    ) {
        t.index.insert(v, t.n);
        t.low.insert(v, t.n);
        t.n += 1;
        t.stack.push(v);
        t.on.insert(v);
        for e in edges.get(v).into_iter().flatten().filter(|e| e.hard) {
            let Some(w) = live.get(e.to.as_str()).copied() else {
                continue;
            };
            if !t.index.contains_key(w) {
                visit(w, t, edges, live);
                let lw = t.low[w];
                t.low.entry(v).and_modify(|l| *l = (*l).min(lw));
            } else if t.on.contains(w) {
                let iw = t.index[w];
                t.low.entry(v).and_modify(|l| *l = (*l).min(iw));
            }
        }
        if t.low[v] == t.index[v] {
            let mut scc = Vec::new();
            while let Some(w) = t.stack.pop() {
                t.on.remove(w);
                scc.push(w);
                if w == v {
                    break;
                }
            }
            let selfloop = edges
                .get(v)
                .is_some_and(|es| es.iter().any(|e| e.hard && e.to == v));
            if scc.len() > 1 || selfloop {
                scc.reverse();
                t.sccs.push(scc);
            }
        }
    }
    let live: HashSet<&str> = ids
        .iter()
        .copied()
        .filter(|id| !refused.contains_key(*id) && ms.contains_key(id))
        .collect();
    let mut t = T {
        index: HashMap::new(),
        low: HashMap::new(),
        stack: Vec::new(),
        on: HashSet::new(),
        n: 0,
        sccs: Vec::new(),
    };
    for id in ids.iter().filter(|id| live.contains(**id)) {
        if !t.index.contains_key(id) {
            visit(id, &mut t, edges, &live);
        }
    }
    for scc in &t.sccs {
        let cycle = cycle_path(scc, edges);
        for id in scc {
            refused.insert((*id).to_owned(), format!("dependency cycle: {cycle}"));
        }
    }
    !t.sccs.is_empty()
}

/// 'a → b → a', following hard edges inside the component from its first member.
fn cycle_path(scc: &[&str], edges: &HashMap<&str, Vec<Edge>>) -> String {
    let start = scc.first().copied().unwrap_or_default();
    let mut path = vec![start];
    let mut at = start;
    loop {
        let next = edges.get(at).into_iter().flatten().find(|e| {
            e.hard
                && scc.contains(&e.to.as_str())
                && (e.to == start || !path.contains(&e.to.as_str()))
        });
        let Some(next) = next else { break };
        path.push(&next.to);
        if next.to == start {
            break;
        }
        at = &next.to;
    }
    path.join(" → ")
}

/// Kahn's algorithm: a plugin is placed once its hard requirements are. Among the ready ones, one
/// whose optional requirements are placed goes first, then registration order.
fn topo(ids: &[&str], edges: &HashMap<&str, Vec<Edge>>) -> Vec<String> {
    let live: HashSet<&str> = ids.iter().copied().collect();
    let mut placed: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    let waits = |id: &str, hard: bool, placed: &HashSet<&str>| {
        edges.get(id).into_iter().flatten().any(|e| {
            e.hard == hard
                && e.to != id
                && live.contains(e.to.as_str())
                && !placed.contains(e.to.as_str())
        })
    };
    while out.len() < ids.len() {
        let ready: Vec<&str> = ids
            .iter()
            .copied()
            .filter(|id| !placed.contains(id) && !waits(id, true, &placed))
            .collect();
        let Some(next) = ready
            .iter()
            .copied()
            .find(|id| !waits(id, false, &placed))
            .or_else(|| ready.first().copied())
        else {
            break;
        };
        placed.insert(next);
        out.push(next.to_owned());
    }
    out
}

/// Everyone who hard-depends on `id`, directly or not, in the order they'd have to go off.
pub fn dependents_of(id: &str, deps: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = std::iter::once(id.to_owned()).collect();
    let mut frontier = vec![id.to_owned()];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for (p, ds) in deps {
            if !seen.contains(p) && ds.iter().any(|d| frontier.contains(d)) {
                seen.insert(p.clone());
                next.push(p.clone());
                out.push(p.clone());
            }
        }
        frontier = next;
    }
    out
}
