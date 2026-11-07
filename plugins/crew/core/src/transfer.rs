//! Export and import of shared members (v1 crew-share.js `toBlueprint`, `exportCrew`, `planImport`,
//! `applyImport`). Import is all or nothing: every member is built first, the crew changes only after,
//! and they join paused.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_crew_api::commands::MemberBody;
use wisp_crew_api::{HARNESSES, MAX_CREW, Member};

use crate::cron::CronOnly;
use crate::error::{Error, Result, bad};
use crate::kit::Ids;
use crate::member::{Checks, normalize_member, normalize_team};
use crate::mentions::handle_of;
use crate::share::{BpTeam, Blueprint, CREW_FILE, harness_name, normalize_blueprint, unique_name};
use crate::text::{squash, str_of};

/// A member as the import would add it, with notes on what changed on the way in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    #[serde(flatten)]
    pub bp: Blueprint,
    pub cwd: String,
    pub skip: bool,
    pub needs_project: bool,
    pub notes: Vec<String>,
}

fn known(agent: &str) -> bool {
    HARNESSES.contains(&agent)
}

/// What importing would do (the review, then for real). `taken`: the crew's handles; `agents`: the
/// harnesses installed here; `choices`: `{ [key]: { name, cwd, skip } }`.
pub fn plan_import(members: &[Blueprint], taken: &[String], agents: &[String], choices: &Value) -> Result<Vec<PlanItem>> {
    let mut taken = taken.to_vec();
    let choice = |k: &str| choices.get(k).cloned().unwrap_or(Value::Null);
    let skip = |k: &str| choice(k).get("skip") == Some(&Value::Bool(true));
    let keys: Vec<&str> = members.iter().filter(|b| !skip(&b.key)).map(|b| b.key.as_str()).collect();
    members
        .iter()
        .map(|bp| {
            let c = choice(&bp.key);
            let asked = squash(&Some(str_of(c.get("name"))).filter(|n| !n.is_empty()).unwrap_or_else(|| bp.name.clone()));
            if !crate::member::is_name(&asked) {
                return Err(bad(format!("{}: up to 24 letters, digits, spaces, dots, dashes or underscores.", if asked.is_empty() { "A name" } else { &asked })));
            }
            let skipped = skip(&bp.key);
            let name = if skipped { asked.clone() } else { unique_name(&asked, &taken) };
            if !skipped {
                taken.push(handle_of(&name));
            }
            let mut notes = Vec::new();
            if name != asked {
                notes.push(format!("{asked} is already on your crew: they join as {name}"));
            }
            let here = bp.agent == "auto" || (known(&bp.agent) && agents.contains(&bp.agent));
            if !here {
                notes.push(format!("Prefers {}, which isn't installed here: Auto picks a harness", harness_name(&bp.agent)));
            }
            let team = bp
                .team
                .iter()
                .filter(|t| match (&t.crew, &t.agent) {
                    (Some(k), _) => keys.contains(&k.as_str()) || {
                        let who = members.iter().find(|b| b.key == *k).map_or(k.as_str(), |b| b.name.as_str());
                        notes.push(format!("Delegates to {who}, who you left out"));
                        false
                    },
                    (None, Some(a)) => known(a) || a == "auto" || {
                        notes.push(format!("Delegates to {a}, a harness this wisp doesn't know"));
                        false
                    },
                    (None, None) => false,
                })
                .cloned()
                .collect();
            let bp = Blueprint { name, agent: if here { bp.agent.clone() } else { "auto".into() }, model: if here { bp.model.clone() } else { String::new() }, effort: if here { bp.effort.clone() } else { String::new() }, team, ..bp.clone() };
            Ok(PlanItem { needs_project: bp.on.iter().any(|k| k == "ci"), cwd: str_of(c.get("cwd")), skip: skipped, notes, bp })
        })
        .collect()
}

