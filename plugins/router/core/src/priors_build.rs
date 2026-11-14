//! Turns public benchmark rows (`priors-sources.json`) into Auto's starting estimates
//! (`priors.json`), number for number as v1 server/priors-build.js did. Each arm is placed against
//! the anchor (Claude Code's default) benchmark by benchmark: only arms placed before it count as
//! references, so two arms never prop each other up.

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use wisp_router_api::PriorSource;

use crate::keys::round;
use crate::priors::{PriorArm, Priors};

/// Cost of a thinking level against medium: Anthropic's Opus 5.5 sweep, `CursorBench` for max.
pub fn level_cost(l: &str) -> f64 {
    match l {
        "minimal" => 0.4,
        "low" => 0.52,
        "high" => 1.38,
        "xhigh" => 3.5,
        "max" => 6.7,
        _ => 1.0,
    }
}

/// Time of a thinking level against medium.
pub fn level_time(l: &str) -> f64 {
    match l {
        "minimal" => 0.6,
        "low" => 0.7,
        "high" => 1.3,
        "xhigh" => 2.0,
        "max" => 3.0,
        _ => 1.0,
    }
}

/// A JSON object read in document order (prefix lookups take the first match, as v1's did).
#[derive(Debug, Clone, Default)]
pub struct Ordered(pub Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
        }
        d.deserialize_map(V)
    }
}

