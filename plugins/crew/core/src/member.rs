//! A member from a body (v1 crew.js `normalizeMember`, subagents.js `normalizeTeam`): checked, with its
//! memory and bookkeeping carried over on an edit.

use std::collections::BTreeMap;

use serde_json::Value;
use wisp_crew_api::commands::MemberBody;
use wisp_crew_api::{BRIEF_MAX, CREW_COLORS, HARNESSES, MAX_PARALLEL, MODES, Member, TeamRow};

use crate::cron::{Words, read_schedule};
use crate::error::{Result, bad};
use crate::kit::{Ids, is_id, normalize_kit};
use crate::memory::clamp_notebook;
use crate::mentions::handle_of;
use crate::text::{clip, squash, str_of};

/// What a member is checked against: the rest of the crew, this computer's folders and machines, and
/// the schedule grammar.
pub struct Checks<'a> {
    /// the other members, for unique names (the one being edited may be among them)
    pub taken: &'a [Member],
    pub exists: &'a dyn Fn(&str) -> bool,
    pub machine_ok: &'a dyn Fn(&str) -> bool,
    pub words: &'a dyn Words,
    /// an agent profile's name (`agents:` in a formula, ADR-0028): a member may name one instead of a
    /// harness; its jobs' tasks resolve it
    pub agent_ok: &'a dyn Fn(&str) -> bool,
}

impl std::fmt::Debug for Checks<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Checks").field("taken", &self.taken.len()).finish_non_exhaustive()
    }
}

