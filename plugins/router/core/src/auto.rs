//! Auto wired to the rest of wisp, the pure half (v1 services/auto.js, routes/auto.js): Settings →
//! Auto and its checks, what a reported outcome teaches the router, the preview's shape, and the
//! order of overlapping harness detections.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use wisp_router_api::{
    Added, AgentInfo, GOALS, GoalInfo, Hero, NoPreview, Outcome, Pick, PickBrief, Preview, PreviewResult, RouterPatch, Scout, Settings, SettingsView, Signals, StoredRoute,
    SummaryLike, TYPES, arm_key, is_goal,
};

use crate::Error;
use crate::choose::Prefs;
use crate::router::{Observe, Router};

/// The allowed harnesses narrow Auto's pick wherever one of them can run. A place that has none of
/// them (a machine with other harnesses signed in) gets what it has (v1 services/auto.js:53).
pub fn allowed_at(s: &Settings, agents: &[AgentInfo]) -> Option<Vec<String>> {
    let allowed = s.allowed.as_ref().filter(|a| !a.is_empty())?;
    agents.iter().any(|a| a.available && allowed.contains(&a.id)).then(|| allowed.clone())
}

/// What every pick reads of Settings → Auto, for the harnesses at `agents`.
pub fn prefs(s: &Settings, agents: &[AgentInfo]) -> Prefs {
    Prefs { explore: s.explore, allowed: allowed_at(s, agents), blocked: s.blocked.clone(), prefer: s.prefer.clone(), habits: s.habits }
}

/// Auto's goal: `model` when it names one (a launch's model is the goal for Auto), else Settings.
pub fn goal_of<'a>(model: Option<&'a str>, s: &'a Settings) -> &'a str {
    model.filter(|m| is_goal(m)).or(s.goal.as_deref().filter(|g| is_goal(g))).unwrap_or("balanced")
}

pub fn settings_view(s: &Settings) -> SettingsView {
    SettingsView { explore: s.explore, allowed: s.allowed.clone().filter(|a| !a.is_empty()), blocked: s.blocked.clone(), prefer: s.prefer.clone(), habits: s.habits, escalate: s.escalate, best2: s.best2, scout: s.scout }
}

pub fn goals() -> BTreeMap<String, GoalInfo> {
    GOALS.iter().map(|(id, label, value, hint)| ((*id).to_owned(), GoalInfo { label: (*label).into(), value: *value, hint: (*hint).into() })).collect()
}

fn rule_re() -> Option<&'static Regex> {
    static R: OnceLock<Option<Regex>> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[\w-]+(:[\w./-]*(:[\w-]+)?)?(@[a-z]+)?$").ok()).as_ref()
}

/// A Never pick / Prefer list, checked with v1's messages (routes/auto.js:27-32).
fn rules(k: &str, v: &serde_json::Value, harness: &dyn Fn(&str) -> bool) -> Result<Vec<String>, Error> {
    let list = v.as_array().ok_or_else(|| Error::Invalid(format!("{k} must be a list")))?;
    let mut out: Vec<String> = Vec::new();
    for x in list {
        let ok = x.as_str().filter(|s| {
            let head = s.split([':', '@']).next().unwrap_or_default();
            let kind_ok = s.split_once('@').is_none_or(|(_, t)| TYPES.contains(&t));
            rule_re().is_some_and(|r| r.is_match(s)) && harness(head) && kind_ok
        });
        let Some(s) = ok else {
            let shown = x.as_str().map_or_else(|| x.to_string(), str::to_owned);
            return Err(Error::Invalid(format!("{k}: \"{shown}\" isn't a harness, harness:model or harness:model:level (optionally @kind, one of {})", TYPES.join(", "))));
        };
        if !out.iter().any(|o| o == s) {
            out.push(s.to_owned());
        }
    }
    out.truncate(60);
    Ok(out)
}

