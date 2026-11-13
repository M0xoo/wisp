//! The router's writes (v1 Router: sync, observe, backfill, override, record, signal, cool, void,
//! reset; router.js:282-712). Time comes in as `now`; every change is marked in the state's dirty set.
//!
//! What happened after a run is the reward ([`crate::math::reward`]): a later, stronger signal
//! replaces an earlier one and the stats move by the difference. Runs you picked yourself count half.

use std::collections::BTreeSet;

use wisp_router_api::{Added, AgentInfo, Limit, LimitScope, Signals, StoredRoute, arm_key, split_key};

use crate::estimate::{TASTE_HALF_LIFE_MS, prior_of};
use crate::keys::{base_of, candidates, canon};
use crate::math::reward;
use crate::state::{ArmState, Cool, Life, Pair, RouterState, Taste};

const MANUAL_WEIGHT: f64 = 0.5; // a run you picked yourself teaches the record half as much
const PROBATION: u32 = 3; // outcomes that end a new arm's probation

/// The router's state and whether this computer's harnesses were looked at yet.
#[derive(Debug, Clone, Default)]
pub struct Router {
    pub st: RouterState,
    /// this computer's harnesses were synced once
    pub synced: bool,
}

/// A launch you picked yourself (v1 `observe`'s options).
#[derive(Debug, Clone, Default)]
pub struct Observe<'a> {
    pub agent: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub prompt: &'a str,
    pub attachments: u32,
    /// the kind of task, when known (else classified from the prompt)
    pub kind: Option<&'a str>,
    pub at: Option<i64>,
    /// 1 for a launch, 2 for a correction
    pub weight: Option<f64>,
}

/// A launch from before wisp learned taste (backfill).
#[derive(Debug, Clone, Default)]
pub struct PastLaunch {
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub created_at: i64,
    pub prompt: String,
    pub attachments: u32,
    /// not a launch you picked: Auto's, a crew job, a channel's, a subagent's, a spell's
    pub skip: bool,
}

impl Router {
    pub fn new(st: RouterState) -> Self {
        Self { st, synced: false }
    }

    /// New harnesses and models since the last look; the first look only learns what's there.
    /// Returns the arms that just showed up (on probation unless the benchmarks know them).
    /// `more`: a machine's harnesses, on top of this computer's: none of these is marked gone.
    pub fn sync(&mut self, agents: &[AgentInfo], more: bool, now: i64) -> Vec<Added> {
        let first = !more && self.st.arms.is_empty();
        let known: BTreeSet<String> = self.st.arms.keys().cloned().collect();
        let mut added = Vec::new();
        let mut seen = BTreeSet::new();
        for c in candidates(agents, &known) {
            seen.insert(c.key.clone());
            match self.st.arms.get_mut(&c.key) {
                None => {
                    // v1 #763: on the first look only a harness's default and scored models are ready; a model
                    // the benchmarks place by tier alone (Fable) is on probation like anything new
                    let state = if prior_of(&c.key).is_some() || (first && c.model.is_empty()) { Life::Ready } else { Life::New };
                    self.st.arms.insert(c.key.clone(), ArmState { first_seen: now, state });
                    self.st.dirty.arms.insert(c.key.clone());
                    if !first {
                        added.push(Added { key: c.key, label: c.label, state: state.as_str().into() });
                    }
                }
                Some(arm) if arm.state == Life::Gone => {
                    arm.state = Life::Ready;
                    self.st.dirty.arms.insert(c.key);
                }
                Some(_) => {}
            }
        }
        if !more {
            for (k, arm) in &mut self.st.arms {
                if seen.contains(k) || arm.state == Life::Gone || !agents.iter().any(|a| a.id == split_key(k).agent) {
                    continue;
                }
                arm.state = Life::Gone;
                self.st.dirty.arms.insert(k.clone());
            }
            self.synced = true;
        }
        added
    }

    /// A launch you picked yourself (or a preview you changed): weight 1, a correction counts more.
    /// Returns (the key as launched, its canon key, the kind of task); `None` for Auto or wisp.
    #[allow(clippy::cast_precision_loss)]
    pub fn observe(&mut self, o: &Observe, now: i64) -> Option<(String, String, String)> {
        if o.agent.is_empty() || o.agent == "auto" || o.agent == "wisp" {
            return None;
        }
        let at = o.at.unwrap_or(now);
        let raw = arm_key(o.agent, o.model, o.effort);
        let c = canon(&raw);
        let kind =
            o.kind.filter(|k| !k.is_empty()).map_or_else(|| crate::classify::task(o.prompt, o.attachments).0.to_owned(), str::to_owned);
        for t in [kind.as_str(), "*"] {
            let had = self.st.taste(t, &c).cloned();
            let f = had.as_ref().map_or(0.0, |x| 0.5f64.powf((at - x.at).max(0) as f64 / TASTE_HALF_LIFE_MS));
            let x = had.unwrap_or_default();
            let mut raw_n = x.raw;
            *raw_n.entry(raw.clone()).or_insert(0) += 1;
            self.st.set_taste(t, &c, Taste { n: x.n * f + o.weight.unwrap_or(1.0), at: at.max(x.at), raw: raw_n });
        }
        Some((raw, c, kind))
    }

