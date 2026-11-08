//! What the router keeps (v1 router.json, `version: 2`): the arms it has seen, its outcome stats per
//! (kind of task, arm), the routes it sent, your taste (your own picks), your corrections of its
//! picks, and the harnesses cooling after a limit. Every write marks what it touched in [`Dirty`], so
//! the host saves only those rows in one store transaction.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};
use wisp_router_api::StoredRoute;

use crate::keys::canon;

/// Routes kept, oldest dropped first (v1 router.js:53).
pub const MAX_ROUTES: usize = 2000;
/// Corrections kept (v1 router.js:54).
pub const MAX_PAIRS: usize = 500;

/// Where an arm is in its life.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Life {
    /// on probation: Auto tries it only when nothing else fits, until it has a few outcomes
    New,
    #[default]
    Ready,
    /// its harness no longer offers it
    Gone,
}

impl Life {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Ready => "ready",
            Self::Gone => "gone",
        }
    }
}

/// One harness · model the router has seen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmState {
    pub first_seen: i64,
    pub state: Life,
}

/// Outcomes of one arm on one kind of task: a Beta record (`a` successes, `b` failures, both
/// fractional), how many runs, what they cost and took, and when it last moved.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub a: f64,
    pub b: f64,
    pub n: u32,
    pub usd: f64,
    /// runs whose cost was known
    pub usd_n: u32,
    pub ms: f64,
    pub at: i64,
}

/// Your picks of one run (by its canon key) on one kind of task, decayed from `at`; `raw` counts the
/// names you launched it by.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Taste {
    pub n: f64,
    pub at: i64,
    #[serde(default)]
    pub raw: BTreeMap<String, u32>,
}

/// You changed Auto's pick before sending.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pair {
    #[serde(rename = "type")]
    pub kind: String,
    pub auto: String,
    pub chose: String,
    pub at: i64,
}

/// A harness (`claude:*`) or a model (`claude:opus`) skipped until its limit resets.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cool {
    pub until: i64,
    pub why: String,
}

/// What changed since the host last saved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Dirty {
    pub arms: BTreeSet<String>,
    pub cooling: BTreeSet<String>,
    /// (kind, key)
    pub stats: BTreeSet<(String, String)>,
    /// (kind, canon key)
    pub taste: BTreeSet<(String, String)>,
    pub routes: BTreeSet<String>,
    /// routes dropped past [`MAX_ROUTES`]
    pub dropped_routes: BTreeSet<String>,
    pub pairs: bool,
    /// `backfilled`, or everything learned was reset
    pub meta: bool,
}

impl Dirty {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The router's whole state. Maps are keyed as v1 keyed them; `stats` and `taste` by (kind, key),
/// where kind `*` is every kind of task.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterState {
    #[serde(default)]
    pub arms: BTreeMap<String, ArmState>,
    #[serde(default)]
    pub cooling: BTreeMap<String, Cool>,
    #[serde(default, with = "pairs_map")]
    stats: BTreeMap<(String, String), Stat>,
    #[serde(default, with = "pairs_map")]
    taste: BTreeMap<(String, String), Taste>,
    #[serde(default)]
    routes: BTreeMap<String, StoredRoute>,
    /// route ids, oldest first (v1 keeps insertion order and drops from the front)
    #[serde(default)]
    order: VecDeque<String>,
    #[serde(default)]
    pub pairs: Vec<Pair>,
    #[serde(default)]
    pub backfilled: Option<i64>,
    #[serde(skip)]
    pub dirty: Dirty,
}

/// `(kind, key)` maps as v1's `"kind|key"` objects.
mod pairs_map {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, V: Serialize>(m: &BTreeMap<(String, String), V>, s: S) -> Result<S::Ok, S::Error> {
        let flat: BTreeMap<String, &V> = m.iter().map(|((t, k), v)| (format!("{t}|{k}"), v)).collect();
        flat.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>, V: Deserialize<'de>>(d: D) -> Result<BTreeMap<(String, String), V>, D::Error> {
        let flat = BTreeMap::<String, V>::deserialize(d)?;
        Ok(flat.into_iter().filter_map(|(sk, v)| sk.split_once('|').map(|(t, k)| ((t.to_owned(), k.to_owned()), v))).collect())
    }
}

impl RouterState {
    pub fn stat(&self, kind: &str, key: &str) -> Option<&Stat> {
        self.stats.get(&(kind.to_owned(), key.to_owned()))
    }

    /// The stat for (kind, key), made at `now` if it's new; marked dirty.
    pub fn stat_mut(&mut self, kind: &str, key: &str, now: i64) -> &mut Stat {
        let id = (kind.to_owned(), key.to_owned());
        self.dirty.stats.insert(id.clone());
        self.stats.entry(id).or_insert(Stat { at: now, ..Stat::default() })
    }

    /// Every stat: (kind, key, stat).
    pub fn all_stats(&self) -> impl Iterator<Item = (&str, &str, &Stat)> {
        self.stats.iter().map(|((t, k), s)| (t.as_str(), k.as_str(), s))
    }

