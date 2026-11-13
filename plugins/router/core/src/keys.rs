//! Arms and what their names say (v1 router.js:77-255). Every harness × model × thinking level is an
//! arm (`claude:opus:high`; no level is the model's default). `claude:`, `claude:opus` and
//! `claude:opus:medium` are one run under three names ([`canon`]), with one record.

use std::collections::BTreeSet;

use wisp_router_api::{AgentInfo, LEVELS, arm_key, split_key};

use crate::priors::{Priors, shipped};

/// The level baked into a model id (`gemini-4-argon-high` → `high`), v1's `-(level)$`.
pub fn suffix_level(model: &str) -> Option<&'static str> {
    let (_, tail) = model.rsplit_once('-')?;
    LEVELS.iter().find(|l| **l == tail).copied()
}

/// `s` without a trailing `-level`.
pub fn strip_suffix(s: &str) -> &str {
    match s.rsplit_once('-') {
        Some((head, tail)) if LEVELS.contains(&tail) => head,
        _ => s,
    }
}

/// Versions stripped, and a level in the id: claude-sonnet-5-5 and -5-6 are one family, and a new
/// version starts from what the family showed (v1 router.js:139, `[-.]?\d+([.-]\d+)*` removed).
pub fn family(k: &str) -> String {
    let s = strip_suffix(k).as_bytes();
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let sep = matches!(s[i], b'-' | b'.') && s.get(i + 1).is_some_and(u8::is_ascii_digit);
        if !sep && !s[i].is_ascii_digit() {
            out.push(s[i]);
            i += 1;
            continue;
        }
        // one version number: an optional separator, digits, then more `.n` or `-n` parts
        i += usize::from(sep);
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
        }
        while i + 1 < s.len() && matches!(s[i], b'.' | b'-') && s[i + 1].is_ascii_digit() {
            i += 1;
            while i < s.len() && s[i].is_ascii_digit() {
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The harness · model an arm runs on, whatever its level: probation, cooling and compare go by it.
pub fn base_of(k: &str) -> String {
    let p = split_key(k);
    arm_key(p.agent, p.model, "")
}

pub(crate) fn canon_with(p: &Priors, key: &str) -> String {
    let k = split_key(key);
    let m = if k.model.is_empty() { p.aliases.get(k.agent).map_or("", String::as_str) } else { k.model };
    let e = if k.effort.is_empty() { p.defaults.get(&arm_key(k.agent, m, "")).map_or("", String::as_str) } else { k.effort };
    arm_key(k.agent, m, e)
}

/// What an arm really runs: the harness's default model named and the model's default level named.
pub fn canon(key: &str) -> String {
    canon_with(&shipped().priors, key)
}

pub(crate) fn level_with(p: &Priors, k: &str) -> String {
    let c = canon_with(p, k);
    let e = split_key(&c).effort;
    if e.is_empty() { suffix_level(split_key(k).model).unwrap_or("").to_owned() } else { e.to_owned() }
}

/// The level an arm thinks at ('' when nobody knows).
pub fn level_of(k: &str) -> String {
    level_with(&shipped().priors, k)
}

pub(crate) fn stem_with(p: &Priors, k: &str) -> String {
    let c = canon_with(p, k);
    let s = split_key(&c);
    arm_key(s.agent, strip_suffix(s.model), "")
}

/// The arm without its level, named or in its id: every variant of one model.
pub fn stem_key(k: &str) -> String {
    stem_with(&shipped().priors, k)
}

const SMALL: [&str; 9] = ["haiku", "flash", "mini", "nano", "lite", "small", "free", "fast", "low"];
const STRONG: [&str; 7] = ["opus", "argon", "ultra", "pro", "xhigh", "high", "max"];

/// How strong a model is: 1 small or free, 2 everyday, 3 frontier. From the benchmarks' tiers where
/// they cover it, else its name (whole segments: "gemini" is not "mini"), else its family's.
pub fn tier_of(key: &str) -> u8 {
    let tiers = &shipped().priors.tiers;
    let c = base_of(&canon(key));
    let stem = strip_suffix(&c);
    if let Some(t) = tiers.get(&c).or_else(|| tiers.get(stem)).filter(|t| **t > 0) {
        return *t;
    }
    let p = split_key(&c);
    let lower = p.model.to_lowercase();
    let named = |list: &[&str]| lower.split(['-', '/', '.', ':', '_']).any(|x| list.contains(&x));
    if named(&SMALL) {
        return 1;
    }
    let fam = family(stem);
    if let Some(t) = tiers.iter().find(|(k, t)| **t > 0 && split_key(k).agent == p.agent && family(k) == fam).map(|(_, t)| *t) {
        return t;
    }
    if named(&STRONG) { 3 } else { 2 }
}

/// The levels each goal may run at, where the harness has them ('' is the model's own default).
/// Cheap thinks low. Balanced runs the model as its makers ship it, or one step up (Sonnet scores 15
/// points more at high). Best thinks hard; xhigh costs 2.5× high, so it has to earn it.
pub fn levels_for(efforts: &[String], goal: &str, def: &str) -> Vec<String> {
    let has = |e: &str| efforts.iter().any(|x| x == e);
    let mut band: Vec<&str> = match goal {
        "cheap" => ["minimal", "low"].into_iter().filter(|e| has(e)).collect(),
        "best" => ["high", "xhigh"].into_iter().filter(|e| has(e)).collect(),
        _ => {
            let from = LEVELS.iter().position(|l| *l == if def.is_empty() { "medium" } else { def });
            // v1: indexOf of an unknown default is -1, so the search starts at the weakest level
            let start = from.map_or(0, |i| i + 1);
            let up = LEVELS[start.min(LEVELS.len())..].iter().find(|l| has(l)).copied();
            let mut b = vec![""];
            if let Some(u) = up.filter(|u| *u != "xhigh" && *u != "max") {
                b.push(u);
            }
            b
        }
    };
    // the default named outright is the same run as '': keep one
    if !def.is_empty() && band.contains(&"") && band.contains(&def) {
        band.retain(|e| *e != def);
    }
    if band.is_empty() { vec![String::new()] } else { band.into_iter().map(str::to_owned).collect() }
}

/// "X-High", "High", "Low".
pub fn effort_label(e: &str) -> String {
    if e == "xhigh" {
        return "X-High".into();
    }
    let mut c = e.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

/// An installed harness · model wisp may route to.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub key: String,
    pub agent: String,
    pub model: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub delegates: bool,
}

/// The benchmarks know it: a score at any level, or a tier row alone (v1 #763: Fable has a tier and no score
/// yet, and without the tier Auto never offered it).
fn known_to_priors(k: &str) -> bool {
    let b = &shipped().bases;
    b.contains(strip_suffix(&base_of(&canon(k))))
        || b.contains(strip_suffix(k))
        || shipped().priors.tiers.contains_key(strip_suffix(&base_of(k)))
}

/// The arms wisp may route to: each harness's default model, the models the priors know, models
/// with history here, and new models in a known family (on probation).
pub fn candidates(agents: &[AgentInfo], known: &BTreeSet<String>) -> Vec<Candidate> {
    let mut fams: BTreeSet<String> = known.iter().map(|k| family(k)).collect();
    fams.extend(shipped().families.iter().cloned());
    let mut out = Vec::new();
    for a in agents.iter().filter(|a| a.available) {
        let mut ids: Vec<&str> = vec![""];
        for m in &a.models {
            if !ids.contains(&m.id.as_str()) {
                ids.push(&m.id);
            }
        }
        for id in ids {
            let k = arm_key(&a.id, id, "");
            if !id.is_empty() && !known_to_priors(&k) && !known.contains(&k) && !fams.contains(&family(&k)) {
                continue;
            }
            let m = a.models.iter().find(|x| x.id == id);
            let label = match (id, m.and_then(|m| m.label.as_deref()).filter(|l| !l.is_empty())) {
                ("", _) => a.name.clone(),
                (_, Some(l)) => format!("{} · {l}", a.name),
                _ => format!("{} · {id}", a.name),
            };
            let efforts = m.and_then(|m| m.efforts.clone()).or_else(|| a.efforts.clone()).unwrap_or_default();
            out.push(Candidate {
                key: k,
                agent: a.id.clone(),
                model: id.to_owned(),
                label,
                efforts,
                delegates: a.delegates != Some(false),
            });
        }
    }
    out
}

/// Among a model's variants with the level in its id, the goal picks the ones at its levels.
pub fn by_named_level<C: AsRef<Candidate>>(cands: Vec<C>, goal: &str) -> Vec<C> {
    let want: &[&str] = match goal {
        "cheap" => &["minimal", "low"],
        "best" => &["high", "xhigh", "max"],
        _ => &["medium"],
    };
    let named = |c: &Candidate| if c.efforts.is_empty() { suffix_level(&c.model) } else { None };
    let fits: BTreeSet<String> =
        cands.iter().map(AsRef::as_ref).filter(|c| named(c).is_some_and(|n| want.contains(&n))).map(|c| stem_key(&c.key)).collect();
    cands
        .into_iter()
        .filter(|c| {
            let c = c.as_ref();
            named(c).is_none_or(|n| want.contains(&n) || !fits.contains(&stem_key(&c.key)))
        })
        .collect()
}

impl AsRef<Candidate> for Candidate {
    fn as_ref(&self) -> &Candidate {
        self
    }
}

/// A rule from Settings → Auto (never pick, prefer): 'claude' (the harness), 'claude:sonnet' (that
/// model at every level) or 'claude:sonnet:high', optionally only for one kind of task ('…@ui').
pub fn rule_matches(rule: &str, key: &str, kind: Option<&str>) -> bool {
    let mut parts = rule.split('@');
    let what = parts.next().unwrap_or_default();
    if let Some(only) = parts.next().filter(|o| !o.is_empty())
        && Some(only) != kind
    {
        return false;
    }
    if !what.contains(':') {
        return split_key(key).agent == what;
    }
    let r = split_key(what);
    let k = split_key(key);
    let ck = canon(key);
    let c = split_key(&ck);
    if r.agent != k.agent {
        return false;
    }
    let same = r.model == k.model || r.model == c.model || canon(&arm_key(r.agent, r.model, "")) == canon(&arm_key(k.agent, k.model, ""));
    same && (r.effort.is_empty() || r.effort == if k.effort.is_empty() { c.effort } else { k.effort })
}

/// v1 `round(x, d)`: half away from zero, the same as `Math.round` for the positive numbers here.
pub fn round(x: f64, d: i32) -> f64 {
    let f = 10f64.powi(d);
    (x * f).round() / f
}

#[cfg(test)]
mod fable_tests {
    use super::*;

    /// Fable 5.2 (`claude:fable`) is ranked a frontier model, is its own family (never folded into Opus), and the
    /// never-pick and prefer rules name it like any model.
    #[test]
    fn router_ranks_claude_fable() {
        assert_eq!(tier_of("claude:fable"), 3);
        assert_eq!(tier_of("claude:fable:high"), 3);
        assert_ne!(family("claude:fable"), family("claude:opus"));
        assert_eq!(family("claude:claude-fable-5-2"), family("claude:claude-fable-5-3"), "versions are one family");
        assert!(rule_matches("claude:fable", "claude:fable:high", None));
        assert!(rule_matches("claude:fable@ui", "claude:fable", Some("ui")));
        assert!(!rule_matches("claude:fable", "claude:opus:high", None));
        assert!(!rule_matches("claude:opus", "claude:fable", None));
        assert_eq!(split_key(&canon("claude:fable")).model, "fable");
    }

    /// v1 #763: a model the benchmarks only place by tier is a candidate, and on probation even on the first look:
    /// Auto suggests it and runs it only when nothing else fits, never in place of a scored arm unasked.
    #[test]
    fn auto_offers_a_tier_only_model_on_probation() {
        use crate::choose::{Prefs, choose};
        use crate::math::Mulberry32;
        use crate::router::Router;
        use crate::state::{Life, RouterState};
        use wisp_router_api::{AgentInfo, ChooseArgs, ModelInfo};
        let m = |id: &str| ModelInfo { id: id.into(), label: None, efforts: None };
        let agents = vec![AgentInfo {
            id: "claude".into(),
            name: "Claude Code".into(),
            available: true,
            models: ["", "fable", "opus", "sonnet", "haiku"].map(m).to_vec(),
            ..AgentInfo::default()
        }];
        assert!(
            candidates(&agents, &std::collections::BTreeSet::new()).iter().any(|c| c.key == "claude:fable"),
            "a tier row makes it a candidate"
        );
        let mut r = Router::new(RouterState::default());
        r.sync(&agents, false, 1_000);
        assert_eq!(r.st.arms.get("claude:fable").map(|a| a.state), Some(Life::New), "no score: on probation from the first look");
        assert_eq!(r.st.arms.get("claude:").map(|a| a.state), Some(Life::Ready), "the harness's default is ready");
        let only = ["claude:", "claude:opus", "claude:sonnet", "claude:haiku"].map(str::to_owned).to_vec();
        for seed in 1..=10 {
            let a = ChooseArgs { prompt: "fix the bug".into(), blocked: Some(only.clone()), ..ChooseArgs::default() };
            let p = choose(&r.st, 2_000, &a, &agents, &Prefs::default(), &mut Mulberry32::new(seed)).unwrap();
            assert_eq!(split_key(&p.route.key).model, "fable", "{}", p.route.key);
            let a = ChooseArgs { prompt: "fix the bug".into(), blocked: Some(vec!["claude:fable".into()]), ..ChooseArgs::default() };
            let p = choose(&r.st, 2_000, &a, &agents, &Prefs::default(), &mut Mulberry32::new(seed)).unwrap();
            assert_ne!(split_key(&p.route.key).model, "fable");
        }
    }
}
