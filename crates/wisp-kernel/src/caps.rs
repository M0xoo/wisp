//! Capability sets (ADR-0008, plan §6.5): permissions `ns:action{k:v}` bound to a context. Default deny,
//! and a deny beats an allow. The sets themselves are data (`capabilities.json` in this crate, plus each
//! plugin's manifest), compiled once and cached per set id.
//!
//! size-ok: the permission grammar and its matcher are one parser; tests are a third of it
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::perm::{self, Permission};

/// Who a call speaks for: decided by the token at the edge, never by the protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caller {
    /// 'user:full', 'agent:session', 'agent:session:<mode>', 'agent:capped', 'agent:capped:<mode>',
    /// 'crew:<name>', 'box', 'apikey', 'preview', 'pane:<id>', 'grid:inbox', 'grid:route', 'plugin:<id>', 'kernel'
    pub set: String,
    /// the session an agent token speaks for
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// the plugin making a nested call
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
}

impl Caller {
    pub fn user() -> Self {
        Self { set: "user:full".into(), session: None, plugin: None }
    }
    pub fn kernel() -> Self {
        Self { set: "kernel".into(), session: None, plugin: None }
    }
    pub fn agent(session: impl Into<String>, capped: bool) -> Self {
        let set = if capped { "agent:capped" } else { "agent:session" };
        Self { set: set.into(), session: Some(session.into()), plugin: None }
    }
    /// A session's agent narrowed to its mode (`plan`, `edits`, `auto`): nothing it starts goes above it.
    pub fn agent_at(session: impl Into<String>, mode: &str, capped: bool) -> Self {
        let base = if capped { "agent:capped" } else { "agent:session" };
        Self { set: format!("{base}:{mode}"), session: Some(session.into()), plugin: None }
    }
    /// Any named set (`crew:ops`, `pane:abc`, `box`, `preview`).
    pub fn set(set: impl Into<String>) -> Self {
        Self { set: set.into(), session: None, plugin: None }
    }
    pub fn plugin(id: &str) -> Self {
        Self { set: format!("plugin:{id}"), session: None, plugin: Some(id.to_owned()) }
    }
}

/// A named set of permission patterns. `proc:spawn{bin:*}` matches `proc:spawn{bin:claude}`;
/// `runtime:*` matches every runtime permission.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapabilitySet {
    pub id: String,
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    /// deny pattern → what the caller reads (v1's wording for capped refusals). Added in v2.0 (additive).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub why: BTreeMap<String, String>,
}

/// A set ready to check: patterns parsed once.
#[derive(Debug)]
pub(crate) struct Compiled {
    pub(crate) id: String,
    all: bool,
    allow: Vec<Permission>,
    deny: Vec<(Permission, Option<String>)>,
}

impl Compiled {
    pub(crate) fn new(s: &CapabilitySet) -> Self {
        let allow: Vec<Permission> = s.allow.iter().filter_map(|p| perm::parse(p)).collect();
        let deny: Vec<(Permission, Option<String>)> =
            s.deny.iter().filter_map(|d| perm::parse(d).map(|p| (p, s.why.get(d).cloned()))).collect();
        let all = deny.is_empty() && allow.iter().any(|p| p.ns == "*" && p.action == "*" && p.scope.is_empty());
        Self { id: s.id.clone(), all, allow, deny }
    }

    /// Allowed, or the message the caller reads.
    pub(crate) fn explain(&self, p: &Permission) -> Result<(), String> {
        if self.all {
            return Ok(());
        }
        if let Some((_, why)) = self.deny.iter().find(|(d, _)| d.covers(p)) {
            return Err(match why {
                Some(w) if w.starts_with("Refused:") => w.clone(),
                Some(w) => format!("{} may not {p}: it can't {w}", self.id),
                None => format!("{} may not {p}", self.id),
            });
        }
        if self.allow.iter().any(|g| g.covers(p)) { Ok(()) } else { Err(format!("{} may not {p}", self.id)) }
    }
}

#[derive(Deserialize)]
struct Deny {
    permission: String,
    #[serde(default)]
    why: String,
    #[serde(default)]
    what: String,
}

