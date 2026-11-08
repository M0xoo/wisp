//! The settings registry (plan §3.1 rule 8: one config system). Settings are declared in manifests,
//! typed and validated. Another plugin may set an overridable one through `contributes.setSettings`,
//! which locks it (`lockedBy`) while that plugin is on. A read answers the lock first, then the value,
//! then the default. Server settings are saved through the store's `SettingsBackend`; device settings
//! stay on this client. Watchers belong to the watching plugin and go when it goes off.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::manifest::SettingDecl;
use crate::{Result, WireError};

/// Where setting values live between runs. The store provides one as a kernel service
/// (`Arc<dyn SettingsBackend>`); without it values are kept in memory only.
pub trait SettingsBackend: Send + Sync + 'static {
    /// values saved before, both scopes
    fn load(&self) -> Vec<(String, Value)>;
    /// `None` resets the key to its default. Must not block: queue the write.
    fn save(&self, key: &str, value: Option<&Value>, device: bool);
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingInfo {
    pub key: String,
    pub owner: String,
    pub decl: SettingDecl,
    /// 'server' | 'device'
    pub scope: String,
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_by: Option<String>,
}

type Watcher = Arc<dyn Fn(Option<Value>) + Send + Sync>;

#[derive(Default)]
struct Inner {
    decls: HashMap<String, (String, SettingDecl)>,
    values: HashMap<String, Value>,
    locks: HashMap<String, (String, Value)>,
    watchers: HashMap<String, Vec<(String, u64, Watcher)>>,
    next: u64,
    loaded: bool,
}

impl Inner {
    fn get(&self, key: &str) -> Option<Value> {
        if let Some((_, v)) = self.locks.get(key) {
            return Some(v.clone());
        }
        self.values
            .get(key)
            .cloned()
            .or_else(|| self.decls.get(key).and_then(|(_, d)| d.default.clone()))
    }
    fn fire(&self, key: &str) -> Vec<(Watcher, Option<Value>)> {
        let v = self.get(key);
        self.watchers
            .get(key)
            .map(|ws| ws.iter().map(|(_, _, f)| (f.clone(), v.clone())).collect())
            .unwrap_or_default()
    }
}

#[derive(Default)]
pub(crate) struct Settings {
    inner: Mutex<Inner>,
}

fn call_all(fired: Vec<(Watcher, Option<Value>)>) {
    for (f, v) in fired {
        f(v);
    }
}