/// PATCH /router. Everything is checked before anything changes. `harness`: is this a harness id.
pub fn apply_patch(s: &mut Settings, p: &RouterPatch, harness: &dyn Fn(&str) -> bool) -> Result<(), Error> {
    if let Some(g) = p.goal.as_deref().filter(|g| !is_goal(g)) {
        let _ = g;
        return Err(Error::Invalid(format!("goal must be one of {}", GOALS.map(|g| g.0).join(", "))));
    }
    let blocked = p.blocked.as_ref().map(|v| rules("blocked", v, harness)).transpose()?;
    let prefer = p.prefer.as_ref().map(|v| rules("prefer", v, harness)).transpose()?;
    let scout = match p.scout.as_ref().map(|v| v.as_str()) {
        None => None,
        Some(Some("off")) => Some(Scout::Off),
        Some(Some("big")) => Some(Scout::Big),
        Some(Some("all")) => Some(Scout::All),
        Some(_) => return Err(Error::Invalid("scout must be off, big or all".into())),
    };
    if let Some(g) = &p.goal {
        s.goal = Some(g.clone());
    }
    if let Some(e) = p.explore {
        s.explore = e;
    }
    if let Some(a) = &p.allowed {
        s.allowed = a.as_array().map(|l| l.iter().filter_map(|x| x.as_str()).filter(|x| harness(x)).map(str::to_owned).collect());
    }
    for (field, v) in [(&mut s.escalate, p.escalate), (&mut s.best2, p.best2), (&mut s.habits, p.habits)] {
        if let Some(v) = v {
            *field = v;
        }
    }
    if let Some(b) = blocked {
        s.blocked = b;
    }
    if let Some(x) = prefer {
        s.prefer = x;
    }
    if let Some(x) = scout {
        s.scout = x;
    }
    Ok(())
}

/// The preview's v1 shape: the pick and why, or why there is none (v1 services/auto.js:155-161).
pub fn preview_of(pick: Option<Pick>, place: &str) -> PreviewResult {
    let Some(p) = pick else {
        let why = if place.is_empty() { "Nothing Auto may use can run right now".to_owned() } else { format!("Nothing Auto may use is signed in on {place}") };
        return PreviewResult::Nothing(NoPreview { pick: None, why });
    };
    let r = p.route;
    PreviewResult::Pick(Box::new(Preview {
        pick: PickBrief { agent: p.agent, model: p.model, effort: p.effort, key: p.key, label: p.label },
        goal: r.goal,
        kind: r.kind,
        size: r.size,
        chance: r.chance,
        usd: r.usd,
        minutes: r.minutes,
        tier: r.tier,
        why: r.why,
        alternatives: r.alternatives,
        suggest: r.suggest,
    }))
}

/// The error a launch with Auto gets when nothing can run (v1 services/auto.js:143).
pub fn no_pick_message(place: &str) -> String {
    if place.is_empty() { "Auto found no installed harness to run this on.".into() } else { format!("Auto found no harness installed and signed in on {place}. Sign in to one there (Run with → pick it).") }
}

fn flag(v: Option<&serde_json::Value>, k: &str) -> Option<&serde_json::Value> {
    v.and_then(|x| x.get(k))
}