#[derive(Deserialize)]
struct SetData {
    id: String,
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<Deny>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    modes: Vec<String>,
    mode_labels: BTreeMap<String, String>,
    capped_refusal: String,
    sets: Vec<SetData>,
    above_mode: Vec<Deny>,
    capped: Vec<Deny>,
    crew: CrewData,
}

#[derive(Deserialize)]
struct CrewData {
    deny: Vec<Deny>,
}

fn data() -> Option<&'static Data> {
    static DATA: OnceLock<Option<Data>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("../capabilities.json")).ok()).as_ref()
}

fn with(mut s: CapabilitySet, deny: impl IntoIterator<Item = (String, String)>) -> CapabilitySet {
    for (p, why) in deny {
        s.deny.push(p.clone());
        s.why.insert(p, why);
    }
    s
}

/// The data file's set by id (`user:full`, `agent:session`, `box`, …).
fn base(id: &str) -> Option<CapabilitySet> {
    let d = data()?;
    let s = d.sets.iter().find(|s| s.id == id)?;
    Some(with(
        CapabilitySet { id: s.id.clone(), allow: s.allow.clone(), ..CapabilitySet::default() },
        s.deny.iter().map(|x| (x.permission.clone(), x.why.clone())),
    ))
}

/// v1's capped refusal, word for word: "Refused: this task was started from a channel with a mode cap, …".
pub fn capped_refusal(what: &str) -> String {
    data().map_or_else(|| format!("Refused: {what}"), |d| d.capped_refusal.replace("{what}", what))
}

fn above_mode(cap: &str) -> Vec<(String, String)> {
    let Some(d) = data() else { return Vec::new() };
    let Some(rank) = d.modes.iter().position(|m| m == cap) else {
        return Vec::new();
    };
    let label = |m: &str| d.mode_labels.get(m).cloned().unwrap_or_else(|| m.to_owned());
    d.modes[rank + 1..]
        .iter()
        .flat_map(|m| d.above_mode.iter().map(move |r| (m, r)))
        .map(|(m, r)| (r.permission.replace("{mode}", m), r.why.replace("{label}", &label(m)).replace("{cap}", &label(cap))))
        .collect()
}

/// `agent:session` narrowed to a mode: nothing it starts or switches to goes above it.
pub fn session_set(mode: &str) -> CapabilitySet {
    let s = base("agent:session").unwrap_or_default();
    CapabilitySet { id: format!("agent:session:{mode}"), ..with(s, above_mode(mode)) }
}

/// `agent:capped` at a cap (v1 `session.capped.mode`): agent:session at that mode, minus capped.js.
pub fn capped_set(cap: &str) -> CapabilitySet {
    let s = session_set(cap);
    let id = if cap == "edits" { "agent:capped".to_owned() } else { format!("agent:capped:{cap}") };
    let capped =
        data().map(|d| d.capped.iter().map(|c| (c.permission.clone(), capped_refusal(&c.what))).collect::<Vec<_>>()).unwrap_or_default();
    // capped refusals first: their wording is what the agent must read
    let mut out = with(CapabilitySet { id, allow: s.allow, ..CapabilitySet::default() }, capped);
    out = with(out, s.deny.into_iter().map(|d| (d.clone(), s.why.get(&d).cloned().unwrap_or_default())));
    out
}

/// A crew member's agent: a session's power, but it can't rewrite the crew.
pub fn crew_set(name: &str) -> CapabilitySet {
    let s = base("agent:session").unwrap_or_default();
    let deny = data().map(|d| d.crew.deny.iter().map(|x| (x.permission.clone(), x.why.clone())).collect::<Vec<_>>()).unwrap_or_default();
    CapabilitySet { id: format!("crew:{name}"), ..with(s, deny) }
}

/// A pane or app iframe: what the user allowed from its bar, nothing by default.
pub fn pane_set(id: &str, allow: Vec<String>) -> CapabilitySet {
    CapabilitySet { id: format!("pane:{id}"), allow, ..CapabilitySet::default() }
}

/// What ids a plugin owns: its id minus the author segment (`wisp.shell.task` owns `shell.task.*`).
pub fn owner_prefix(plugin: &str) -> &str {
    plugin.split_once('.').map_or(plugin, |(_, rest)| rest)
}

/// Is `id` (a command, event, setting or point) in `plugin`'s namespace?
pub fn owned_by(id: &str, plugin: &str) -> bool {
    let p = owner_prefix(plugin);
    id == p || id.strip_prefix(p).is_some_and(|r| r.starts_with('.')) || id.strip_prefix(plugin).is_some_and(|r| r.starts_with('.'))
}