impl Settings {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| WireError::internal("settings lock poisoned"))
    }

    pub(crate) fn load(&self, backend: Option<&dyn SettingsBackend>) {
        let Ok(mut i) = self.lock() else { return };
        if i.loaded {
            return;
        }
        i.loaded = true;
        if let Some(b) = backend {
            i.values.extend(b.load());
        }
    }

    /// Declares `owner`'s settings. A key another plugin already declared is refused.
    pub(crate) fn declare(&self, owner: &str, decls: Vec<SettingDecl>) -> Result<()> {
        let mut i = self.lock()?;
        for d in &decls {
            if let Some((o, _)) = i.decls.get(&d.key).filter(|(o, _)| o != owner) {
                return Err(WireError::conflict(format!(
                    "{} is already declared by {o}",
                    d.key
                )));
            }
        }
        for d in decls {
            i.decls.insert(d.key.clone(), (owner.to_owned(), d));
        }
        Ok(())
    }

    pub(crate) fn undeclare(&self, owner: &str) {
        if let Ok(mut i) = self.lock() {
            i.decls.retain(|_, (o, _)| o != owner);
        }
    }

    /// Sets and locks another plugin's overridable setting.
    pub(crate) fn lock_by(&self, by: &str, key: &str, value: Value) -> Result<()> {
        let fired = {
            let mut i = self.lock()?;
            let Some((owner, decl)) = i.decls.get(key) else {
                return Err(WireError::not_found(format!(
                    "{by} sets {key}, which no plugin declares"
                )));
            };
            if !decl.overridable {
                return Err(WireError::forbidden(format!(
                    "{by} can't set {key}: {owner} doesn't let other plugins set it"
                )));
            }
            if let Some(why) = decl.problem(&value) {
                return Err(WireError::invalid(format!("{by} sets {key}: {why}")));
            }
            if let Some((held, v)) = i.locks.get(key) {
                if held == by && *v == value {
                    return Ok(());
                }
                if held != by {
                    return Err(WireError::conflict(format!("{key} is locked by {held}")));
                }
            }
            let before = i.get(key);
            i.locks.insert(key.to_owned(), (by.to_owned(), value));
            if before == i.get(key) {
                Vec::new()
            } else {
                i.fire(key)
            }
        };
        call_all(fired);
        Ok(())
    }

    /// Releases every lock `by` holds, and drops the watchers it registered.
    pub(crate) fn release(&self, by: &str) {
        let fired = {
            let Ok(mut i) = self.lock() else { return };
            for ws in i.watchers.values_mut() {
                ws.retain(|(o, _, _)| o != by);
            }
            i.watchers.retain(|_, ws| !ws.is_empty());
            let keys: Vec<String> = i
                .locks
                .iter()
                .filter(|(_, (o, _))| o == by)
                .map(|(k, _)| k.clone())
                .collect();
            let mut fired = Vec::new();
            for k in keys {
                let before = i.get(&k);
                i.locks.remove(&k);
                if before != i.get(&k) {
                    fired.extend(i.fire(&k));
                }
            }
            fired
        };
        call_all(fired);
    }

    pub(crate) fn get(&self, key: &str) -> Option<Value> {
        self.lock().ok()?.get(key)
    }

    /// The user's (or a command's) write. `None` resets it to the default.
    #[allow(clippy::needless_pass_by_value)] // the caller gives the value up
    pub(crate) fn set(
        &self,
        key: &str,
        value: Option<Value>,
        backend: Option<&dyn SettingsBackend>,
    ) -> Result<()> {
        let (fired, device) = {
            let mut i = self.lock()?;
            let Some((_, decl)) = i.decls.get(key) else {
                return Err(WireError::not_found(format!(
                    "no plugin declares the setting {key}"
                )));
            };
            if let Some((by, _)) = i.locks.get(key) {
                return Err(WireError::conflict(format!("{key} is locked by {by}")));
            }
            if let Some(why) = value.as_ref().and_then(|v| decl.problem(v)) {
                return Err(WireError::invalid(format!("{key} {why}")));
            }
            let device = decl.device();
            let before = i.get(key);
            match &value {
                Some(v) => i.values.insert(key.to_owned(), v.clone()),
                None => i.values.remove(key),
            };
            (
                if before == i.get(key) {
                    Vec::new()
                } else {
                    i.fire(key)
                },
                device,
            )
        };
        if let Some(b) = backend {
            b.save(key, value.as_ref(), device);
        }
        call_all(fired);
        Ok(())
    }

    pub(crate) fn watch(&self, owner: &str, key: &str, f: Watcher) -> u64 {
        let Ok(mut i) = self.lock() else { return 0 };
        i.next += 1;
        let id = i.next;
        i.watchers
            .entry(key.to_owned())
            .or_default()
            .push((owner.to_owned(), id, f));
        id
    }

    pub(crate) fn watchers_of(&self, owner: &str) -> usize {
        self.lock().map_or(0, |i| {
            i.watchers
                .values()
                .map(|ws| ws.iter().filter(|(o, _, _)| o == owner).count())
                .sum()
        })
    }

    pub(crate) fn info(&self, key: &str) -> Option<SettingInfo> {
        let i = self.lock().ok()?;
        let (owner, decl) = i.decls.get(key)?;
        Some(SettingInfo {
            key: key.to_owned(),
            owner: owner.clone(),
            decl: decl.clone(),
            scope: if decl.device() { "device" } else { "server" }.to_owned(),
            value: i.get(key),
            locked_by: i.locks.get(key).map(|(b, _)| b.clone()),
        })
    }

    pub(crate) fn list(&self) -> Vec<SettingInfo> {
        let mut keys: Vec<String> = self
            .lock()
            .map(|i| i.decls.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys.iter().filter_map(|k| self.info(k)).collect()
    }
}
