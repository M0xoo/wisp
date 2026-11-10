//! Resolving (v1 grammar.js, second half): machine, then project, then model, because the chosen machine
//! decides which models are valid. Each failure is a problem with its choices.

use wisp_channels_api::{AgentView, ChannelCtx, MachineView, ModelView};

use super::read::{Opts, find_harness, harnesses, match_models, model_ids};

fn machine_of<'a>(c: &'a ChannelCtx, id: &str) -> Option<&'a MachineView> {
    c.machines.iter().find(|m| m.id == id)
}

fn place_name(c: &ChannelCtx, id: &str) -> String {
    if id.is_empty() { "this computer".into() } else { machine_of(c, id).map_or_else(|| id.to_owned(), |m| m.name.clone()) }
}

/// What can run at a place, or `None` when that can't be known (offline, a sandbox).
fn agents_at<'a>(c: &'a ChannelCtx, id: &str) -> Option<&'a [AgentView]> {
    if id.is_empty() {
        return Some(&c.agents);
    }
    if id == "sandbox" {
        return None;
    }
    machine_of(c, id)?.agents.as_deref()
}

fn harness_name(c: &ChannelCtx, id: &str) -> String {
    find_harness(c, id).and_then(|a| a.name.clone()).unwrap_or_else(|| id.to_owned())
}

fn names_of<'a>(list: impl Iterator<Item = &'a AgentView>) -> Vec<String> {
    list.map(|a| a.name.clone().unwrap_or_else(|| a.id.clone())).collect()
}

// `None` agents don't always mean offline: a cloud computer asleep wakes when it gets work.
fn resolve_machine(o: &mut Opts, c: &ChannelCtx, mid: &str) {
    if mid == "sandbox" && !c.sandbox {
        o.problem("not-installed", "Sandboxes need a wisp Grid: sign in to one in Settings → Cloud.".into(), Vec::new());
    }
    if mid.is_empty() || mid == "sandbox" {
        return;
    }
    if let Some(m) = machine_of(c, mid)
        && !m.usable
    {
        o.problem("offline", format!("{} is offline.", m.name), c.machines.iter().filter(|x| x.usable).map(|x| x.name.clone()).collect());
    }
}

/// A member's job: model, level and mode may change for this one job; its harness can't (its kit and memory
/// are made for it), Auto picks for itself, and it works where it works.
fn resolve_member(o: &mut Opts, c: &ChannelCtx) {
    let Some(m) = o.crew.clone() else { return };
    let name = &m.name;
    let cwd = m.cwd.clone().unwrap_or_default();
    if let Some(p) = o.project.clone().filter(|p| p.path != cwd) {
        let theirs = if cwd.is_empty() { "a folder of their own".to_owned() } else { c.projects.iter().find(|x| x.path == cwd).map_or_else(|| cwd.clone(), |x| x.name.clone()) };
        o.problem("refused", format!("{name} works in {theirs}: a job can’t move them to {}.", p.name), Vec::new());
    }
    let own = if m.sandbox { "sandbox".to_owned() } else { m.machine.clone().unwrap_or_default() };
    if let Some(asked) = o.machine.clone().filter(|x| *x != own) {
        o.problem("refused", format!("{name} works on {}: a job can’t move them to {}.", place_name(c, &own), place_name(c, &asked)), Vec::new());
    }
    let Some(w) = o.withs.clone() else { return };
    if m.agent == "auto" {
        return o.problem("refused", format!("{name} is on Auto, which picks the harness and model itself. Change that in their settings, or start a task of your own."), Vec::new());
    }
    if !w.agent.is_empty() && w.agent != m.agent {
        return o.problem("refused", format!("{name} runs on {}: their kit and memory are made for it, so a job can’t change harness.", harness_name(c, &m.agent)), Vec::new());
    }
    if m.sandbox {
        o.model = (!w.model.is_empty()).then(|| w.model.clone()).or(o.model.take());
        o.effort = (!w.effort.is_empty()).then(|| w.effort.clone()).or(o.effort.take());
        return;
    }
    let mid = m.machine.clone().unwrap_or_default();
    let Some(at) = agents_at(c, &mid) else {
        return o.problem("offline", format!("{} is offline, so I can’t check that model for {name}.", place_name(c, &mid)), Vec::new());
    };
    let mine: Vec<AgentView> = at.iter().filter(|a| a.id == m.agent).cloned().collect();
    resolve_model(o, c, &mine, &mid, &m.agent);
    o.agent = None; // the member's, as it always is
}