impl Ordered {
    /// without `note` (prose for whoever edits the file)
    fn strip(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.0.iter().filter(|(k, _)| k != "note").map(|(k, v)| (k.as_str(), v))
    }
    fn num(&self, k: &str) -> Option<f64> {
        self.strip().find(|(x, _)| *x == k).and_then(|(_, v)| v.as_f64())
    }
    /// its own entry, else the first key `base` starts with
    fn by_prefix(&self, base: &str) -> Option<f64> {
        self.num(base).or_else(|| self.strip().find(|(k, _)| base.starts_with(k)).and_then(|(_, v)| v.as_f64()))
    }
    fn strings(&self) -> BTreeMap<String, String> {
        self.strip().filter_map(|(k, v)| v.as_str().map(|s| (k.to_owned(), s.to_owned()))).collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Anchor {
    pub arm: String,
    pub chance: f64,
    pub usd: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Row {
    pub arm: String,
    pub bench: String,
    pub score: f64,
    pub source: String,
    #[serde(default)]
    pub usd: Option<f64>,
    /// a row about a predecessor (it names the model it stands in for): counts half
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Same {
    pub a: String,
    pub b: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sources {
    pub anchor: Anchor,
    pub rows: Vec<Row>,
    #[serde(default)]
    pub same: Vec<Same>,
    #[serde(default)]
    pub helpers: Vec<String>,
    pub sources: BTreeMap<String, PriorSource>,
    pub prices: Ordered,
    pub tiers: Ordered,
    pub defaults: Ordered,
    pub aliases: Ordered,
    pub minutes: Ordered,
    pub strength: f64,
}

const LEVELS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/// `:level` at the end of an arm (here a level is always after a colon).
fn level_of(k: &str) -> &str {
    k.rsplit_once(':').map(|(_, l)| l).filter(|l| LEVELS.contains(l)).unwrap_or("")
}
fn base_of(k: &str) -> &str {
    match k.rsplit_once(':') {
        Some((b, l)) if LEVELS.contains(&l) => b,
        _ => k,
    }
}

struct Spread<'a> {
    src: &'a Sources,
    benches: Vec<&'a str>,
    /// arm → its place in the order arms were placed
    order: HashMap<String, usize>,
    known: Vec<(String, f64)>,
}

impl<'a> Spread<'a> {
    fn known(&self, k: &str) -> Option<f64> {
        self.order.get(k).map(|&i| self.known[i].1)
    }
    fn add(&mut self, k: &str, v: f64) {
        self.order.insert(k.to_owned(), self.known.len());
        self.known.push((k.to_owned(), v));
    }
    fn rows_of(&self, b: &'a str) -> impl Iterator<Item = &'a Row> + 'a {
        self.src.rows.iter().filter(move |r| r.bench == b)
    }
    /// Where benchmark `b` places `arm`: its score, scaled by the arms there placed before it.
    #[allow(clippy::cast_precision_loss)]
    fn place(&self, b: &'a str, arm: &str) -> Option<(f64, f64)> {
        let before = self.order.get(arm).copied().unwrap_or(usize::MAX);
        let refs: Vec<&Row> = self.rows_of(b).filter(|r| r.arm != arm && self.order.get(&r.arm).is_some_and(|&i| i < before)).collect();
        let row = self.rows_of(b).find(|r| r.arm == arm)?;
        if refs.is_empty() {
            return None;
        }
        let scale = refs.iter().fold(0.0, |s, r| s + self.known(&r.arm).unwrap_or(0.0) / r.score) / refs.len() as f64;
        Some((row.score * scale, if row.note.is_some() { 0.5 } else { 1.0 }))
    }
    /// Two names for one run share their chance.
    fn tie(&mut self) -> bool {
        let mut moved = false;
        for s in &self.src.same {
            match (self.known(&s.a), self.known(&s.b)) {
                (Some(a), None) => {
                    self.add(&s.b, a);
                    moved = true;
                }
                (None, Some(b)) => {
                    self.add(&s.a, b);
                    moved = true;
                }
                _ => {}
            }
        }
        moved
    }
    fn run(&mut self) {
        let mut moved = true;
        while moved {
            moved = self.tie();
            for b in self.benches.clone() {
                for r in self.rows_of(b).collect::<Vec<_>>() {
                    if self.known(&r.arm).is_some() {
                        continue;
                    }
                    if let Some((c, _)) = self.place(b, &r.arm) {
                        self.add(&r.arm, c);
                        moved = true;
                    }
                }
            }
        }
    }
    /// Each arm (but the anchor) averaged over every benchmark that can place it, and its sources.
    fn settle(&self) -> Vec<(String, f64, Vec<String>)> {
        let src = self.src;
        let tied = |a: &str| src.same.iter().any(|s| s.a == a || s.b == a);
        let mut out = Vec::new();
        for (arm, chance) in &self.known {
            let mut from: Vec<String> = Vec::new();
            for r in src.rows.iter().filter(|r| &r.arm == arm) {
                if !from.contains(&r.source) {
                    from.push(r.source.clone());
                }
            }
            let own = src.rows.iter().any(|r| &r.arm == arm);
            let fin = if *arm == src.anchor.arm || (tied(arm) && !own) {
                *chance
            } else {
                let ps: Vec<(f64, f64)> = self.benches.iter().filter_map(|b| self.place(b, arm)).collect();
                let w: f64 = ps.iter().map(|p| p.1).sum();
                if w > 0.0 { ps.iter().fold(0.0, |s, p| s + p.0 * p.1) / w } else { *chance }
            };
            for s in src.same.iter().filter(|s| &s.a == arm || &s.b == arm) {
                if !from.contains(&s.source) {
                    from.push(s.source.clone());
                }
            }
            out.push((arm.clone(), fin, from));
        }
        out
    }
}

/// Cost: measured next to the anchor on the same benchmark where possible, else from prices.
#[allow(clippy::cast_precision_loss)]
fn usd_of(src: &Sources, benches: &[&str], arm: &str) -> f64 {
    let a = &src.anchor;
    let measured: Vec<f64> = benches
        .iter()
        .filter_map(|b| {
            let usd = |name: &str| src.rows.iter().find(|r| r.bench == *b && r.arm == name && r.usd.is_some()).and_then(|r| r.usd);
            Some(a.usd * usd(arm)? / usd(&a.arm)?)
        })
        .collect();
    if !measured.is_empty() {
        return measured.iter().fold(0.0, |s, x| s + x) / measured.len() as f64;
    }
    let price = |base: &str| {
        src.prices.strip().find(|(k, _)| *k == base).and_then(|(_, v)| Some(f64::midpoint(v.get(0)?.as_f64()?, v.get(1)?.as_f64()?)))
    };
    let base = base_of(arm);
    let defaults = src.defaults.strings();
    let def = defaults.get(base).map_or("medium", String::as_str);
    let at = if level_of(arm).is_empty() { def } else { level_of(arm) };
    let per = if let Some(p) = price(base) {
        a.usd * p / price(base_of(&a.arm)).unwrap_or(1.0)
    } else {
        let tier = src.tiers.by_prefix(base).unwrap_or(2.0);
        a.usd
            * if (tier - 1.0).abs() < f64::EPSILON {
                0.2
            } else if (tier - 3.0).abs() < f64::EPSILON {
                1.0
            } else {
                0.5
            }
    };
    per * (level_cost(at) / level_cost(def))
}

fn minutes_of(src: &Sources, arm: &str) -> f64 {
    let base = base_of(arm);
    let defaults = src.defaults.strings();
    let def = defaults.get(base).map_or("medium", String::as_str);
    let at = if level_of(arm).is_empty() { def } else { level_of(arm) };
    src.minutes.by_prefix(base).unwrap_or(3.0) * (level_time(at) / level_time(def))
}

/// The priors the sources make.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn build(src: &Sources) -> Priors {
    let mut benches: Vec<&str> = Vec::new();
    for r in &src.rows {
        if !benches.contains(&r.bench.as_str()) {
            benches.push(&r.bench);
        }
    }
    let mut sp = Spread { src, benches: benches.clone(), order: HashMap::new(), known: Vec::new() };
    sp.add(&src.anchor.arm, src.anchor.chance);
    sp.run();
    let n = src.strength;
    let mut arms = BTreeMap::new();
    for (arm, c, from) in sp.settle() {
        if src.helpers.contains(&arm) {
            continue;
        }
        let chance = c.clamp(0.05, 0.95);
        // a guess that rests only on predecessors counts half
        let only_kin = src.rows.iter().filter(|r| r.arm == arm).all(|r| r.note.is_some());
        let s = if only_kin { n / 2.0 } else { n };
        let p = PriorArm {
            a: round(chance * s, 3),
            b: round((1.0 - chance) * s, 3),
            usd: round(usd_of(src, &benches, &arm), 3),
            min: round(minutes_of(src, &arm), 1),
            from,
        };
        arms.insert(arm, p);
    }
    let mut dates: Vec<&str> = src.sources.values().map(|s| s.date.as_str()).collect();
    dates.sort_unstable();
    let (first, last) = (dates.first().copied().unwrap_or(""), dates.last().copied().unwrap_or(""));
    Priors {
        version: format!("bench-{last}"),
        source: format!(
            "Public benchmarks ({} sources, {first} to {last}), placed against Claude Code's default (Opus 5.5 at medium). See scripts/priors-sources.json.",
            src.sources.len()
        ),
        sources: src.sources.clone(),
        aliases: src.aliases.strings(),
        defaults: src.defaults.strings(),
        tiers: src.tiers.strip().filter_map(|(k, v)| v.as_u64().and_then(|t| u8::try_from(t).ok()).map(|t| (k.to_owned(), t))).collect(),
        arms,
    }
}