/// A plugin speaking for itself: its manifest's permissions plus its own commands' namespace.
pub fn plugin_set(id: &str, permissions: &[String]) -> CapabilitySet {
    let mut allow = permissions.to_vec();
    // `wisp.runtime` owns `runtime:*`; `wisp.shell.task` owns `shell:task` and `shell:task.*`, not all of `shell`
    match owner_prefix(id).split_once('.') {
        None => allow.push(format!("{}:*", owner_prefix(id))),
        Some((ns, rest)) => {
            allow.push(format!("{ns}:{rest}"));
            allow.push(format!("{ns}:{rest}.*"));
        }
    }
    CapabilitySet { id: format!("plugin:{id}"), allow, ..CapabilitySet::default() }
}

/// Every set by id. Families (`crew:<name>`, `pane:<id>`, `agent:session:<mode>`) are made on demand.
#[derive(Debug, Default)]
pub(crate) struct Registry {
    sets: RwLock<HashMap<String, Arc<Compiled>>>,
    /// an API key → the `custom:` set its holder speaks with (memory only: keys stay in secrets)
    keys: RwLock<Vec<(String, String)>>,
}

impl Registry {
    pub(crate) fn remove(&self, id: &str) {
        if let Ok(mut m) = self.sets.write() {
            m.remove(id);
        }
        if let Ok(mut k) = self.keys.write() {
            k.retain(|(_, set)| set != id);
        }
    }

    /// `key` speaks with `set` from now on (one key, one set; an empty key only clears).
    pub(crate) fn set_key(&self, set: &str, key: &str) {
        if let Ok(mut k) = self.keys.write() {
            k.retain(|(kk, s)| s != set && kk != key);
            if !key.is_empty() {
                k.push((key.to_owned(), set.to_owned()));
            }
        }
    }