/// One harness at a place, or every harness there, for the model and level asked for.
#[allow(clippy::many_single_char_names)] // v1's names: o options, c ctx, w with, a agent, p pick
fn resolve_model(o: &mut Opts, c: &ChannelCtx, agents: &[AgentView], mid: &str, prefer: &str) {
    let Some(w) = o.withs.clone() else { return };
    let place = place_name(c, mid);
    let usable: Vec<&AgentView> = agents.iter().filter(|a| a.available && a.id != "wisp").collect();
    if !w.agent.is_empty() {
        let a = agents.iter().find(|x| x.id == w.agent);
        let Some(a) = a.filter(|a| a.available) else {
            let why = if a.is_some_and(|a| !a.signed_in) { "signed in" } else { "installed" };
            return o.problem("not-installed", format!("{} isn’t {why} on {place}.", harness_name(c, &w.agent)), names_of(usable.into_iter()));
        };
        o.agent = Some(a.id.clone());
        let mut model = None;
        if !w.model.is_empty() {
            let (_, hits) = match_models(a, &w.model);
            if hits.len() != 1 {
                let (kind, text, list) = if hits.is_empty() {
                    ("not-installed", format!("{} on {place} has no model “{}”.", a.name.as_deref().unwrap_or(&a.id), w.model), model_ids(a).map(|m| m.id.clone()).collect())
                } else {
                    ("ambiguous", format!("“{}” could be {} models.", w.model, hits.len()), hits.iter().map(|m| m.id.clone()).collect())
                };
                return o.problem(kind, text, list);
            }
            o.model = Some(hits[0].id.clone());
            model = Some(hits[0]);
        }
        return effort_for(o, a, model, &place, &w.effort);
    }
    if !w.model.is_empty() {
        let found: Vec<(&AgentView, u8, Vec<&ModelView>)> = usable.iter().map(|a| { let (t, h) = match_models(a, &w.model); (*a, t, h) }).filter(|x| !x.2.is_empty()).collect();
        if found.is_empty() {
            return o.problem("not-installed", format!("No model “{}” on {place}.", w.model), usable.iter().flat_map(|a| model_ids(a).map(|m| m.id.clone())).take(12).collect());
        }
        let best = found.iter().map(|x| x.1).min().unwrap_or(0);
        let top: Vec<_> = found.iter().filter(|x| x.1 == best).collect();
        let pick = top.iter().find(|x| x.0.id == prefer && x.2.len() == 1).or_else(|| (top.len() == 1 && top[0].2.len() == 1).then(|| &top[0]));
        let Some(p) = pick else {
            return o.problem("ambiguous", format!("“{}” could be several models on {place}.", w.model), top.iter().flat_map(|x| x.2.iter().map(|m| format!("{} {}", x.0.id, m.id))).collect());
        };
        o.agent = Some(p.0.id.clone());
        o.model = Some(p.2[0].id.clone());
        let (a, m) = (p.0, p.2[0]);
        return effort_for(o, a, Some(m), &place, &w.effort);
    }
    let Some(a) = usable.iter().find(|x| x.id == prefer) else {
        return o.problem("refused", format!("Auto picks the thinking level itself. Name a model too: with opus {}.", w.effort), Vec::new());
    };
    effort_for(o, a, None, &place, &w.effort);
}

fn effort_for(o: &mut Opts, a: &AgentView, model: Option<&ModelView>, place: &str, effort: &str) {
    if effort.is_empty() {
        return;
    }
    let list = model.filter(|m| !m.efforts.is_empty()).map_or(&a.efforts, |m| &m.efforts);
    if !list.iter().any(|e| e == effort) {
        let what = model.and_then(|m| m.label.clone()).or_else(|| a.name.clone()).unwrap_or_else(|| a.id.clone());
        return o.problem("not-installed", format!("{what} on {place} has no thinking level “{effort}”."), list.clone());
    }
    o.effort = Some(effort.to_owned());
}

fn resolve_with(o: &mut Opts, c: &ChannelCtx, mid: &str) {
    let Some(w) = o.withs.clone() else { return };
    if w.agent == "auto" {
        if c.thread.is_some() {
            return o.problem("refused", "Auto picks when a task starts: name a harness or a model for a follow-up.".into(), names_of(c.agents.iter().filter(|a| a.available)));
        }
        o.agent = Some("auto".into());
        o.model = (!w.model.is_empty()).then(|| w.model.clone());
        if !w.effort.is_empty() {
            o.problem("refused", "Auto picks the thinking level itself.".into(), c.goals.clone());
        }
        return;
    }
    if let Some(at) = agents_at(c, mid) {
        let prefer = c.thread.as_ref().map(|t| t.agent.clone()).filter(|a| !a.is_empty()).unwrap_or_else(|| c.default_agent.clone());
        let at = at.to_vec();
        return resolve_model(o, c, &at, mid, &prefer);
    }
    // offline or a sandbox: nothing to check against, so what's known of the harness stands
    let a = if w.agent.is_empty() { harnesses(c).find(|x| !match_models(x, &w.model).1.is_empty()) } else { find_harness(c, &w.agent) };
    if let Some(a) = a {
        o.agent = Some(a.id.clone());
    }
    if !w.model.is_empty() {
        o.model = Some(a.and_then(|a| match_models(a, &w.model).1.first().map(|m| m.id.clone())).unwrap_or_else(|| w.model.clone()));
    }
    if !w.effort.is_empty() {
        o.effort = Some(w.effort.clone());
    }
}

pub(crate) fn resolve(o: &mut Opts, c: &ChannelCtx) {
    if o.crew.is_some() {
        return resolve_member(o, c);
    }
    let project = o.project.as_ref().or(c.default_project.as_ref());
    let mid = match &c.thread {
        Some(t) => t.machine.clone(),
        None => o.machine.clone().unwrap_or_else(|| project.and_then(|p| p.machine.clone()).unwrap_or_default()),
    };
    if c.thread.is_none() {
        resolve_machine(o, c, &mid);
    }
    if o.problems.is_empty() && o.withs.is_some() {
        resolve_with(o, c, &mid);
    }
}
