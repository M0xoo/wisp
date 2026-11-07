//! The plugin table: which plugins are on, where each came from, and how often each hook fired per task.
//! v1 kept it in `~/.wisp/spells.json` (`{ enabled, sources, hooks }`); v2 keeps rows (`plugins_state`,
//! `plugins_hook`) and, for the release that introduces them, writes spells.json too, so going back
//! to v1 keeps the user's spells on (ADR-0004's downgrade path). Pure: the time is given.
use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use wisp_plugins_api::{Kind, Source, StateRow};

/// Hook counts kept per hook: the newest sessions only (v1 kept 200).
pub const HOOK_SESSIONS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table {
    pub rows: BTreeMap<String, StateRow>,
    /// (plugin, hook) → sessions in the order they first fired, with their counts
    pub hooks: BTreeMap<(String, String), Vec<(String, u32)>>,
}

impl Table {
    pub fn get(&self, id: &str) -> Option<&StateRow> {
        self.rows.get(id)
    }

    pub fn is_on(&self, id: &str) -> bool {
        self.rows.get(id).is_some_and(|r| r.enabled)
    }

    /// On, in the order they were switched on (of two that set one setting, the later wins).
    pub fn enabled(&self) -> Vec<&StateRow> {
        let mut on: Vec<&StateRow> = self.rows.values().filter(|r| r.enabled).collect();
        on.sort_by(|a, b| a.on_at.cmp(&b.on_at).then_with(|| a.id.cmp(&b.id)));
        on
    }

    fn next_on(&self, now: i64) -> i64 {
        // Strictly after every row already on, so the order holds within one millisecond.
        self.rows.values().map(|r| r.on_at + 1).max().unwrap_or(0).max(now)
    }

    /// A new or updated plugin: its source (when known, else the old one, else local) and, when asked, on.
    pub fn put(&mut self, id: &str, kind: Kind, source: Option<Source>, enable: bool, now: i64) -> StateRow {
        let was = self.rows.get(id).cloned();
        let on = enable || was.as_ref().is_some_and(|w| w.enabled);
        let source = match source {
            Some(mut s) => {
                if s.at == 0 {
                    s.at = now;
                }
                Some(s)
            }
            None => was.as_ref().and_then(|w| w.source.clone()).or_else(|| Some(Source { at: now, ..Source::of("local") })),
        };
        let on_at = if on && !was.as_ref().is_some_and(|w| w.enabled) { self.next_on(now) } else { was.as_ref().map_or(0, |w| w.on_at) };
        let row = StateRow { id: id.into(), kind, enabled: on, source, at: was.as_ref().map_or(now, |w| w.at), on_at };
        self.rows.insert(id.into(), row.clone());
        row
    }

    pub fn set_enabled(&mut self, id: &str, kind: Kind, on: bool, now: i64) -> StateRow {
        let on_at = self.next_on(now);
        let row = self.rows.entry(id.into()).or_insert_with(|| StateRow { id: id.into(), kind, enabled: false, source: Some(Source { at: now, ..Source::of("local") }), at: now, on_at: 0 });
        if on && !row.enabled {
            row.on_at = on_at;
        }
        row.enabled = on;
        row.clone()
    }

    pub fn remove(&mut self, id: &str) {
        self.rows.remove(id);
        self.hooks.retain(|(p, _), _| p != id);
    }

    pub fn hook_count(&self, plugin: &str, hook: &str, session: &str) -> u32 {
        self.hooks.get(&(plugin.into(), hook.into())).and_then(|l| l.iter().find(|(s, _)| s == session)).map_or(0, |(_, n)| *n)
    }

    /// One more run of a hook on a task; only the newest HOOK_SESSIONS tasks are kept per hook.
    pub fn count_hook(&mut self, plugin: &str, hook: &str, session: &str) -> u32 {
        let l = self.hooks.entry((plugin.into(), hook.into())).or_default();
        let n = if let Some(e) = l.iter_mut().find(|(s, _)| s == session) {
            e.1 += 1;
            e.1
        } else {
            l.push((session.into(), 1));
            1
        };
        if l.len() > HOOK_SESSIONS {
            let drop = l.len() - HOOK_SESSIONS;
            l.drain(..drop);
        }
        n
    }

    /// v1's spells.json, read into rows: every id it names is a spell row (on in its list's order).
    pub fn from_v1(raw: &Value, now: i64) -> Self {
        let enabled: Vec<&str> = raw.get("enabled").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let sources = raw.get("sources").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut t = Self::default();
        let mut ids: Vec<&str> = enabled.clone();
        ids.extend(sources.keys().map(String::as_str).filter(|k| !enabled.contains(k)));
        for id in ids {
            let source: Option<Source> = sources.get(id).and_then(|s| serde_json::from_value(s.clone()).ok());
            let pos = enabled.iter().position(|e| *e == id);
            let at = source.as_ref().map_or(now, |s| s.at);
            let on_at = pos.map_or(0, |p| i64::try_from(p).unwrap_or(0) + 1);
            t.rows.insert(id.into(), StateRow { id: id.into(), kind: Kind::Spell, enabled: pos.is_some(), source, at, on_at });
        }
        for (plugin, by_hook) in raw.get("hooks").and_then(Value::as_object).into_iter().flatten() {
            for (hook, by_session) in by_hook.as_object().into_iter().flatten() {
                let list = by_session.as_object().into_iter().flatten().map(|(s, n)| (s.clone(), n.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0))).collect();
                t.hooks.insert((plugin.clone(), hook.clone()), list);
            }
        }
        t
    }

    /// The downgrade path: spells.json as v1 reads it (spell rows only).
    pub fn to_v1(&self) -> Value {
        let enabled: Vec<&str> = self.enabled().into_iter().filter(|r| r.kind == Kind::Spell).map(|r| r.id.as_str()).collect();
        let sources: Map<String, Value> =
            self.rows.values().filter(|r| r.kind == Kind::Spell).filter_map(|r| Some((r.id.clone(), serde_json::to_value(r.source.as_ref()?).ok()?))).collect();
        let mut hooks = Map::new();
        for ((plugin, hook), list) in &self.hooks {
            let p = hooks.entry(plugin.clone()).or_insert_with(|| json!({}));
            p[hook] = Value::Object(list.iter().map(|(s, n)| (s.clone(), json!(n))).collect());
        }
        json!({ "enabled": enabled, "sources": sources, "hooks": hooks })
    }

    /// The rows that aren't spells (folders, built-ins the user switched), for the plugins' own file.
    pub fn plugin_rows(&self) -> Vec<&StateRow> {
        self.rows.values().filter(|r| r.kind == Kind::Plugin).collect()
    }
}
