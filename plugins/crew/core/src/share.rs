//! Sharing crew members (v1 server/crew-share.js): a blueprint is who a member is (name, role, face,
//! brief, schedule, what starts them, mode, harness, kit, delegates), never where they run or what
//! they've done. A .crew.json is `{ wispCrew: 1, members: [blueprint, …] }`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_crew_api::{BRIEF_MAX, CREW_COLORS, MAX_CREW, MAX_PARALLEL, MEMBER_KINDS, MODES};

use crate::cron::{Words, read_schedule};
use crate::error::{Result, bad};
use crate::kit::{Ids, normalize_kit};
use crate::memory::clamp_notebook;
use crate::member::{avatar_of, is_effort, is_name};
use crate::mentions::handle_of;
use crate::text::{clip, squash, str_of, thousands, truncate};

pub const CREW_FILE: u64 = 1;

/// A kit file as it travels: no id, no folder; `on` only when it's off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BpKit {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<bool>,
}

/// A delegate as it travels: another member of the file by key, or a harness.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BpTeam {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crew: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blueprint {
    pub key: String,
    pub name: String,
    pub role: String,
    pub avatar: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub brief: String,
    pub cron: String,
    pub on: Vec<String>,
    pub mode: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub parallel: u32,
    pub kit: Vec<BpKit>,
    pub team: Vec<BpTeam>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook: Option<String>,
}

/// v1 `KEY`: lowercase letters, digits and dashes, at most 41.
pub fn is_key(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 41 && b[0] != b'-' && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// v1 `HARNESS`: a harness id.
pub fn is_harness_id(s: &str) -> bool {
    (1..=30).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn arr(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(x) => vec![x.clone()],
    }
}

fn truthy(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null | Value::Bool(false))) && v.and_then(Value::as_str) != Some("")
}

struct NoIds;
impl Ids for NoIds {
    fn next_id(&mut self) -> String {
        String::from("shared0")
    }
}

fn bp_kit(raw: Option<&Value>) -> Result<Vec<BpKit>> {
    let list: Vec<Value> = arr(raw).into_iter().map(|mut k| {
        if let Some(o) = k.as_object_mut() {
            o.remove("path");
        }
        k
    }).collect();
    let kit = normalize_kit(&Value::Array(list), &|_| false, &mut NoIds).map_err(|e| e.prefixed("kit"))?;
    Ok(kit.into_iter().map(|k| BpKit { kind: k.kind, name: k.name, description: k.description, body: k.body, on: (!k.on).then_some(false) }).collect())
}

fn bp_team(raw: Option<&Value>) -> Result<Vec<BpTeam>> {
    arr(raw)
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if !t.is_object() {
                return Err(bad(format!("team[{i}]: {{ \"crew\": \"<key>\" }} or {{ \"agent\": \"codex\" }}")));
            }
            if let Some(c) = t.get("crew").filter(|c| !c.is_null()) {
                let c = str_of(Some(c));
                if !is_key(&c) {
                    return Err(bad(format!("team[{i}]: crew is the key of another member in the same file")));
                }
                return Ok(BpTeam { crew: Some(c), ..BpTeam::default() });
            }
            let agent = str_of(t.get("agent"));
            if !is_harness_id(&agent) {
                return Err(bad(format!("team[{i}]: agent is a harness id, like codex")));
            }
            let text = |k: &str, n: usize| Some(clip(&squash(&str_of(t.get(k))), n)).filter(|s| !s.is_empty());
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to 2..=4
            let count = t.get("count").and_then(Value::as_f64).filter(|c| *c > 1.0).map(|c| c.floor().min(4.0) as u32);
            Ok(BpTeam { agent: Some(agent), name: text("name", 40), model: text("model", 120), effort: text("effort", 20), use_: text("use", 300), count, crew: None })
        })
        .collect()
}