    /// The stats on one kind of task of every name of a run (`c`: its canon key).
    pub fn stats_of<'a>(&'a self, kind: &'a str, c: &'a str) -> impl Iterator<Item = (&'a str, &'a Stat)> + 'a {
        self.stats.iter().filter(move |((t, k), _)| t == kind && canon(k) == c).map(|((_, k), s)| (k.as_str(), s))
    }

    /// The runs (canon keys, once each) with a record on one kind of task.
    pub fn canons_of<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = String> + 'a {
        let set: BTreeSet<String> = self.stats.keys().filter(|(t, _)| t == kind).map(|(_, k)| canon(k)).collect();
        set.into_iter()
    }

    pub fn taste(&self, kind: &str, c: &str) -> Option<&Taste> {
        self.taste.get(&(kind.to_owned(), c.to_owned()))
    }

    pub fn set_taste(&mut self, kind: &str, c: &str, t: Taste) {
        let id = (kind.to_owned(), c.to_owned());
        self.dirty.taste.insert(id.clone());
        self.taste.insert(id, t);
    }

    /// Your picks on one kind of task: (canon key, taste).
    pub fn taste_of<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = (&'a str, &'a Taste)> + 'a {
        self.taste.iter().filter(move |((t, _), _)| t == kind).map(|((_, k), x)| (k.as_str(), x))
    }

    pub fn push_pair(&mut self, p: Pair) {
        self.pairs.push(p);
        if self.pairs.len() > MAX_PAIRS {
            let extra = self.pairs.len() - MAX_PAIRS;
            self.pairs.drain(..extra);
        }
        self.dirty.pairs = true;
    }

    pub fn route(&self, id: &str) -> Option<&StoredRoute> {
        self.routes.get(id)
    }

    pub fn route_mut(&mut self, id: &str) -> Option<&mut StoredRoute> {
        let r = self.routes.get_mut(id)?;
        self.dirty.routes.insert(id.to_owned());
        Some(r)
    }

    /// Keep a route; past [`MAX_ROUTES`] the oldest go.
    pub fn insert_route(&mut self, id: &str, r: StoredRoute) {
        if self.routes.insert(id.to_owned(), r).is_none() {
            self.order.push_back(id.to_owned());
        }
        self.dirty.routes.insert(id.to_owned());
        while self.order.len() > MAX_ROUTES {
            if let Some(old) = self.order.pop_front() {
                self.routes.remove(&old);
                self.dirty.routes.remove(&old);
                self.dirty.dropped_routes.insert(old);
            }
        }
    }

    /// Every route kept: (session id, route), oldest first.
    pub fn routes(&self) -> impl Iterator<Item = (&str, &StoredRoute)> {
        self.order.iter().filter_map(|id| self.routes.get(id).map(|r| (id.as_str(), r)))
    }

    /// Forget outcomes, routes, your picks and corrections (v1 `reset`); arms and cooling stay.
    pub fn clear_learned(&mut self) {
        self.stats.clear();
        self.taste.clear();
        self.dropped_routes_all();
        self.pairs.clear();
        self.dirty.pairs = true;
        self.dirty.meta = true;
    }

    fn dropped_routes_all(&mut self) {
        self.dirty.routes.clear();
        self.dirty.dropped_routes.extend(self.order.drain(..));
        self.routes.clear();
    }

    /// Every taste row: (kind, canon key, taste).
    pub fn all_taste(&self) -> impl Iterator<Item = (&str, &str, &Taste)> {
        self.taste.iter().map(|((t, k), x)| (t.as_str(), k.as_str(), x))
    }

    /// Rows read back from the store (nothing is marked dirty).
    pub fn load_stat(&mut self, kind: &str, key: &str, s: Stat) {
        self.stats.insert((kind.to_owned(), key.to_owned()), s);
    }
    pub fn load_taste(&mut self, kind: &str, c: &str, t: Taste) {
        self.taste.insert((kind.to_owned(), c.to_owned()), t);
    }
    /// Routes read back, in the order they were recorded.
    pub fn load_route(&mut self, id: &str, r: StoredRoute) {
        if self.routes.insert(id.to_owned(), r).is_none() {
            self.order.push_back(id.to_owned());
        }
    }

    /// What changed since the last save, leaving the set empty.
    pub fn take_dirty(&mut self) -> Dirty {
        std::mem::take(&mut self.dirty)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn routes_drop_the_oldest_past_the_cap() {
        let mut st = RouterState::default();
        for i in 0..=MAX_ROUTES {
            st.insert_route(&format!("s{i}"), StoredRoute::default());
        }
        assert_eq!(st.routes().count(), MAX_ROUTES);
        assert!(st.route("s0").is_none());
        assert_eq!(st.routes().next().map(|(id, _)| id), Some("s1"));
        assert!(st.dirty.dropped_routes.contains("s0"));
    }

    #[test]
    fn pairs_keep_the_newest() {
        let mut st = RouterState::default();
        for i in 0..(MAX_PAIRS + 3) {
            st.push_pair(Pair { at: i64::try_from(i).unwrap(), ..Pair::default() });
        }
        assert_eq!(st.pairs.len(), MAX_PAIRS);
        assert_eq!(st.pairs[0].at, 3);
    }

    #[test]
    fn round_trips_as_v1_kind_bar_key() {
        let mut st = RouterState::default();
        st.stat_mut("bug", "claude:opus:high", 5).n = 2;
        let j = serde_json::to_value(&st).unwrap();
        assert!(j["stats"].get("bug|claude:opus:high").is_some());
        let back: RouterState = serde_json::from_value(j).unwrap();
        assert_eq!(back.stat("bug", "claude:opus:high").map(|s| s.n), Some(2));
    }

    #[test]
    fn reset_keeps_arms() {
        let mut st = RouterState::default();
        st.arms.insert("claude:opus".into(), ArmState::default());
        st.stat_mut("*", "claude:opus", 0);
        st.insert_route("s", StoredRoute::default());
        st.clear_learned();
        assert_eq!(st.all_stats().count(), 0);
        assert_eq!(st.routes().count(), 0);
        assert_eq!(st.arms.len(), 1);
    }
}