/// A routed task's outcome so far, from its list row. Follow-ups after the first turn count as
/// corrections; a merged or closed PR settles it, unless you moved the task to another harness or
/// model first, which then counts as your pick, once (v1 services/auto.js:85-101).
fn apply_summary(r: &mut Router, sum: &SummaryLike, now: i64) {
    let running = |x: &Option<String>| x.as_deref() == Some("running");
    if sum.id.is_empty() || r.st.route(&sum.id).is_none() || running(&sum.status) || running(&sum.state) {
        return;
    }
    let pr = flag(sum.pr.as_ref(), "state").and_then(|s| s.as_str());
    let switched = flag(sum.route.as_ref(), "switched").and_then(serde_json::Value::as_bool) == Some(true);
    let hero = match sum.status.as_deref() {
        Some("done") => Some(Hero::Done),
        Some("partial") => Some(Hero::Partial),
        Some("blocked") => Some(Hero::Blocked),
        Some("info") => Some(Hero::Info),
        _ => None,
    };
    let followups = sum.followups.unwrap_or_else(|| sum.turn_count.unwrap_or(1).max(1) - 1);
    let patch = Signals { hero, followups: Some(followups), merged: (pr == Some("MERGED")).then_some(true), closed: (pr == Some("CLOSED")).then_some(true), switched: switched.then_some(true), ..Signals::default() };
    let Some(route) = r.signal(&sum.id, &patch, now) else { return };
    let agent = sum.agent.as_deref().unwrap_or_default();
    if switched && !route.manual && route.signals.switched_to.is_none() && !agent.is_empty() && agent != "auto" {
        let (model, effort) = (sum.model.as_deref().unwrap_or_default(), sum.effort.as_deref().unwrap_or_default());
        r.observe(&Observe { agent, model, effort, kind: Some(&route.kind), weight: Some(2.0), ..Observe::default() }, now);
        r.signal(&sum.id, &Signals { switched_to: Some(arm_key(agent, model, effort)), ..Signals::default() }, now);
    }
}

/// What a reported outcome teaches the router (v1 index.js:315-330, services/auto.js, pipeline.js
/// moveOn). Returns the arms that showed up, for a `router.added` event.
pub fn apply(r: &mut Router, o: &Outcome, now: i64) -> Vec<Added> {
    match o {
        Outcome::Launched { id, route } => r.record(id, route.clone(), now),
        Outcome::Manual { id, agent, model, effort, prompt, attachments } => {
            let seen = r.observe(&Observe { agent, model, effort, prompt, attachments: *attachments, ..Observe::default() }, now);
            if let Some((key, _, kind)) = seen {
                let route = StoredRoute { key, kind, label: Some(agent.clone()), manual: true, at: now, ..StoredRoute::default() };
                r.record(id, route, now);
            }
        }
        Outcome::TurnEnded { id, first, error, limited, interrupted, cost_usd, ms } => {
            // a run that stopped at its account's usage limit isn't the model's fault (index.js:327)
            if r.st.route(id).is_some() && !interrupted && *first && !limited {
                r.signal(id, &Signals { error: error.then_some(true), cost_usd: *cost_usd, ms: *ms, ..Signals::default() }, now);
            }
        }
        Outcome::Summary { summary } => apply_summary(r, summary, now),
        Outcome::Signal { id, signals } => {
            r.signal(id, signals, now);
        }
        Outcome::Limited { id, key, limit, why } => {
            r.cool(key, limit, why, now);
            if let Some(id) = id {
                r.void(id);
            }
        }
        Outcome::Override { kind, auto, chose, prompt } => {
            let kind = kind.clone().filter(|k| !k.is_empty()).unwrap_or_else(|| crate::classify::task(prompt, 0).0.to_owned());
            r.override_pick(&kind, auto, chose, prompt, now);
        }
        Outcome::Agents { agents, more } => return r.sync(agents, *more, now),
    }
    Vec::new()
}

/// Overlapping harness detections (v1 services/auto.js:21-31): an older detection still running
/// (with what it read before a sign-in) doesn't overwrite a newer answer when it finishes. Newer ones
/// that are only running don't count: every look at the list starts one, and looks faster than a
/// detection would otherwise throw away every answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Detections {
    detecting: u64,
    answered: u64,
}

impl Detections {
    /// A detection starts: its number.
    pub fn begin(&mut self) -> u64 {
        self.detecting += 1;
        self.detecting
    }
    /// Detection `n` finished: true if its answer is the one to keep.
    pub fn finish(&mut self, n: u64) -> bool {
        if n < self.answered {
            return false;
        }
        self.answered = n;
        true
    }
}