#[allow(clippy::type_complexity)] // (brief, cron, on, mode, agent, model, parallel), destructured at the one call
fn bp_fields(raw: &Value, words: &dyn Words) -> Result<(String, String, Vec<String>, String, String, String, u32)> {
    let brief = crate::text::unix(&str_of(raw.get("brief"))).trim().to_owned();
    if brief.chars().count() > BRIEF_MAX {
        return Err(bad(format!("brief: at most {} characters", thousands(BRIEF_MAX))));
    }
    let cron = read_schedule(&str_of(raw.get("cron")), words).map_err(|e| e.prefixed("cron"))?;
    let mut on: Vec<String> = arr(raw.get("on")).iter().map(|v| str_of(Some(v))).collect();
    on.sort();
    on.dedup();
    if let Some(k) = on.iter().find(|k| !MEMBER_KINDS.contains(&k.as_str())) {
        return Err(bad(format!("on: {k} isn't one of finished, done, ci")));
    }
    let mode = Some(str_of(raw.get("mode"))).filter(|s| !s.is_empty()).unwrap_or_else(|| "auto".into());
    if !MODES.contains(&mode.as_str()) {
        return Err(bad("mode: plan, edits or auto"));
    }
    let agent = Some(str_of(raw.get("agent"))).filter(|s| !s.is_empty()).unwrap_or_else(|| "auto".into());
    if !is_harness_id(&agent) {
        return Err(bad("agent: a harness id, like claude or codex (or auto)"));
    }
    let effort = str_of(raw.get("effort"));
    if !is_effort(&effort) {
        return Err(bad("effort: a thinking level, like high"));
    }
    let parallel = match raw.get("parallel") {
        None => 2.0,
        Some(v) => v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(f64::NAN).floor(),
    };
    if !(1.0..=f64::from(MAX_PARALLEL)).contains(&parallel) {
        return Err(bad(format!("parallel: 1 to {MAX_PARALLEL}")));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // checked to be 1..=5
    Ok((brief, cron, on, mode, agent, effort, parallel as u32))
}

/// Anything → a clean blueprint, or a 400 saying what's wrong (v1 `normalizeBlueprint`). Paths are refused.
pub fn normalize_blueprint(raw: &Value, words: &dyn Words) -> Result<Blueprint> {
    if !raw.is_object() {
        return Err(bad("A crew member is a JSON object with at least a name."));
    }
    for (k, what) in [("cwd", "folder"), ("machine", "machine")] {
        if truthy(raw.get(k)) {
            return Err(bad(format!("{k}: a shared member has no {what}; whoever adds them picks one.")));
        }
    }
    let name = squash(&str_of(raw.get("name")));
    if name.is_empty() {
        return Err(bad("name: required"));
    }
    if !is_name(&name) {
        return Err(bad(format!("name: up to 24 letters, digits, spaces, dots, dashes or underscores, not “{}”", truncate(&name, 40))));
    }
    let key = match raw.get("key") {
        None | Some(Value::Null) => String::new(),
        Some(v) => str_of(Some(v)),
    };
    let key = if key.is_empty() { Some(handle_of(&name)).filter(|h| !h.is_empty()).unwrap_or_else(|| "member".into()) } else { key };
    if !is_key(&key) {
        return Err(bad("key: lowercase letters, digits and dashes (at most 41)"));
    }
    let (brief, cron, on, mode, agent, effort, parallel) = bp_fields(raw, words)?;
    let kit = bp_kit(raw.get("kit"))?;
    let team = bp_team(raw.get("team"))?;
    if team.iter().any(|t| t.crew.as_deref() == Some(key.as_str())) {
        return Err(bad("team: a member can't delegate to themselves"));
    }
    let notebook = raw.get("notebook").and_then(Value::as_str).map(|n| clamp_notebook(n.trim())).filter(|n| !n.is_empty());
    let color = raw.get("color").and_then(Value::as_str).filter(|c| CREW_COLORS.contains(c)).map(str::to_owned);
    Ok(Blueprint { key, name, role: clip(&squash(&str_of(raw.get("role"))), 60), avatar: avatar_of(&str_of(raw.get("avatar"))), color, brief, cron, on, mode, agent, model: clip(&str_of(raw.get("model")), 120), effort, parallel, kit, team, notebook })
}

/// Blueprints checked together: each on its own, then unique keys and names, then delegates in the file.
pub fn normalize_blueprints(list: &[Value], place: &str, words: &dyn Words) -> Result<Vec<Blueprint>> {
    let out: Vec<Blueprint> = list
        .iter()
        .enumerate()
        .map(|(i, x)| {
            normalize_blueprint(x, words).map_err(|e| {
                let who = x.get("name").filter(|n| truthy(Some(n))).map_or(String::new(), |n| format!(" ({})", truncate(&str_of(Some(n)), 24)));
                bad(format!("{place}[{i}]{who}: {e}"))
            })
        })
        .collect::<Result<_>>()?;
    let mut seen: Vec<(String, String)> = Vec::new();
    for (i, b) in out.iter().enumerate() {
        let h = handle_of(&b.name);
        if seen.iter().any(|(k, sh)| *k == b.key || *sh == h) {
            return Err(bad(format!("{place}[{i}] ({}): two members share the key {} or the name {}", b.name, b.key, b.name)));
        }
        seen.push((b.key.clone(), h));
    }
    for b in &out {
        if let Some(c) = b.team.iter().filter_map(|t| t.crew.as_deref()).find(|c| !seen.iter().any(|(k, _)| k == c)) {
            return Err(bad(format!("{place} ({}): delegates to {c}, who isn't in this file", b.name)));
        }
    }
    Ok(out)
}

/// A shared file, parsed: its members.
#[derive(Debug, Clone, PartialEq)]
pub enum CrewFile {
    Members(Vec<Blueprint>),
}

pub fn parse_crew_file(j: &Value, words: &dyn Words) -> Result<CrewFile> {
    let list = match j {
        Value::Array(a) => a.clone(),
        Value::Object(o) if o.get("members").is_some_and(Value::is_array) => o.get("members").and_then(Value::as_array).cloned().unwrap_or_default(),
        Value::Object(o) if truthy(o.get("name")) => vec![j.clone()],
        _ => return Err(bad("A crew file is { \"wispCrew\": 1, \"members\": [ … ] }.")),
    };
    if let Some(v) = j.get("wispCrew")
        && v.as_u64() != Some(CREW_FILE)
    {
        return Err(bad(format!("wispCrew: this wisp reads version {CREW_FILE}; update wisp to read this file.")));
    }
    if list.is_empty() {
        return Err(bad("That file has no crew members in it."));
    }
    if list.len() > MAX_CREW {
        return Err(bad(format!("At most {MAX_CREW} members in one file.")));
    }
    normalize_blueprints(&list, "members", words).map(CrewFile::Members)
}

/// A name nobody on the crew has (`taken`: their handles): Scout, then Scout 2, Scout 3… at most 24 characters.
pub fn unique_name(name: &str, taken: &[String]) -> String {
    let has = |n: &str| taken.contains(&handle_of(n));
    if !has(name) {
        return name.to_owned();
    }
    let mut i: usize = 2;
    loop {
        let keep = 23usize.saturating_sub(i.to_string().len());
        let n = format!("{} {i}", clip(name, keep).trim());
        if !has(&n) {
            return n;
        }
        i += 1;
    }
}

/// v1 `adapters[id].name`.
pub fn harness_name(id: &str) -> &str {
    match id {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "cursor" => "Cursor",
        "antigravity" => "Antigravity",
        "grok" => "Grok",
        "copilot" => "Copilot",
        _ => id,
    }
}