fn body_of(p: &PlanItem) -> MemberBody {
    MemberBody {
        name: Some(p.bp.name.clone()),
        role: Some(p.bp.role.clone()),
        avatar: Some(p.bp.avatar.clone()),
        color: p.bp.color.clone(),
        brief: Some(p.bp.brief.clone()),
        cron: Some(p.bp.cron.clone()),
        mode: Some(p.bp.mode.clone()),
        agent: Some(p.bp.agent.clone()),
        model: Some(p.bp.model.clone()),
        effort: Some(p.bp.effort.clone()),
        parallel: Some(f64::from(p.bp.parallel)),
        kit: Some(serde_json::to_value(&p.bp.kit).unwrap_or(Value::Null)),
        notebook: Some(p.bp.notebook.clone().unwrap_or_default()),
        cwd: Some(p.cwd.clone()),
        paused: Some(true),
        ..MemberBody::default()
    }
}

/// The members an import adds, built but not yet on the crew: all of them, or an error and none.
/// Each comes with the kinds that start it (its `on`), for the triggers.
pub fn import_members(plan: &[PlanItem], c: &Checks, ids: &mut dyn Ids, now: i64) -> Result<Vec<(Member, Vec<String>)>> {
    let list: Vec<&PlanItem> = plan.iter().filter(|p| !p.skip).collect();
    if list.is_empty() {
        return Err(bad("Pick at least one member to add."));
    }
    let crew = c.taken.len();
    if crew + list.len() > MAX_CREW {
        return Err(bad(format!("Your crew has room for {} more (at most {MAX_CREW}). Leave some out, or remove someone first.", MAX_CREW.saturating_sub(crew))));
    }
    if let Some(p) = list.iter().find(|p| p.needs_project && p.cwd.is_empty()) {
        return Err(bad(format!("{} starts when CI fails: pick the project whose GitHub repo they watch.", p.bp.name)));
    }
    let mut made: Vec<Member> = Vec::new();
    for p in &list {
        let taken: Vec<Member> = c.taken.iter().chain(made.iter()).cloned().collect();
        let checks = Checks { taken: &taken, exists: c.exists, machine_ok: c.machine_ok, words: c.words };
        made.push(normalize_member(&body_of(p), None, &checks, ids, now)?);
    }
    // Delegates in the same file are the members just made.
    let ids_of: Vec<String> = made.iter().map(|m| m.id.clone()).collect();
    for (m, p) in made.iter_mut().zip(&list) {
        let rows: Vec<Value> = p
            .bp
            .team
            .iter()
            .map(|t| match t.crew.as_deref().and_then(|k| list.iter().position(|q| q.bp.key == k)) {
                Some(i) => json!({ "crew": ids_of[i], "name": list[i].bp.name, "role": list[i].bp.role, "agent": list[i].bp.agent }),
                None => serde_json::to_value(t).unwrap_or(Value::Null),
            })
            .collect();
        m.team = normalize_team(&Value::Array(rows))?;
    }
    Ok(made.into_iter().zip(list).map(|(m, p)| (m, p.bp.on.clone())).collect())
}

/// A member → its blueprint and notes on what stays here. `key_of(id)`: the key of a delegate shared in
/// the same file. `on`: the kinds of the triggers that send it work.
pub fn to_blueprint(m: &Member, on: &[String], kit: bool, notebook: bool, key: &str, key_of: &dyn Fn(&str) -> Option<String>, name_of: &dyn Fn(&str) -> String) -> Result<(Blueprint, Vec<String>)> {
    let mut notes = Vec::new();
    let mut team = Vec::new();
    for t in &m.team {
        match t.crew.as_deref() {
            None => team.push(BpTeam { agent: Some(t.agent.clone()), name: (!t.name.is_empty() && t.name != t.agent).then(|| t.name.clone()), model: Some(t.model.clone()).filter(|s| !s.is_empty()), effort: Some(t.effort.clone()).filter(|s| !s.is_empty()), use_: Some(t.use_.clone()).filter(|s| !s.is_empty()), count: (t.count > 1).then_some(t.count), crew: None }),
            Some(id) => match key_of(id) {
                Some(k) => team.push(BpTeam { crew: Some(k), ..BpTeam::default() }),
                None => {
                    let who = Some(name_of(id)).filter(|n| !n.is_empty()).or_else(|| t.label.clone()).unwrap_or_else(|| "another member".into());
                    notes.push(format!("{} delegates to {who}, who stays here (tick Who they delegate to)", m.name));
                }
            },
        }
    }
    let mut files = Vec::new();
    if kit {
        for k in &m.kit {
            if k.path.is_some() {
                notes.push(format!("{} has files beside its SKILL.md that stay here; only the SKILL.md goes", k.name));
            }
            files.push(json!({ "kind": k.kind, "name": k.name, "description": k.description, "body": k.body, "on": k.on }));
        }
    }
    let raw = json!({ "key": key, "name": m.name, "role": m.role, "avatar": m.avatar, "color": m.color, "brief": m.brief, "cron": m.cron, "on": on, "mode": m.mode, "agent": m.agent, "model": m.model, "effort": m.effort, "parallel": m.parallel, "kit": files, "team": team, "notebook": if notebook && !m.notebook.is_empty() { Value::String(m.notebook.clone()) } else { Value::Null } });
    Ok((normalize_blueprint(&raw, &CronOnly)?, notes))
}