    /// The set a key speaks with; every key is compared in full (no early exit on a prefix).
    pub(crate) fn key_set(&self, key: &str) -> Option<String> {
        let k = self.keys.read().ok()?;
        let mut found = None;
        for (kk, set) in k.iter() {
            let same = kk.len() == key.len() && kk.bytes().zip(key.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
            if same {
                found = Some(set.clone());
            }
        }
        found
    }

    pub(crate) fn define(&self, s: &CapabilitySet) {
        if let Ok(mut m) = self.sets.write() {
            m.insert(s.id.clone(), Arc::new(Compiled::new(s)));
        }
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<Compiled>> {
        if let Some(c) = self.sets.read().ok().and_then(|m| m.get(id).cloned()) {
            return Some(c);
        }
        let s = family(id)?;
        let c = Arc::new(Compiled::new(&s));
        if let Ok(mut m) = self.sets.write() {
            m.insert(id.to_owned(), c.clone());
        }
        Some(c)
    }
}

fn family(id: &str) -> Option<CapabilitySet> {
    if let Some(s) = base(id) {
        return Some(s);
    }
    let modes = data().map(|d| d.modes.as_slice()).unwrap_or_default();
    if let Some(m) = id.strip_prefix("agent:session:") {
        // agent:session:<mode>, or agent:session:<session id> (the session's own token)
        return Some(if modes.iter().any(|x| x == m) {
            session_set(m)
        } else {
            CapabilitySet { id: id.to_owned(), ..base("agent:session")? }
        });
    }
    if id == "agent:capped" {
        return Some(capped_set("edits"));
    }
    if let Some(m) = id.strip_prefix("agent:capped:") {
        return modes.iter().any(|x| x == m).then(|| capped_set(m));
    }
    if let Some(name) = id.strip_prefix("crew:").filter(|n| !n.is_empty()) {
        return Some(crew_set(name));
    }
    if let Some(p) = id.strip_prefix("pane:").filter(|n| !n.is_empty()) {
        return Some(pane_set(p, Vec::new()));
    }
    // a plugin the kernel hasn't defined (outside a kernel): only its own namespace
    id.strip_prefix("plugin:").filter(|n| !n.is_empty()).map(|p| plugin_set(p, &[]))
}

/// A built-in set, compiled (for calls made outside a kernel).
pub(crate) fn builtin(id: &str) -> Option<Arc<Compiled>> {
    default_registry().get(id)
}

fn default_registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(Registry::default)
}

/// Allowed, or the reason it isn't, against the built-in sets (no kernel: plugin sets hold only their
/// own namespace). Inside a call, use `Call::require`, which also knows every plugin's manifest.
pub fn explain(caller: &Caller, permission: &str) -> Result<(), String> {
    explain_in(default_registry(), caller, permission)
}

pub(crate) fn explain_in(reg: &Registry, caller: &Caller, permission: &str) -> Result<(), String> {
    let Some(p) = perm::parse(permission) else {
        return Err(format!("\"{permission}\" is not a permission"));
    };
    let Some(set) = reg.get(&caller.set) else {
        return Err(format!("{} is not a capability set", caller.set));
    };
    set.explain(&p)
}

/// Does `caller`'s set allow `permission`? Default deny.
pub fn allowed(caller: &Caller, permission: &str) -> bool {
    explain(caller, permission).is_ok()
}

/// The set a caller id names, as data (Settings → Plugins shows it).
pub fn set_of(id: &str) -> Option<CapabilitySet> {
    family(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_parses() {
        assert!(data().is_some(), "capabilities.json must parse");
    }

    #[test]
    fn user_and_kernel_hold_everything() {
        assert!(allowed(&Caller::user(), "secrets:read{key:x}"));
        assert!(allowed(&Caller::kernel(), "plugins:install"));
    }

    #[test]
    fn agent_session_and_modes() {
        let a = Caller::agent("s1", false);
        assert!(allowed(&a, "runtime:start"));
        assert!(!allowed(&a, "plugins:install"));
        assert!(!allowed(&a, "settings:write{scope:server}"));
        assert!(!allowed(&a, "settings:write{scope:device}"), "settings:* is not in agent:session's allow list");
        let edits = Caller::agent_at("s1", "edits", false);
        assert!(allowed(&edits, "runtime:start{mode:edits}"));
        let e = explain(&edits, "runtime:start{mode:auto}").err().unwrap_or_default();
        assert!(e.contains("Full auto, above this task’s Edits"), "{e}");
        assert!(allowed(&Caller::agent_at("s1", "auto", false), "runtime:start{mode:auto}"));
    }

    #[test]
    fn capped_uses_v1_words() {
        let c = Caller::agent("s1", true);
        let e = explain(&c, "stuff:publish").err().unwrap_or_default();
        assert_eq!(
            e,
            "Refused: this task was started from a channel with a mode cap, so it can't put anything on a public link, or take one down. Say so in your report; the user can do it in wisp."
        );
        assert!(!allowed(&c, "runtime:start{mode:auto}"));
        assert!(allowed(&c, "runtime:start{mode:edits}"));
        assert!(!allowed(&Caller::set("agent:capped:plan"), "runtime:start{mode:edits}"));
    }

    #[test]
    fn families_and_plugins() {
        assert!(!allowed(&Caller::set("crew:ops"), "crew:write"));
        assert!(allowed(&Caller::set("crew:ops"), "crew:read"));
        assert!(!allowed(&Caller::set("pane:x"), "topic:read"));
        assert!(!allowed(&Caller::set("box"), "machines:list"));
        assert!(allowed(&Caller::set("box"), "runtime:start"));
        assert!(allowed(&Caller::set("preview"), "session:read"));
        assert!(!allowed(&Caller::set("preview"), "session:write"));
        assert!(allowed(&Caller::set("grid:inbox"), "channels:inbound"));
        assert!(!allowed(&Caller::set("grid:inbox"), "channels:routed"));
        assert!(allowed(&Caller::plugin("wisp.runtime"), "runtime:start"));
        assert!(!allowed(&Caller::plugin("wisp.runtime"), "git:push"));
        assert!(!allowed(&Caller::set("nobody"), "a:b"));
    }

    #[test]
    fn owners() {
        assert_eq!(owner_prefix("wisp.shell.task"), "shell.task");
        assert!(owned_by("shell.task.open", "wisp.shell.task"));
        assert!(owned_by("claude.login", "wisp.claude"));
        assert!(owned_by("wisp.claude.login", "wisp.claude"));
        assert!(!owned_by("claudex.login", "wisp.claude"));
    }
}
