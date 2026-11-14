//! What Auto knows before your first task: public benchmarks, each model and level placed against
//! Claude Code's default (Opus 5.5 at medium) (v1 server/router-priors.json). `priors.json` beside
//! this crate's Cargo.toml is built from `priors-sources.json` by [`crate::priors_build::build`]; a
//! test checks the shipped file is what the sources make.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use wisp_router_api::{PriorInfo, PriorSource, arm_key, split_key};

/// One arm's starting record: a Beta(a, b) and what a task usually costs and takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorArm {
    pub a: f64,
    pub b: f64,
    pub usd: f64,
    pub min: f64,
    pub from: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Priors {
    pub version: String,
    pub source: String,
    pub sources: BTreeMap<String, PriorSource>,
    /// what a harness runs when no model is picked (claude → opus)
    pub aliases: BTreeMap<String, String>,
    /// the level a model runs at when none is picked (claude:opus → medium)
    pub defaults: BTreeMap<String, String>,
    /// 1 small or free, 2 everyday, 3 frontier
    pub tiers: BTreeMap<String, u8>,
    pub arms: BTreeMap<String, PriorArm>,
}

/// A prior arm with the parts of its key the estimate looks at, worked out once.
#[derive(Debug, Clone)]
pub struct PriorKey {
    pub key: String,
    pub agent: String,
    /// the arm without its level, and without a level in its id
    pub stem: String,
    pub level: String,
    /// its stem's family (versions stripped)
    pub family: String,
}

/// The shipped priors, with what every pick looks up precomputed.
#[derive(Debug)]
pub struct Shipped {
    pub priors: Priors,
    /// the harness · models the benchmarks know, whatever level they were measured at
    pub bases: BTreeSet<String>,
    pub families: BTreeSet<String>,
    pub keys: Vec<PriorKey>,
}

impl Shipped {
    pub fn info(&self) -> PriorInfo {
        PriorInfo { version: self.priors.version.clone(), source: self.priors.source.clone(), sources: self.priors.sources.clone() }
    }
}

/// The file shipped with wisp. An unreadable file (a broken build) is no priors at all: Auto still
/// picks, from names and outcomes; `tests/priors.rs` fails on it.
pub fn shipped() -> &'static Shipped {
    static S: OnceLock<Shipped> = OnceLock::new();
    S.get_or_init(|| {
        let priors: Priors = serde_json::from_str(include_str!("../priors.json")).unwrap_or_default();
        index(priors)
    })
}

fn index(priors: Priors) -> Shipped {
    let mut bases = BTreeSet::new();
    let mut keys = Vec::new();
    for k in priors.arms.keys() {
        let p = split_key(k);
        bases.insert(crate::keys::strip_suffix(&arm_key(p.agent, p.model, "")).to_owned());
        keys.push(PriorKey { key: k.clone(), agent: p.agent.to_owned(), stem: String::new(), level: String::new(), family: String::new() });
    }
    let families = bases.iter().map(|b| crate::keys::family(b)).collect();
    let mut s = Shipped { priors, bases, families, keys };
    // stem and level go through canon(), which reads the aliases and defaults just indexed
    for i in 0..s.keys.len() {
        let k = s.keys[i].key.clone();
        let stem = crate::keys::stem_with(&s.priors, &k);
        s.keys[i].level = crate::keys::level_with(&s.priors, &k);
        s.keys[i].family = crate::keys::family(&stem);
        s.keys[i].stem = stem;
    }
    s
}