/// What a share would send: the bundle, notes, the file name, and every text the secret scan reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Export {
    pub bundle: Value,
    pub notes: Vec<String>,
    pub file: String,
    /// `(where, text)`: "Scout · notebook", …
    pub texts: Vec<(String, String)>,
}

fn find<'a>(crew: &'a [Member], key: &str) -> Option<&'a Member> {
    crew.iter().find(|m| m.id == key).or_else(|| crew.iter().find(|m| handle_of(&m.name) == handle_of(key)))
}

/// Members to share (ids, names or handles). `team`: their crew delegates come too (and theirs).
pub fn export_crew(crew: &[Member], ids: &[String], on_of: &dyn Fn(&Member) -> Vec<String>, kit: bool, notebook: bool, team: bool) -> Result<Export> {
    let mut list: Vec<&Member> = Vec::new();
    for id in ids {
        let m = find(crew, id).ok_or_else(|| Error::NotFound(format!("No one called “{id}” on your crew.")))?;
        if !list.iter().any(|x| x.id == m.id) {
            list.push(m);
        }
    }
    if list.is_empty() {
        return Err(bad("Pick who to share."));
    }
    let mut i = 0;
    while team && i < list.len() {
        for t in &list[i].team.clone() {
            if let Some(d) = t.crew.as_deref().and_then(|c| crew.iter().find(|m| m.id == c))
                && !list.iter().any(|x| x.id == d.id)
            {
                list.push(d);
            }
        }
        i += 1;
    }
    let mut keys: Vec<(String, String)> = Vec::new();
    for m in &list {
        let base = Some(handle_of(&m.name)).filter(|h| !h.is_empty()).unwrap_or_else(|| "member".into());
        let mut k = base.clone();
        let mut n = 2;
        while keys.iter().any(|(_, v)| *v == k) {
            k = format!("{base}-{n}");
            n += 1;
        }
        keys.push((m.id.clone(), k));
    }
    let key_of = |id: &str| keys.iter().find(|(i, _)| i == id).map(|(_, k)| k.clone());
    let name_of = |id: &str| crew.iter().find(|m| m.id == id).map(|m| m.name.clone()).unwrap_or_default();
    let mut notes = Vec::new();
    let mut members = Vec::new();
    for m in &list {
        let (bp, n) = to_blueprint(m, &on_of(m), kit, notebook, &key_of(&m.id).unwrap_or_default(), &key_of, &name_of)?;
        notes.extend(n);
        members.push(bp);
    }
    let mut texts = Vec::new();
    for b in &members {
        texts.push((format!("{} · role", b.name), b.role.clone()));
        texts.push((format!("{} · brief", b.name), b.brief.clone()));
        texts.push((format!("{} · notebook", b.name), b.notebook.clone().unwrap_or_default()));
        texts.extend(b.kit.iter().map(|k| (format!("{} · {}", b.name, k.name), format!("{}\n{}", k.description.clone().unwrap_or_default(), k.body))));
    }
    let file = if members.len() == 1 { format!("{}.crew.json", members[0].key) } else { "crew.crew.json".into() };
    Ok(Export { bundle: json!({ "wispCrew": CREW_FILE, "members": members }), notes, file, texts })
}