    /// Your launches from before wisp learned taste: once, oldest first. Returns how many counted.
    pub fn backfill(&mut self, sessions: &[PastLaunch], now: i64) -> usize {
        if self.st.backfilled.is_some() {
            return 0;
        }
        let mut list: Vec<&PastLaunch> = sessions.iter().collect();
        list.sort_by_key(|s| s.created_at);
        let mut n = 0;
        for s in list {
            if s.skip || s.agent.is_empty() || s.agent == "wisp" || s.prompt.is_empty() {
                continue;
            }
            let at = if s.created_at == 0 { now } else { s.created_at };
            let o = Observe {
                agent: &s.agent,
                model: &s.model,
                effort: &s.effort,
                prompt: &s.prompt,
                attachments: s.attachments,
                at: Some(at),
                ..Observe::default()
            };
            if self.observe(&o, now).is_some() {
                n += 1;
            }
        }
        self.st.backfilled = Some(now);
        self.st.dirty.meta = true;
        n
    }

    /// You changed Auto's preview before sending: a point against its pick on this kind of task, and
    /// a strong vote for yours.
    pub fn override_pick(&mut self, kind: &str, auto: &str, chose: &str, prompt: &str, now: i64) {
        if auto.is_empty() || chose.is_empty() || canon(auto) == canon(chose) {
            return;
        }
        let p = split_key(chose);
        self.observe(
            &Observe {
                agent: p.agent,
                model: p.model,
                effort: p.effort,
                prompt,
                kind: Some(kind),
                weight: Some(2.0),
                ..Observe::default()
            },
            now,
        );
        let ca = canon(auto);
        for (t, w) in [(kind, 0.5), ("*", 0.25)] {
            let s = self.st.stat_mut(t, &ca, now);
            s.b += w;
            s.at = now;
        }
        self.st.push_pair(Pair { kind: kind.to_owned(), auto: ca, chose: canon(chose), at: now });
    }

    /// A launch went out with this route. `id`: the session id (`id@machine` on a machine).
    pub fn record(&mut self, id: &str, mut route: StoredRoute, now: i64) {
        route.signals = Signals::default();
        route.r = None;
        route.voided = false;
        if route.at == 0 {
            route.at = now;
        }
        self.st.insert_route(id, route);
    }

    /// Something happened to a routed session: the reward is recomputed and the stats move by the
    /// difference. A voided route takes no signal (v1 router.js:632).
    pub fn signal(&mut self, id: &str, patch: &Signals, now: i64) -> Option<StoredRoute> {
        let route = self.st.route_mut(id)?;
        if route.voided {
            return Some(route.clone());
        }
        route.signals.merge(patch);
        let Some(r) = reward(&route.signals) else { return Some(route.clone()) };
        let (old, kind, key, manual, cost, ms) =
            (route.r, route.kind.clone(), route.key.clone(), route.manual, route.signals.cost_usd, route.signals.ms);
        route.r = Some(r);
        let w = if manual { MANUAL_WEIGHT } else { 1.0 };
        for t in [kind.as_str(), "*"] {
            let s = self.st.stat_mut(t, &key, now);
            match old {
                None => {
                    s.n += 1;
                    if let Some(c) = cost {
                        s.usd += c;
                        s.usd_n += 1;
                    }
                    s.ms += ms.unwrap_or(0.0);
                }
                Some(o) => {
                    s.a -= o * w;
                    s.b -= (1.0 - o) * w;
                }
            }
            s.a += r * w;
            s.b += (1.0 - r) * w;
            s.at = now;
        }
        self.end_probation(&key);
        self.st.route(id).cloned()
    }

    /// Probation ends once a harness · model has a few outcomes of its own, at any level.
    fn end_probation(&mut self, key: &str) {
        let base = base_of(key);
        if self.st.arms.get(&base).is_none_or(|a| a.state != Life::New) {
            return;
        }
        let n: u32 = self.st.all_stats().filter(|(t, k, _)| *t == "*" && base_of(k) == base).map(|(.., s)| s.n).sum();
        if n >= PROBATION
            && let Some(a) = self.st.arms.get_mut(&base)
        {
            a.state = Life::Ready;
            self.st.dirty.arms.insert(base);
        }
    }

    /// A harness (`scope: agent`) or one model at every level hit a limit: skip it until it resets.
    /// Returns what cools (`claude:*` or `claude:opus`).
    pub fn cool(&mut self, key: &str, limit: &Limit, why: &str, now: i64) -> String {
        let target = match limit.scope {
            LimitScope::Agent => format!("{}:*", split_key(key).agent),
            LimitScope::Arm => base_of(key),
        };
        let why: String = why.chars().take(160).collect();
        self.st.cooling.insert(target.clone(), Cool { until: now + limit.ms.clamp(0, crate::classify::MAX_COOL_MS), why });
        self.st.dirty.cooling.insert(target.clone());
        target
    }

    /// The run never got to work (the harness was at its limit): forget it ever counted.
    pub fn void(&mut self, id: &str) {
        let Some(route) = self.st.route_mut(id) else { return };
        let (old, kind, key, manual) = (route.r, route.kind.clone(), route.key.clone(), route.manual);
        route.r = None;
        route.voided = true;
        let Some(r) = old else { return };
        let w = if manual { MANUAL_WEIGHT } else { 1.0 };
        for t in [kind.as_str(), "*"] {
            if self.st.stat(t, &key).is_none() {
                continue;
            }
            let s = self.st.stat_mut(t, &key, 0);
            s.a -= r * w;
            s.b -= (1.0 - r) * w;
            s.n = s.n.saturating_sub(1);
        }
    }

    /// Forget outcomes and your picks; the benchmarks stay, and your old launches aren't read again.
    pub fn reset(&mut self, now: i64) {
        self.st.clear_learned();
        if self.st.backfilled.is_none() {
            self.st.backfilled = Some(now);
        }
        self.st.dirty.meta = true;
    }

    /// Outcomes of your own tasks the router has learned from.
    pub fn learned(&self) -> usize {
        self.st.routes().filter(|(_, r)| r.r.is_some()).count()
    }
}