/// v1 `NAME`: up to 24 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.
pub fn is_name(s: &str) -> bool {
    let mut it = s.chars();
    it.next().is_some_and(char::is_alphanumeric) && s.chars().count() <= 24 && it.all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

fn is_word_ascii(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// v1 `/^[\w-]{0,20}$/` (an effort level).
pub fn is_effort(s: &str) -> bool {
    s.chars().count() <= 20 && s.chars().all(|c| is_word_ascii(c) || c == '-')
}

/// v1 `PLACE`: a machine id.
fn is_place(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.chars().all(|c| is_word_ascii(c) || c == '-')
}

/// A spirit's code ("flame.teal.visor.smile.antenna"), or an emoji of a few code points.
pub fn avatar_of(a: &str) -> String {
    let parts: Vec<&str> = a.split('.').collect();
    if parts.len() == 5 && parts.iter().all(|p| (1..=12).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_lowercase())) {
        return a.to_owned();
    }
    a.trim().chars().take(4).collect()
}

/// A team row's name: lowercase letters, digits and dashes, at most 24.
fn slug(s: &str) -> String {
    clip(&crate::kit::skill_name(s), 24)
}

fn unique(base: &str, taken: &mut Vec<String>) -> String {
    let mut name = base.to_owned();
    let mut i = 2;
    while taken.contains(&name) {
        name = format!("{base}-{i}");
        i += 1;
    }
    taken.push(name.clone());
    name
}

fn text(v: &Value, k: &str, n: usize) -> String {
    clip(&squash(&str_of(v.get(k))), n)
}

/// A member's delegates, with unique names (codex, codex-2, …). A crew member runs as its own job.
pub fn normalize_team(list: &Value) -> Result<Vec<TeamRow>> {
    let Some(list) = list.as_array() else { return Ok(Vec::new()) };
    let mut taken = Vec::new();
    let known = |a: &str| HARNESSES.contains(&a);
    list.iter()
        .map(|m| {
            let agent = str_of(m.get("agent"));
            if let Some(crew) = m.get("crew").and_then(Value::as_str).filter(|c| is_id(c)) {
                let base = slug(&str_of(m.get("name")));
                let name = unique(if base.is_empty() { "crew" } else { &base }, &mut taken);
                let label = Some(text(m, "label", 24)).filter(|l| !l.is_empty()).unwrap_or_else(|| name.clone());
                let agent = if known(&agent) { agent } else { "auto".into() };
                return Ok(TeamRow { name, agent, crew: Some(crew.to_owned()), label: Some(label), role: Some(text(m, "role", 60)), use_: text(m, "use", 300), count: 1, ..TeamRow::default() });
            }
            if !known(&agent) && agent != "auto" {
                return Err(bad(format!("unknown subagent harness: {agent}")));
            }
            let base = slug(&str_of(m.get("name")));
            let name = unique(if base.is_empty() { &agent } else { &base }, &mut taken);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to 1..=5
            let count = m.get("count").and_then(Value::as_f64).map_or(1, |c| c.floor().clamp(1.0, 5.0) as u32);
            let effort = str_of(m.get("effort"));
            Ok(TeamRow { name, agent, model: m.get("model").and_then(Value::as_str).map(|s| clip(s, 120)).unwrap_or_default(), effort: if !effort.is_empty() && is_effort(&effort) { effort } else { String::new() }, use_: text(m, "use", 300), count, ..TeamRow::default() })
        })
        .collect()
}

fn pick(body: Option<&String>, prev: Option<&str>, d: &str) -> String {
    body.cloned().or_else(|| prev.map(str::to_owned)).unwrap_or_else(|| d.to_owned())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to 1..=MAX_PARALLEL
fn parallel_of(body: Option<f64>, prev: Option<u32>) -> u32 {
    let v = body.or(prev.map(f64::from)).unwrap_or(2.0).floor();
    let v = if v.is_finite() && v != 0.0 { v } else { 2.0 };
    v.clamp(1.0, f64::from(MAX_PARALLEL)) as u32
}

/// Where it runs: `(sandbox, machine, agent, cwd)`, checked.
fn place(body: &MemberBody, prev: Option<&Member>, c: &Checks) -> Result<(String, String, String, String)> {
    let sandbox = pick(body.sandbox.as_ref(), prev.map(|p| p.sandbox.as_str()), "");
    let sandbox = if sandbox == "job" || sandbox == "own" { sandbox } else { String::new() };
    let machine = if sandbox.is_empty() { pick(body.machine.as_ref(), prev.map(|p| p.machine.as_str()), "") } else { String::new() };
    if !machine.is_empty() && (!is_place(&machine) || !(c.machine_ok)(&machine)) {
        return Err(bad("That machine isn’t one of yours. Add it in Machines first."));
    }
    let agent = pick(body.agent.as_ref(), prev.map(|p| p.agent.as_str()), "auto");
    let agent = if agent.is_empty() { "auto".to_owned() } else { agent };
    if !sandbox.is_empty() && agent != "auto" && agent != "claude" {
        return Err(bad("Only Claude Code signs in to sandboxes so far: pick Claude Code or Auto for a member whose jobs run in a sandbox."));
    }
    let cwd = pick(body.cwd.as_ref(), prev.map(|p| p.cwd.as_str()), "");
    if !cwd.is_empty() && machine.is_empty() && !(c.exists)(&cwd) {
        return Err(bad(format!("Not a folder on this computer: {cwd}")));
    }
    if agent != "auto" && !HARNESSES.contains(&agent.as_str()) && !(c.agent_ok)(&agent) {
        return Err(bad(format!("Unknown harness: {agent}")));
    }
    Ok((sandbox, machine, agent, cwd))
}

/// body → a clean member. `prev`: the member being edited (its memory and bookkeeping carry on).
pub fn normalize_member(body: &MemberBody, prev: Option<&Member>, c: &Checks, ids: &mut dyn Ids, now: i64) -> Result<Member> {
    let name = squash(&pick(body.name.as_ref(), prev.map(|p| p.name.as_str()), ""));
    if name.is_empty() {
        return Err(bad("Give them a name."));
    }
    if !is_name(&name) {
        return Err(bad("A name is up to 24 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit."));
    }
    let prev_id = prev.map(|p| p.id.as_str());
    if c.taken.iter().any(|m| Some(m.id.as_str()) != prev_id && handle_of(&m.name) == handle_of(&name)) {
        return Err(bad(format!("{name} is already on your crew. Pick another name.")));
    }
    let (sandbox, machine, agent, cwd) = place(body, prev, c)?;
    let mode = pick(body.mode.as_ref(), prev.map(|p| p.mode.as_str()), "auto");
    if !MODES.contains(&mode.as_str()) {
        return Err(bad("mode must be plan, edits or auto."));
    }
    let cron = read_schedule(&pick(body.cron.as_ref(), prev.map(|p| p.cron.as_str()), ""), c.words)?;
    let color = pick(body.color.as_ref(), prev.map(|p| p.color.as_str()), "");
    let color = if CREW_COLORS.contains(&color.as_str()) { color } else { prev.map(|p| p.color.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| CREW_COLORS[c.taken.len() % CREW_COLORS.len()].to_owned()) };
    let kit = match &body.kit {
        Some(k) => normalize_kit(k, c.exists, ids)?,
        None => prev.map(|p| p.kit.clone()).unwrap_or_default(),
    };
    let team_src = body.team.clone().unwrap_or_else(|| serde_json::to_value(prev.map(|p| p.team.clone()).unwrap_or_default()).unwrap_or(Value::Null));
    // Not itself: a member never delegates to itself.
    let team_src = match (team_src, prev_id) {
        (Value::Array(a), Some(id)) => Value::Array(a.into_iter().filter(|x| x.get("crew").and_then(Value::as_str) != Some(id)).collect()),
        (v, _) => v,
    };
    let effort = pick(body.effort.as_ref(), prev.map(|p| p.effort.as_str()), "");
    let same_place = prev.is_some_and(|p| p.machine == machine && p.sandbox == sandbox);
    let mut m = prev.cloned().unwrap_or_default();
    m.id = prev.map_or_else(|| ids.next_id(), |p| p.id.clone());
    m.name = name;
    m.role = clip(&squash(&pick(body.role.as_ref(), prev.map(|p| p.role.as_str()), "")), 60);
    m.avatar = avatar_of(&pick(body.avatar.as_ref(), prev.map(|p| p.avatar.as_str()), ""));
    m.color = color;
    m.brief = clip(pick(body.brief.as_ref(), prev.map(|p| p.brief.as_str()), "").trim(), BRIEF_MAX);
    m.model = clip(&pick(body.model.as_ref(), prev.map(|p| p.model.as_str()), ""), 120);
    m.effort = if is_effort(&effort) { effort } else { String::new() };
    m.parallel = parallel_of(body.parallel, prev.map(|p| p.parallel));
    m.team = normalize_team(&team_src)?;
    m.paused = body.paused.or(prev.map(|p| p.paused)).unwrap_or(false);
    // wakes (ADR-0043): given, or v1's `on` read as wakes, or what it had
    let wakes = match (&body.wakes, &body.on) {
        (Some(w), _) => w.clone(),
        (None, Some(on)) => wisp_automations_api::v1::member_wakes(&m.name, on),
        (None, None) => prev.map(|p| p.wakes.clone()).unwrap_or_default(),
    };
    for w in &wakes {
        let mut t = w.clone();
        t.crew.clone_from(&m.name);
        if let Some(p) = wisp_automations_api::spec::check(&t).into_iter().find(|p| !p.starts_with("what it does")) {
            return Err(bad(format!("{}'s wake on {}: {p}", m.name, w.on)));
        }
    }
    m.wakes = wakes;
    if let Some(nb) = &body.notebook {
        m.notebook = clamp_notebook(nb);
    }
    if !same_place {
        m.away = BTreeMap::new(); // jobs it was waiting on elsewhere are gone; its memory stays
    }
    if body.wake_at == Some(None) {
        m.wake_at = None;
    }
    if prev.is_some_and(|p| p.cron != cron) {
        m.last_minute = None;
    }
    if prev.is_none() {
        m.created_at = now;
    }
    (m.sandbox, m.machine, m.agent, m.cwd, m.mode, m.cron, m.kit, m.updated_at) = (sandbox, machine, agent, cwd, mode, cron, kit, now);
    Ok(m)
}
